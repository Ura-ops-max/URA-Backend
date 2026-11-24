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
  type CreateDeliveryInput,
} from '@/services/fez.service';
import {
  createChowdeckDelivery,
  getChowdeckBooking,
  getChowdeckQuote,
  isChowdeckConfigured,
  ChowdeckError,
} from '@/services/chowdeck.service';
import {
  anyCourierConfigured,
  dropoffPlace,
  generateDeliveryPin,
  quoteDelivery,
  shopPlace,
  type CourierProvider,
} from '@/services/courier.service';
import { notifyOrderEvent } from '@/services/order-events.service';
import {
  moneyNote,
  orderActions,
  presentOrderForList,
  type ViewerRole,
} from '@/services/order-view.service';
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
  latitude?: number;
  longitude?: number;
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
  let deliveryProvider: CourierProvider | undefined;
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

  // Price delivery on the server — never trust a fee from the browser.
  // Chowdeck for same-city routes it serves, otherwise Fez (courier.service).
  if (deliveryMethod === 'delivery') {
    if (!shippingAddress.state) {
      const err: any = new Error('Your delivery state is required.');
      err.status = 400;
      throw err;
    }
    if (!anyCourierConfigured()) {
      const err: any = new Error('Delivery is not available right now.');
      err.status = 503;
      throw err;
    }
    const sellerBiz = await Business.findById(firstProduct?.business)
      .select('address location')
      .lean();
    try {
      const quote = await quoteDelivery({
        shop: sellerBiz as any,
        dropoff: {
          state: shippingAddress.state,
          city: shippingAddress.city,
          fullAddress: shippingAddress.fullAddress,
          latitude: shippingAddress.latitude ?? null,
          longitude: shippingAddress.longitude ?? null,
        },
        orderValueNaira: totalAmount,
      });
      deliveryFee = Math.max(0, Math.round(Number(quote.totalCost) || 0));
      deliveryProvider = quote.provider;
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
      // URA pays the courier from its own account; the quote is what we expect to pay.
      ...(deliveryMethod === 'delivery' && deliveryProvider === 'chowdeck'
        ? { deliveryProvider, chowdeckCost: deliveryFee }
        : deliveryMethod === 'delivery'
          ? { deliveryProvider: 'fez', fezCost: deliveryFee }
          : {}),
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

/** My Orders: the buyer's own orders, with the shop name and their actions. */
export const getOrdersForUser = async (userId: string) => {
  const orders = await Order.find({ user: userId, status: { $ne: 'cancelled' } })
    .sort({ createdAt: -1 })
    // The shop's phone (already shown to the buyer on the order page) is used
    // for the "Message <shop>" WhatsApp button.
    .populate('business', 'businessName slug contact.phone')
    .lean();
  return orders.map(o => presentOrderForList(o, 'buyer'));
};

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
    // The seller sees the buyer's full name on their own order; never the email.
    .populate('user', 'firstName lastName');
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
  const role: ViewerRole = isBuyer ? 'buyer' : 'seller';
  // The delivery PIN is hidden from every query; only the buyer gets it.
  if (isBuyer) {
    const pin = await Order.findById(order._id).select('+deliveryPin deliveryPin').lean();
    if ((pin as any)?.deliveryPin) (order as any).deliveryPin = (pin as any).deliveryPin;
  }
  return { order, role, actions: orderActions(order, role), moneyNote: moneyNote(order, role) };
};

/** Paid orders that customers placed with this seller's business(es). */
export const getReceivedOrdersForSeller = async (userId: string) => {
  const ids = await businessIdsOwnedBy(userId);
  if (!ids.length) return [];
  const orders = await Order.find({ business: { $in: ids }, paymentStatus: 'paid' })
    .sort({ paidAt: -1, createdAt: -1 })
    .populate('user', 'firstName lastName')
    .populate('business', 'businessName slug')
    .lean();
  // Shop Orders list: "Amaka O.", no phone numbers (those are on the order page).
  return orders.map(o => presentOrderForList(o, 'seller'));
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

  if (order.deliveryMethod === 'delivery' && order.deliveryProvider === 'chowdeck') {
    await bookChowdeck(order);
    order.status = OrderStatus.SHIPPED;
    await order.save();
    notifyOrderEvent(order, 'SHIPPED').catch(() => {});
  } else if (order.deliveryMethod === 'delivery') {
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

/** Chowdeck's item_type: the first product's category, or "package". */
async function itemTypeFor(order: any): Promise<string> {
  const { Product } = await import('@/models/product-model');
  const p = await Product.findById(order.items?.[0]?.product).select('category').lean();
  return String((p as any)?.category || 'package').slice(0, 60);
}

/**
 * Book the Chowdeck rider for a ready order (docs/chowdeck-relay-integration.md 4.3):
 * re-quote (fee quotes expire), then create the delivery with reference =
 * orderNumber. A retry after a booking that already went through is safe:
 * Chowdeck rejects the duplicate reference and we load the existing booking.
 */
async function bookChowdeck(order: any): Promise<void> {
  if (!isChowdeckConfigured()) {
    const e: any = new Error(
      'Delivery booking is not set up yet. Please arrange delivery yourself.'
    );
    e.status = 503;
    throw e;
  }
  const [buyer, business] = await Promise.all([
    User.findById(order.user).select('firstName lastName email'),
    Business.findById(order.business).select('businessName address location contact'),
  ]);
  const subtotal = order.items.reduce((sum: number, i: any) => sum + i.price * i.quantity, 0);

  // One PIN per order, saved before calling Chowdeck, so a retry sends the
  // same PIN the rider already has.
  const withPin = await Order.findById(order._id).select('+deliveryPin').lean();
  let deliveryPin = (withPin as any)?.deliveryPin as number | undefined;
  if (!deliveryPin) {
    deliveryPin = generateDeliveryPin();
    await Order.updateOne({ _id: order._id }, { $set: { deliveryPin } });
  }

  const address = [
    order.shippingAddress?.fullAddress,
    order.shippingAddress?.city,
    order.shippingAddress?.state,
  ]
    .filter(Boolean)
    .join(', ');
  const itemsText = order.items.map((i: any) => `${i.name} x${i.quantity}`).join(', ');

  try {
    const quote = await getChowdeckQuote({
      pickup: shopPlace(business as any),
      dropoff: dropoffPlace({
        state: order.shippingAddress?.state || '',
        city: order.shippingAddress?.city,
        fullAddress: order.shippingAddress?.fullAddress,
        latitude: order.shippingAddress?.latitude ?? null,
        longitude: order.shippingAddress?.longitude ?? null,
      }),
      orderValueNaira: subtotal,
    });

    let booking;
    try {
      booking = await createChowdeckDelivery({
        feeId: quote.feeId,
        reference: order.orderNumber,
        itemType: await itemTypeFor(order),
        orderValueNaira: subtotal,
        sender: {
          name: business?.businessName || 'URA shop',
          phone: (business as any)?.contact?.phone || '',
        },
        recipient: {
          name: `${buyer?.firstName ?? ''} ${buyer?.lastName ?? ''}`.trim() || 'URA customer',
          phone: order.shippingAddress?.phone,
          ...(buyer?.email ? { email: buyer.email } : {}),
        },
        // TODO(chowdeck-q3): the create call takes no address; we assume the
        // fee quote's addresses are used, and send the address in the note too.
        note: `Deliver to: ${address}. Items: ${itemsText}`.slice(0, 500),
        deliveryPin,
      });
    } catch (err) {
      if (err instanceof ChowdeckError && err.isDuplicateReference) {
        booking = await getChowdeckBooking(order.orderNumber);
      } else {
        throw err;
      }
    }

    const cost = booking.priceNaira || quote.totalNaira;
    if (cost > (order.deliveryFeeCharged ?? order.deliveryFee ?? 0)) {
      // URA absorbs the difference, as with Fez.
      console.warn(
        `[markOrderReady] Chowdeck cost ₦${cost} is above the ₦${order.deliveryFeeCharged ?? order.deliveryFee} charged for ${order.orderNumber}`
      );
    }
    order.fulfilment = 'chowdeck';
    order.trackingNumber = booking.reference || order.orderNumber;
    if (booking.trackingUrl) order.trackingUrl = booking.trackingUrl;
    order.chowdeckCost = cost;
    order.deliveryStatus = 'booked';
    order.deliveryUpdatedAt = new Date();
    // The delivery cost is now spent (see the Fez branch).
    order.riderBookedAt = new Date();
  } catch (err) {
    console.error('[markOrderReady] Chowdeck booking failed:', (err as Error).message);
    notifyOrderEvent(order, 'DELIVERY_BOOKING_FAILED').catch(() => {});
    const e: any = new Error(
      'Could not book a delivery rider right now. Please try again shortly.'
    );
    e.status = 502;
    throw e;
  }
}
