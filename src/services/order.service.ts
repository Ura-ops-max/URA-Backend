import mongoose from 'mongoose';
import Order, { OrderStatus } from '@/models/order-model';
import Cart from '@/models/cart-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { trackEvent } from '@/services/track-event.service';
import { createPaylukCustomer } from '@/services/payluk.service';
import {
  createDeliveryOrder,
  isFezConfigured,
  getDeliveryCost,
  type CreateDeliveryInput,
} from '@/services/fez.service';
import { notifyOrderEvent } from '@/services/order-events.service';
import {
  unavailableMessage,
  holdItems,
  releaseItems,
  releaseUnpaidHolds,
  holdExpiry,
} from '@/services/stock-hold.service';

export interface ShippingAddress {
  fullAddress: string;
  city: string;
  /** Destination state — what the Fez delivery quote is priced on. */
  state?: string;
  phone: string;
}

export type PaymentType = 'normal' | 'protected';

export interface CheckoutResult {
  order: {
    _id: unknown;
    orderNumber: string;
    totalAmount: number;
    status: string;
    paymentType: PaymentType;
  };
}

/** Payluk's minimum escrow amount (docs: Create escrow). */
export const MIN_ORDER_AMOUNT = 1000;

export async function checkoutFromCart(
  userId: string,
  shippingAddress: ShippingAddress,
  paymentMethod = 'card',
  ip?: string,
  userAgent?: string,
  delivery?: {
    deliveryFee?: number;
    deliveryMethod?: 'delivery' | 'pickup';
    paymentType?: PaymentType;
  }
): Promise<CheckoutResult> {
  // Shipping is only charged on the delivery option. The fee is priced by the
  // server with Fez below (never trusted from the browser).
  let deliveryFee = 0;
  const deliveryMethod = delivery?.deliveryMethod === 'delivery' ? 'delivery' : 'pickup';
  // normal: released to the seller as soon as it's paid; seller pays Payluk's fee.
  // protected: held until the buyer confirms; fee per the product's setting.
  const paymentType: PaymentType = delivery?.paymentType === 'normal' ? 'normal' : 'protected';
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
    cart.items.map((i: any) => String(i.product?.business ?? '')).filter(Boolean)
  );
  if (shopIds.size > 1) {
    const err: any = new Error(
      'Your cart has items from more than one shop. Please check out one shop at a time (remove the other items for now).'
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
    if (p.isHidden) {
      const err: any = new Error(
        `"${p.name}" is no longer available. Please remove it from your cart.`
      );
      err.status = 400;
      throw err;
    }
    if (p.stock < item.quantity) {
      const err: any = new Error(await unavailableMessage(p._id, p.name, p.stock));
      err.code = 'STOCK_UNAVAILABLE';
      err.status = 400;
      throw err;
    }
    orderItems.push({
      product: p._id,
      name: p.name,
      price: p.price,
      quantity: item.quantity,
      image: p.media?.[0] ?? null,
    });
    totalAmount += p.price * item.quantity;
  }

  const firstProduct: any = cart.items[0].product;

  // Every Payluk payment is an escrow, and an escrow must be at least ₦1,000.
  if (totalAmount < MIN_ORDER_AMOUNT) {
    const err: any = new Error(
      `The minimum order is ₦${MIN_ORDER_AMOUNT.toLocaleString('en-NG')}. Please add more items.`
    );
    err.code = 'MIN_ORDER_AMOUNT';
    err.status = 400;
    throw err;
  }

  // Price delivery on the server with Fez — never trust a fee from the browser.
  if (deliveryMethod === 'delivery') {
    if (!shippingAddress.state) {
      const err: any = new Error('Your delivery state is required.');
      err.status = 400;
      throw err;
    }
    if (!isFezConfigured()) {
      const err: any = new Error('Delivery is not available right now.');
      err.status = 503;
      throw err;
    }
    const sellerBiz = await Business.findById(firstProduct?.business).select('address').lean();
    const pickUpState = (sellerBiz as any)?.address?.state as string | undefined;
    try {
      const quote = await getDeliveryCost({
        state: shippingAddress.state,
        ...(pickUpState ? { pickUpState } : {}),
      });
      deliveryFee = Math.max(0, Math.round(Number(quote.totalCost) || 0));
    } catch (e: any) {
      const err: any = new Error(
        e?.message || `Delivery to ${shippingAddress.state} isn't available right now.`
      );
      err.status = 422;
      throw err;
    }
  }

  // ── Fees ─────────────────────────────────────────────────────────────────
  // The escrow (created when the buyer pays, see payment.service) holds ONLY the
  // goods: that is the seller's payout. Delivery + URA's platform charge go in
  // the escrow's additionalFee, which Payluk pays to URA's merchant wallet.
  const platformFeePct = Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT) || 0);
  const platformFee = Math.round((totalAmount * platformFeePct) / 100);
  const grandTotal = totalAmount + deliveryFee + platformFee; // excl. Payluk's own fee

  // The seller needs a Payluk customer id to receive the money. If they never
  // onboarded, create one now so they don't block the buyer.
  const sellerBusiness = await Business.findById(firstProduct.business).lean();
  const seller = sellerBusiness ? await User.findById((sellerBusiness as any).owner) : null;
  if (!seller) {
    const err: any = new Error('This product is not available for purchase yet.');
    err.code = 'PRODUCT_NOT_AVAILABLE';
    err.status = 422;
    throw err;
  }
  if (!seller.paylukCustomerId) {
    try {
      const created = await createPaylukCustomer({
        firstName: seller.firstName || (sellerBusiness as any)?.businessName || 'Seller',
        lastName: seller.lastName || 'Merchant',
        email: seller.email,
        phone: (seller as any).phone,
      });
      await User.updateOne({ _id: seller._id }, { $set: { paylukCustomerId: created.customerId } });
      console.log(`✅ [checkout] created Payluk customer for seller ${seller._id}`);
    } catch (e) {
      console.error('[checkout] seller Payluk customer creation failed:', (e as Error).message);
      const err: any = new Error('This product is not available for purchase yet.');
      err.code = 'PRODUCT_NOT_AVAILABLE';
      err.status = 422;
      throw err;
    }
  }

  // A buyer retrying checkout shouldn't hold the same stock twice: release any
  // hold from their earlier unpaid attempts first.
  await releaseUnpaidHolds({ user: userId });

  // Take the stock off the shelf now, so two buyers can't pay for the last one.
  await holdItems(orderItems);
  try {
    const order = await Order.create({
      user: userId,
      business: firstProduct.business,
      orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}`,
      items: orderItems,
      // Items + delivery + platform charge (Payluk's own fee is added at payment).
      totalAmount: grandTotal,
      itemsTotal: totalAmount,
      deliveryFee,
      deliveryFeeCharged: deliveryFee,
      // URA pays Fez from its own account; the quote is what we expect to pay.
      ...(deliveryMethod === 'delivery' ? { fezCost: deliveryFee } : {}),
      platformFee,
      deliveryMethod,
      shippingAddress,
      paymentMethod,
      paymentType,
      status: 'pending',
      paymentStatus: 'pending',
      payment: { provider: 'payluk' },
      stockReserved: true,
      reservedUntil: holdExpiry(),
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
      order: {
        _id: order._id,
        orderNumber: order.orderNumber,
        totalAmount: order.totalAmount,
        status: order.status,
        paymentType,
      },
    };
  } catch (e) {
    await releaseItems(orderItems).catch(() => {});
    throw e;
  }
}

export const getOrdersForUser = (userId: string) =>
  Order.find({ user: userId })
    .sort({ createdAt: -1 })
    .populate('items.product', 'name media price');

/** Businesses owned by this user (a seller can own more than one). */
const businessIdsOwnedBy = async (userId: string) =>
  (await Business.find({ owner: userId }).select('_id').lean()).map((b: any) => String(b._id));

/** Buyer OR the selling business's owner may view an order. */
export const getOrderByIdForUser = async (orderId: string, userId: string) => {
  if (!mongoose.isValidObjectId(orderId)) {
    const e: any = new Error('Order not found');
    e.status = 404;
    throw e;
  }
  const order = await Order.findById(orderId)
    .populate('items.product', 'name media price')
    .populate('business', 'businessName slug businessLogo address contact')
    .populate('user', 'firstName lastName email');
  if (!order) {
    const e: any = new Error('Order not found');
    e.status = 404;
    throw e;
  }
  const buyerId = String((order.user as any)?._id ?? order.user);
  const isBuyer = buyerId === userId;
  const isSeller = (await businessIdsOwnedBy(userId)).includes(
    String((order.business as any)?._id ?? order.business)
  );
  if (!isBuyer && !isSeller) {
    const e: any = new Error('Unauthorized');
    e.status = 403;
    throw e;
  }
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
  mode?: 'pickup' | 'self_delivery'
) => {
  if (!mongoose.isValidObjectId(orderId)) {
    const e: any = new Error('Order not found');
    e.status = 404;
    throw e;
  }
  const order = await Order.findById(orderId);
  if (!order) {
    const e: any = new Error('Order not found');
    e.status = 404;
    throw e;
  }
  if (!(await businessIdsOwnedBy(userId)).includes(String(order.business))) {
    const e: any = new Error('Only the seller can update this order');
    e.status = 403;
    throw e;
  }
  if (order.paymentStatus !== 'paid') {
    const e: any = new Error('This order has not been paid yet');
    e.status = 400;
    throw e;
  }
  if (order.disputeStatus === 'open' || order.disputeStatus === 'investigating') {
    const e: any = new Error('This order has an open dispute. Please wait for it to be resolved.');
    e.status = 409;
    throw e;
  }
  if (order.status !== OrderStatus.PROCESSING) {
    const e: any = new Error(`This order is already ${order.status}`);
    e.status = 409;
    throw e;
  }

  if (order.deliveryMethod === 'delivery') {
    if (!isFezConfigured()) {
      const e: any = new Error(
        'Delivery booking is not set up yet. Please arrange delivery yourself.'
      );
      e.status = 503;
      throw e;
    }
    const [buyer, business] = await Promise.all([
      User.findById(order.user).select('firstName lastName email'),
      Business.findById(order.business).select('businessName address'),
    ]);
    const subtotal = order.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    try {
      const delivery: CreateDeliveryInput = {
        uniqueID: order.orderNumber,
        recipientName:
          `${buyer?.firstName ?? ''} ${buyer?.lastName ?? ''}`.trim() || 'URA customer',
        recipientPhone: order.shippingAddress.phone,
        recipientAddress: [order.shippingAddress.fullAddress, order.shippingAddress.city]
          .filter(Boolean)
          .join(', '),
        recipientState: order.shippingAddress.state || business?.address?.state || 'FCT',
        valueOfItem: subtotal,
        itemDescription: order.items
          .map(i => `${i.name} x${i.quantity}`)
          .join(', ')
          .slice(0, 200),
      };
      if (buyer?.email) delivery.recipientEmail = buyer.email;
      if (business?.address?.state) delivery.pickUpState = business.address.state;
      if (business?.address?.fullAddress) delivery.pickUpAddress = business.address.fullAddress;
      const { trackingNo } = await createDeliveryOrder(delivery);
      if (trackingNo) order.trackingNumber = trackingNo;
      order.fulfilment = 'fez';
      // The delivery cost is now spent: record it so a later dispute ruling
      // can keep the delivery fee with URA (additionalFeeRefundable = false).
      order.riderBookedAt = new Date();
    } catch (err) {
      console.error('[markOrderReady] Fez booking failed:', (err as Error).message);
      notifyOrderEvent(order, 'DELIVERY_BOOKING_FAILED').catch(() => {});
      const e: any = new Error(
        'Could not book a delivery rider right now. Please try again shortly.'
      );
      e.status = 502;
      throw e;
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
