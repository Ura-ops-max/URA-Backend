/**
 * Order lifecycle: one place that moves an order forward (paid → shipped /
 * ready for pickup → delivered, or refunded/disputed) and tells BOTH the buyer
 * and the seller — in-app notification (live via socket when online) + email.
 *
 * Used by the Payluk webhook, the buyer's payment-return page, and the seller's
 * "ship / ready for pickup" action, so every path behaves the same way.
 */
import Order, { IOrder, OrderStatus } from '@/models/order-model';
import Cart from '@/models/cart-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { trackEvent } from '@/services/track-event.service';
import { sendOrderEmail } from '@/templates/emails';
import { config } from '@/config/env.config';

export type OrderEvent =
  | 'PAID'
  | 'SHIPPED'
  | 'READY_FOR_PICKUP'
  | 'SELLER_DELIVERING'
  | 'DELIVERED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'DELIVERY_BOOKING_FAILED';

const naira = (n: number) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

/** Which Payluk escrow statuses mean "the buyer's money has arrived". */
export const isPaidStatus = (status?: string): boolean => {
  const allowed = (process.env.PAYLUK_PAID_STATUSES || 'ongoing,paid,success,successful,completed,funded')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!status && allowed.includes(String(status).toLowerCase());
};

/**
 * Mark an order paid exactly once. The status flip is a single atomic update,
 * so the webhook and the buyer's return page can both call this safely — only
 * the first one does the work (no double stock deduction, no double notices).
 * Returns the updated order, or null if it was already paid.
 */
export async function markOrderPaid(
  orderId: unknown,
  transactionRef: string,
  details?: unknown,
): Promise<IOrder | null> {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, paymentStatus: 'pending' },
    {
      $set: {
        paymentStatus: 'paid',
        status: OrderStatus.PROCESSING,
        paidAt: new Date(),
        payment: { provider: 'payluk', transactionRef, details },
      },
    },
    { new: true },
  );
  if (!order) return null; // already handled

  // Deduct stock. Money has already been taken, so never fail the payment over
  // stock — instead floor at zero and warn the seller.
  const shortItems: string[] = [];
  for (const item of order.items) {
    const res = await Product.updateOne(
      { _id: item.product, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } },
    );
    if (res.modifiedCount === 0) {
      shortItems.push(item.name);
      await Product.updateOne({ _id: item.product }, { $set: { stock: 0 } });
    }
  }

  await Cart.findOneAndDelete({ user: order.user });

  notifyOrderEvent(
    order,
    'PAID',
    shortItems.length ? { note: `Stock was too low for: ${shortItems.join(', ')}. Please contact the buyer.` } : {},
  ).catch((e) => console.error('[order-events] PAID notify failed:', e));

  return order;
}

/** Load who's who for an order: buyer, business, and the seller (business owner). */
async function getParties(order: IOrder) {
  const [buyer, business] = await Promise.all([
    User.findById(order.user).select('firstName lastName email phone'),
    Business.findById(order.business).select('businessName owner address contact slug'),
  ]);
  const seller = business ? await User.findById(business.owner).select('firstName lastName email') : null;
  return { buyer, business, seller };
}

