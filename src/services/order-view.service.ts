/**
 * What each person may do with an order, and what they may see in lists.
 *
 * The buttons in My Orders, Shop Orders and the order page all come from
 * `orderActions`, so they always agree and follow Payluk's rules:
 *  - only the buyer can report a problem (once), and only while the money is held;
 *  - the seller can reply to a problem once, after the buyer has reported one;
 *  - the seller can claim only after the delivery window plus one day;
 *  - Normal Payment has no confirm, report, claim or reject: it is paid out at once.
 */
import { IOrder } from '@/models/order-model';

export type ViewerRole = 'buyer' | 'seller';

export interface OrderActions {
  // buyer
  pay: boolean;
  cancel: boolean;
  confirmDelivery: boolean;
  reportProblem: boolean;
  getRefund: boolean;
  // seller
  markReady: boolean;
  reject: boolean;
  claimPayment: boolean;
  respondToProblem: boolean;
}

const isOpenDispute = (o: Partial<IOrder>) =>
  ['open', 'investigating'].includes(o.disputeStatus ?? '');

export function orderActions(o: Partial<IOrder>, role: ViewerRole, now = new Date()): OrderActions {
  const paid = o.paymentStatus === 'paid';
  const isProtected = o.paymentType !== 'normal';
  const released = Boolean(o.payoutReleasedAt);
  const closed = ['refunded', 'cancelled'].includes(String(o.status));
  const rejected = Boolean(o.rejectedAt);
  const anyDispute = Boolean(o.disputeStatus);
  const holding = isProtected && paid && !released && !closed;
  const active = ['processing', 'shipped'].includes(String(o.status));

  const none: OrderActions = {
    pay: false,
    cancel: false,
    confirmDelivery: false,
    reportProblem: false,
    getRefund: false,
    markReady: false,
    reject: false,
    claimPayment: false,
    respondToProblem: false,
  };

  if (role === 'buyer') {
    return {
      ...none,
      pay: !paid && !closed,
      cancel: !paid && !closed,
      confirmDelivery: holding && active && !anyDispute && !rejected,
      reportProblem: holding && !anyDispute && !rejected,
      getRefund: holding && rejected && !anyDispute,
    };
  }
  return {
    ...none,
    markReady: paid && o.status === 'processing' && !isOpenDispute(o) && !rejected && !closed,
    reject: holding && o.status === 'processing' && !anyDispute && !rejected,
    claimPayment:
      holding &&
      !anyDispute &&
      !rejected &&
      Boolean(o.claimableAt) &&
      now.getTime() >= new Date(o.claimableAt as Date).getTime(),
    respondToProblem: isOpenDispute(o) && !o.sellerRespondedAt && !released,
  };
}

/** "Amaka O." */
export const shortName = (first?: string | null, last?: string | null) => {
  const f = String(first ?? '').trim();
  const l = String(last ?? '').trim();
  return [f, l ? `${l[0].toUpperCase()}.` : ''].filter(Boolean).join(' ') || 'A customer';
};

/** One line about the money, for the person looking. */
export function moneyNote(o: Partial<IOrder>, role: ViewerRole): string | null {
  if (o.paymentStatus !== 'paid') return role === 'buyer' ? 'Not paid yet' : null;
  if (o.status === 'refunded')
    return role === 'buyer' ? 'Refunded to you' : 'Refunded to the buyer';
  if (o.payoutReleasedAt) return role === 'seller' ? 'Paid to your wallet' : 'Paid to the shop';
  if (o.paymentType === 'normal')
    return role === 'seller' ? 'Being paid to your wallet' : 'Paid to the shop';
  if (isOpenDispute(o)) return 'On hold: a problem was reported';
  if (o.rejectedAt)
    return role === 'buyer' ? 'The shop could not fill this order' : 'You rejected this order';
  if (o.autoReleaseAt) {
    const when = new Date(o.autoReleaseAt).toLocaleString('en-NG', {
      timeZone: 'Africa/Lagos',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    return role === 'seller'
      ? `Money arrives on ${when}`
      : `Paid to the shop on ${when} unless you report a problem`;
  }
  return 'Waiting for the buyer to confirm delivery';
}

/**
 * An order for a LIST: no phone numbers, emails or payment codes. The seller
 * sees the buyer as "Amaka O."; the buyer sees the shop name.
 */
export function presentOrderForList(order: any, role: ViewerRole) {
  const o = typeof order?.toObject === 'function' ? order.toObject() : { ...order };
  const buyer = o.user && typeof o.user === 'object' ? o.user : null;
  const shop = o.business && typeof o.business === 'object' ? o.business : null;
  return {
    _id: o._id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentType: o.paymentType ?? 'protected',
    deliveryMethod: o.deliveryMethod,
    fulfilment: o.fulfilment ?? null,
    items: (o.items ?? []).map((i: any) => ({
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      image: i.image ?? null,
    })),
    itemsTotal:
      o.itemsTotal ?? (o.items ?? []).reduce((s: number, i: any) => s + i.price * i.quantity, 0),
    totalAmount: o.totalAmount,
    deliveryFee: o.deliveryFee ?? 0,
    createdAt: o.createdAt,
    paidAt: o.paidAt ?? null,
    autoReleaseAt: o.autoReleaseAt ?? null,
    payoutReleasedAt: o.payoutReleasedAt ?? null,
    disputeStatus: o.disputeStatus ?? null,
    rejectedAt: o.rejectedAt ?? null,
    trackingNumber: o.trackingNumber ?? null,
    shop: shop
      ? {
          _id: shop._id,
          businessName: shop.businessName,
          slug: shop.slug,
          // Buyers only: for "Message <shop>" on WhatsApp.
          phone: role === 'buyer' ? (shop.contact?.phone ?? null) : null,
        }
      : null,
    buyerName: role === 'seller' ? shortName(buyer?.firstName, buyer?.lastName) : null,
    role,
    actions: orderActions(o, role),
    moneyNote: moneyNote(o, role),
  };
}
