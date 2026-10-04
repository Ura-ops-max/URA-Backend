import mongoose from 'mongoose';
import Order, { OrderStatus } from '@/models/order-model';
import Cart from '@/models/cart-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { trackEvent } from '@/services/track-event.service';
import { createPaymentLink, createPaylukCustomer, updateAdditionalFee, verifyPaymentToken } from '@/services/payluk.service';
import { createDeliveryOrder, isFezConfigured, type CreateDeliveryInput } from '@/services/fez.service';
import { markOrderPaid, notifyOrderEvent, isPaidStatus } from '@/services/order-events.service';

export interface ShippingAddress {
  fullAddress: string;
  city: string;
  /** Destination state — what the Fez delivery quote is priced on. */
  state?: string;
  phone: string;
}

export interface CheckoutResult {
  order: { _id: unknown; orderNumber: string; totalAmount: number; status: string };
  payluk: { paymentToken: string; escrowId: string | null; customerId: string; fee: number; payableAmount: number };
}

export async function checkoutFromCart(
  userId: string,
  shippingAddress: ShippingAddress,
  paymentMethod = 'card',
  ip?: string,
  userAgent?: string,
  delivery?: { deliveryFee?: number; deliveryMethod?: 'delivery' | 'pickup'; escrowMode?: 'escrow' | 'normal' },
): Promise<CheckoutResult> {
  // Shipping is only charged on the delivery option; direct payment sends 0.
  const deliveryFee = Math.max(0, Number(delivery?.deliveryFee) || 0);
  const deliveryMethod = delivery?.deliveryMethod === 'delivery' ? 'delivery' : 'pickup';
  // 'normal' → seller absorbs Payluk's fee (buyer pays clean price, Paystack-style).
  // 'escrow' → buyer pays the fee for the held/protected payment.
  const escrowMode = delivery?.escrowMode === 'normal' ? 'normal' : 'escrow';
  const buyer = await User.findById(userId);
  if (!buyer?.paylukCustomerId) {
    const err: any = new Error('Payment profile required');
    err.code = 'PAYLUK_PROFILE_REQUIRED';
    err.status = 422;
    throw err;
  }

  const cart = await Cart.findOne({ user: userId }).populate('items.product');
  if (!cart || cart.items.length === 0) {
    const err: any = new Error('Cart is empty');
    err.status = 400;
    throw err;
  }

  // One order = one seller's escrow. A mixed cart would send every shop's money
  // to the first shop, so ask the buyer to check out one shop at a time.
  const shopIds = new Set(
    cart.items.map((i: any) => String(i.product?.business ?? '')).filter(Boolean),
  );
  if (shopIds.size > 1) {
    const err: any = new Error(
      'Your cart has items from more than one shop. Please check out one shop at a time (remove the other items for now).',
    );
    err.code = 'MIXED_SELLERS';
    err.status = 400;
    throw err;
  }

  let totalAmount = 0;
  const orderItems = [];

  for (const item of cart.items) {
    const p: any = item.product;
    if (!p) continue;
    if (p.stock < item.quantity) {
      const err: any = new Error(`"${p.name}" only has ${p.stock} unit(s) left in stock`);
      err.status = 400;
      throw err;
    }
    orderItems.push({ product: p._id, name: p.name, price: p.price, quantity: item.quantity, image: p.media?.[0] ?? null });
    totalAmount += p.price * item.quantity;
  }

  const firstProduct: any = cart.items[0].product;

  // ── Fee split ────────────────────────────────────────────────────────────
  // The escrow holds ONLY the goods subtotal — that is the seller's payout.
  // Delivery + the platform's cut are added on top as a Payluk "additional fee"
  // that Payluk credits straight to OUR platform wallet (no cut taken, not part
  // of the escrow), so the seller never receives them.
  const platformFeePct = Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT) || 0);
  const platformFee = Math.round((totalAmount * platformFeePct) / 100);
  const additionalFee = deliveryFee + platformFee; // → platform wallet
  const grandTotal = totalAmount + deliveryFee + platformFee; // order value (excl. Payluk processing fee)

  // Find the seller (product's business owner). They need a Payluk customer id
  // to receive escrow funds. If they never onboarded, auto-create one on the fly
  // so an un-onboarded seller doesn't block the buyer from checking out.
  const sellerBusiness = await Business.findById(firstProduct.business).lean();
  const seller = sellerBusiness
    ? await User.findById((sellerBusiness as any).owner)
    : null;

  if (!seller) {
    const err: any = new Error('This product is not available for purchase yet.');
    err.code = 'PRODUCT_NOT_AVAILABLE';
    err.status = 422;
    throw err;
  }

  let sellerCustomerId = seller.paylukCustomerId;
  if (!sellerCustomerId) {
    try {
      const created = await createPaylukCustomer({
        firstName: seller.firstName || (sellerBusiness as any)?.businessName || 'Seller',
        lastName: seller.lastName || 'Merchant',
        email: seller.email,
        phone: (seller as any).phone,
      });
      sellerCustomerId = created.customerId;
      await User.updateOne({ _id: seller._id }, { $set: { paylukCustomerId: sellerCustomerId } });
      console.log(`✅ [checkout] auto-created Payluk customer for seller ${seller._id}`);
    } catch (e) {
      console.error('[checkout] seller Payluk customer creation failed:', (e as Error).message);
      const err: any = new Error('This product is not available for purchase yet.');
      err.code = 'PRODUCT_NOT_AVAILABLE';
      err.status = 422;
      throw err;
    }
  }

  // Create a fresh escrow holding ONLY the goods subtotal (the seller's payout).
  const escrow = await createPaymentLink({
    amount:           totalAmount,
    purpose:          firstProduct.name,
    description:      firstProduct.description || firstProduct.name,
    // Normal payment: seller bears Payluk's fee → buyer pays the clean price.
    // Escrow: buyer bears it (the cost of protection).
    whoPays:          escrowMode === 'normal' ? 'seller' : (firstProduct.whoPays || 'buyer'),
    maxDelivery:      firstProduct.maxDelivery ?? 3,
    deliveryTimeline: firstProduct.deliveryTimeline || 'days',
    totalQuantity:    cart.items.reduce((sum: number, i: any) => sum + i.quantity, 0),
    imageUrl:         firstProduct.media?.[0] ?? null,
    customerId:       sellerCustomerId!,
  });

  const paylukPaymentToken = escrow.paymentToken;
  const paylukEscrowId     = escrow.escrowId;

  // Route delivery + platform cut to the platform wallet, kept out of escrow.
  // Abort if this fails so we never create an order that under-charges the buyer
  // or leaks the delivery fee into the seller's payout.
  if (additionalFee > 0) {
    try {
      await updateAdditionalFee(paylukPaymentToken, additionalFee);
    } catch (e) {
      console.error('[checkout] additional-fee setup failed:', (e as Error).message);
      const err: any = new Error('Could not set up payment. Please try again.');
      err.code = 'FEE_SETUP_FAILED';
      err.status = 502;
      throw err;
    }
  }

  // What the buyer is actually charged.
  // - normal: goods + delivery/platform only (seller absorbs Payluk's fee → no add-on).
  // - escrow: goods + Payluk's fee share + delivery/platform.
  const buyerPayable =
    escrowMode === 'normal'
      ? totalAmount + additionalFee
      : (escrow.payableAmount ?? totalAmount + escrow.fee) + additionalFee;

  const order = await Order.create({
    user: userId,
    business: firstProduct.business,
    orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}`,
    items: orderItems,
    // totalAmount is what the buyer is charged (items + shipping).
    totalAmount: grandTotal,
    deliveryFee,
    deliveryMethod,
    shippingAddress,
    paymentMethod,
    status: 'pending',
    paymentStatus: 'pending',
    paylukPaymentToken,
    paylukEscrowId,
    payment: { provider: 'payluk' },
  });

  trackEvent({
    targetId: (order._id as any).toString(),
    targetModel: 'Order',
    type: 'ACTIVITY',
    activityData: {
      action: 'ORDER_PLACED',
      description: `Order ${order.orderNumber} placed — NGN ${grandTotal}`,
      metadata: { ip, userAgent },
    },
  }).catch(() => {});

  return {
    order: { _id: order._id, orderNumber: order.orderNumber, totalAmount: order.totalAmount, status: order.status },
    payluk: {
      paymentToken: paylukPaymentToken,
      escrowId: paylukEscrowId,
      customerId: buyer.paylukCustomerId!,
      fee: escrow.fee,
      // Buyer's real charge: goods + Payluk fee + delivery + platform cut.
      payableAmount: buyerPayable,
    },
  };
}

/**
 * Buyer returns from Payluk. We ASK PAYLUK whether the money actually arrived
 * before marking the order paid — the paymentId in the URL alone proves nothing.
 * If Payluk hasn't confirmed yet, we report "pending"; the Payluk webhook will
 * finish the job and notify everyone when the money lands.
 */
export async function confirmPayment(
  userId: string,
  paymentId: string,
): Promise<{ alreadyConfirmed: boolean; pending?: boolean; order: Record<string, unknown> }> {
  const pending = await Order.findOne({ user: userId, paymentStatus: 'pending' }).sort({ createdAt: -1 });

  if (!pending) {
    const paid = await Order.findOne({ user: userId, paymentStatus: 'paid' }).sort({ createdAt: -1 });
    if (paid) {
      return {
        alreadyConfirmed: true,
        order: { _id: paid._id, orderNumber: paid.orderNumber, totalAmount: paid.totalAmount, status: paid.status, paymentStatus: paid.paymentStatus },
      };
    }
    const err: any = new Error('No pending order found');
    err.status = 404;
    throw err;
  }

  let verified = false;
  try {
    if (pending.paylukPaymentToken) {
      const result = await verifyPaymentToken(pending.paylukPaymentToken);
      verified = isPaidStatus(result.status);
      if (!verified) console.warn(`[confirmPayment] Payluk status "${result.status}" for ${pending.orderNumber} — not paid yet`);
    }
  } catch (e) {
    console.error('[confirmPayment] Payluk verify failed:', (e as Error).message);
  }

  if (!verified) {
    return {
      alreadyConfirmed: false,
      pending: true,
      order: { _id: pending._id, orderNumber: pending.orderNumber, totalAmount: pending.totalAmount, status: pending.status, paymentStatus: pending.paymentStatus },
    };
  }

  const updated = (await markOrderPaid(pending._id, paymentId)) ?? (await Order.findById(pending._id));
  return {
    alreadyConfirmed: false,
    order: { _id: updated!._id, orderNumber: updated!.orderNumber, totalAmount: updated!.totalAmount, status: updated!.status, paymentStatus: updated!.paymentStatus },
  };
}

export const getOrdersForUser = (userId: string) =>
  Order.find({ user: userId }).sort({ createdAt: -1 }).populate('items.product', 'name media price');

/** Businesses owned by this user (a seller can own more than one). */
const businessIdsOwnedBy = async (userId: string) =>
  (await Business.find({ owner: userId }).select('_id').lean()).map((b: any) => String(b._id));

/** Buyer OR the selling business's owner may view an order. */
export const getOrderByIdForUser = async (orderId: string, userId: string) => {
  if (!mongoose.isValidObjectId(orderId)) { const e: any = new Error('Order not found'); e.status = 404; throw e; }
  const order = await Order.findById(orderId)
    .populate('items.product', 'name media price')
    .populate('business', 'businessName slug businessLogo address contact')
    .populate('user', 'firstName lastName email');
  if (!order) { const e: any = new Error('Order not found'); e.status = 404; throw e; }
  const buyerId = String((order.user as any)?._id ?? order.user);
  const isBuyer = buyerId === userId;
  const isSeller = (await businessIdsOwnedBy(userId)).includes(String((order.business as any)?._id ?? order.business));
  if (!isBuyer && !isSeller) { const e: any = new Error('Unauthorized'); e.status = 403; throw e; }
  return { order, role: isBuyer ? 'buyer' : 'seller' };
};

/** Paid orders that customers placed with this seller's business(es). */
export const getReceivedOrdersForSeller = async (userId: string) => {
  const ids = await businessIdsOwnedBy(userId);
  if (!ids.length) return [];
  return Order.find({ business: { $in: ids }, paymentStatus: 'paid' })
    .sort({ paidAt: -1, createdAt: -1 })
    .populate('user', 'firstName lastName')
    .populate('business', 'businessName slug');
};

/**
 * Seller says the order is ready.
 *  - delivery orders: book a Fez rider (pickup from the shop → buyer) and save the tracking number
 *  - pickup orders:   tell the buyer it's ready to collect, OR (mode = 'self_delivery')
 *                     the shop brings it to the buyer itself
 */
export const markOrderReady = async (
  orderId: string,
  userId: string,
  mode?: 'pickup' | 'self_delivery',
) => {
  if (!mongoose.isValidObjectId(orderId)) { const e: any = new Error('Order not found'); e.status = 404; throw e; }
  const order = await Order.findById(orderId);
  if (!order) { const e: any = new Error('Order not found'); e.status = 404; throw e; }
  if (!(await businessIdsOwnedBy(userId)).includes(String(order.business))) {
    const e: any = new Error('Only the seller can update this order'); e.status = 403; throw e;
  }
  if (order.paymentStatus !== 'paid') { const e: any = new Error('This order has not been paid yet'); e.status = 400; throw e; }
  if (order.status !== OrderStatus.PROCESSING) {
    const e: any = new Error(`This order is already ${order.status}`); e.status = 409; throw e;
  }

  if (order.deliveryMethod === 'delivery') {
    if (!isFezConfigured()) {
      const e: any = new Error('Delivery booking is not set up yet. Please arrange delivery yourself.');
      e.status = 503; throw e;
    }
    const [buyer, business] = await Promise.all([
      User.findById(order.user).select('firstName lastName email'),
      Business.findById(order.business).select('businessName address'),
    ]);
    const subtotal = order.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    try {
      const delivery: CreateDeliveryInput = {
        uniqueID: order.orderNumber,
        recipientName: `${buyer?.firstName ?? ''} ${buyer?.lastName ?? ''}`.trim() || 'URA customer',
        recipientPhone: order.shippingAddress.phone,
        recipientAddress: [order.shippingAddress.fullAddress, order.shippingAddress.city].filter(Boolean).join(', '),
        recipientState: order.shippingAddress.state || business?.address?.state || 'FCT',
        valueOfItem: subtotal,
        itemDescription: order.items.map((i) => `${i.name} x${i.quantity}`).join(', ').slice(0, 200),
      };
      if (buyer?.email) delivery.recipientEmail = buyer.email;
      if (business?.address?.state) delivery.pickUpState = business.address.state;
      if (business?.address?.fullAddress) delivery.pickUpAddress = business.address.fullAddress;
      const { trackingNo } = await createDeliveryOrder(delivery);
      if (trackingNo) order.trackingNumber = trackingNo;
      order.fulfilment = 'fez';
    } catch (err) {
      console.error('[markOrderReady] Fez booking failed:', (err as Error).message);
      notifyOrderEvent(order, 'DELIVERY_BOOKING_FAILED').catch(() => {});
      const e: any = new Error('Could not book a delivery rider right now. Please try again shortly.');
      e.status = 502; throw e;
    }
    order.status = OrderStatus.SHIPPED;
    await order.save();
    notifyOrderEvent(order, 'SHIPPED').catch(() => {});
  } else if (mode === 'self_delivery') {
    order.status = OrderStatus.SHIPPED; // shown as "On the way (by the shop)"
    order.fulfilment = 'seller_delivery';
    await order.save();
    notifyOrderEvent(order, 'SELLER_DELIVERING').catch(() => {});
  } else {
    order.status = OrderStatus.SHIPPED; // shown to people as "Ready for pickup"
    order.fulfilment = 'pickup';
    await order.save();
    notifyOrderEvent(order, 'READY_FOR_PICKUP').catch(() => {});
  }
  return order;
};