/** Tell the buyer and the seller what just happened to an order. */
export async function notifyOrderEvent(
  order: IOrder,
  event: OrderEvent,
  extra: { note?: string } = {},
): Promise<void> {
  const { buyer, business, seller } = await getParties(order);
  if (!buyer || !business || !seller) {
    console.warn('[order-events] missing buyer/business/seller for order', order.orderNumber);
    return;
  }

  const shopName = business.businessName;
  const buyerName = `${buyer.firstName ?? ''} ${buyer.lastName ?? ''}`.trim() || 'A customer';
  const itemsText = order.items.map((i) => `${i.name} ×${i.quantity}`).join(', ');
  const total = naira(order.totalAmount);
  // What the seller actually receives: the items only. Delivery (Fez) and any
  // platform fee are paid outside the seller's escrow.
  const itemsTotal = naira(order.items.reduce((s, i) => s + i.price * i.quantity, 0));
  const shopPhone = business.contact?.phone ? ` Shop phone: ${business.contact.phone}.` : '';
  const orderLink = `/dashboard/orders/${order._id}`;
  const pickupAddress = business.address?.fullAddress || business.address?.city || 'the shop';

  const copy: Record<OrderEvent, { buyer?: [string, string]; seller?: [string, string] }> = {
    PAID: {
      buyer: ['Payment confirmed', `Your order ${order.orderNumber} from ${shopName} is paid (${total}). The seller is preparing it.`],
      seller: [
        'New paid order',
        `${buyerName} paid for ${itemsText}. You'll receive ${itemsTotal} for the items when the buyer confirms they got them${
          order.deliveryMethod === 'delivery' ? ' (delivery is paid to Fez separately). Tap "Book delivery" when it is ready.' : '. Tap "Ready for pickup", or "I\'ll deliver it myself".'
        }`,
      ],
    },
    SHIPPED: {
      buyer: ['Your order is on its way', `Order ${order.orderNumber} has been handed to the delivery rider.${order.trackingNumber ? ` Tracking number: ${order.trackingNumber}.` : ''}`],
      seller: ['Delivery booked', `A rider has been booked for order ${order.orderNumber}.${order.trackingNumber ? ` Tracking: ${order.trackingNumber}.` : ''}`],
    },
    READY_FOR_PICKUP: {
      buyer: ['Ready for pickup', `Order ${order.orderNumber} is ready. Pick it up at ${shopName}, ${pickupAddress}.`],
      seller: ['Marked ready for pickup', `${buyerName} has been told order ${order.orderNumber} is ready.`],
    },
    SELLER_DELIVERING: {
      buyer: ['Your order is on its way', `${shopName} is bringing order ${order.orderNumber} to you themselves.${shopPhone}`],
      seller: ['Delivering it yourself', `${buyerName} has been told you're bringing order ${order.orderNumber}. Phone: ${order.shippingAddress?.phone ?? 'n/a'}.`],
    },
    DELIVERED: {
      buyer: ['Order completed', `Thanks! Order ${order.orderNumber} is complete and the seller has been paid.`],
      seller: ['Payment released', `The buyer confirmed order ${order.orderNumber}. ${itemsTotal} has been released to you.`],
    },
    REFUNDED: {
      buyer: ['Order refunded', `Order ${order.orderNumber} was refunded.`],
      seller: ['Order refunded', `Order ${order.orderNumber} was refunded to the buyer.`],
    },
    DISPUTED: {
      buyer: ['Dispute opened', `A dispute is open on order ${order.orderNumber}. Payluk will review it.`],
      seller: ['Dispute opened', `A dispute is open on order ${order.orderNumber}. Funds are on hold while Payluk reviews it.`],
    },
    DELIVERY_BOOKING_FAILED: {
      seller: ['Delivery booking failed', `We could not book a rider for order ${order.orderNumber}. Please try again or arrange delivery yourself.`],
    },
  };

  const msgs = copy[event];
  const relatedId = String(order._id);

  // Buyer: in-app (sent "from" the shop) + email.
  if (msgs.buyer) {
    const [title, message] = msgs.buyer;
    await trackEvent({
      targetId: String(buyer._id),
      targetModel: 'User',
      type: 'BOTH',
      activityData: { action: `ORDER_${event}`, description: `${title} — ${order.orderNumber}` },
      notificationData: {
        type: 'BUSINESS',
        title,
        message,
        sender: String(business._id),
        senderModel: 'Business',
        relatedId,
        modelType: 'Order',
      },
    }).catch((e) => console.error('[order-events] buyer notice failed:', e));
    if (buyer.email) sendOrderEmail(buyer.email, title, message, `${config.frontend.url}${orderLink}`);
  }

  // Seller: in-app (sent "from" the buyer) + email.
  if (msgs.seller) {
    const [title, base] = msgs.seller;
    const message = extra.note ? `${base} ${extra.note}` : base;
    await trackEvent({
      targetId: String(seller._id),
      targetModel: 'User',
      type: 'BOTH',
      activityData: { action: `ORDER_${event}`, description: `${title} — ${order.orderNumber}` },
      notificationData: {
        type: 'BUSINESS',
        title,
        message,
        sender: String(buyer._id),
        senderModel: 'User',
        relatedId,
        modelType: 'Order',
      },
    }).catch((e) => console.error('[order-events] seller notice failed:', e));
    if (seller.email) sendOrderEmail(seller.email, title, message, `${config.frontend.url}${orderLink}`);
  }
}
