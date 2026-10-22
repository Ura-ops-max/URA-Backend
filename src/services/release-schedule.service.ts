/**
 * When Buyer-Protected money is paid to the shop without the buyer tapping
 * "Confirm delivery" (auto-release), and when the seller may claim it.
 *
 *  - autoReleaseAt = paid time + the longest delivery time of the products in
 *    the order, or `autoReleaseDays` (default 1) when none has one.
 *  - claimableAt   = paid time + the escrow's delivery window + 1 day
 *    (Payluk's rule). The escrow's window comes from the first product, the
 *    same way checkout builds it.
 *  - Any reported problem blocks auto-release for good, even after it is
 *    resolved. So do a rejection, a refund and a cancellation.
 *
 * Nothing here calls Payluk; the release itself goes through the release
 * queue (payluk-jobs), which checks the escrow again first.
 */
import Order, { IOrder } from '@/models/order-model';
import { Product } from '@/models/product-model';
import { deliveryWindowMs } from '@/utils/delivery-window.utils';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The buyer is warned this long before the money goes to the shop. */
export const WARN_BEFORE_MS = 6 * HOUR_MS;

type Window = { _id: unknown; maxDelivery?: number | null; deliveryTimeline?: string | null };

/** Pure: both times from the paid time and the order's products. */
export function computeReleaseTimes(
  paidAt: Date,
  products: Window[],
  firstProductId: unknown,
  autoReleaseDays = 1
): { autoReleaseAt: Date; claimableAt: Date } {
  const withTime = products.filter(p => Number(p.maxDelivery) > 0);
  const autoMs = withTime.length
    ? Math.max(...withTime.map(p => deliveryWindowMs(p.maxDelivery, p.deliveryTimeline)))
    : Math.max(1, autoReleaseDays) * DAY_MS;
  const first = products.find(p => String(p._id) === String(firstProductId));
  const claimMs = deliveryWindowMs(first?.maxDelivery, first?.deliveryTimeline) + DAY_MS;
  return {
    autoReleaseAt: new Date(paidAt.getTime() + autoMs),
    claimableAt: new Date(paidAt.getTime() + claimMs),
  };
}

/**
 * Mongo filter for Buyer-Protected orders whose money is held and may still be
 * auto-released. A report, a rejection, a refund or a cancellation blocks it.
 */
export const autoReleasableFilter = () => ({
  paymentType: { $ne: 'normal' },
  paymentStatus: 'paid',
  payoutReleasedAt: { $exists: false },
  status: { $nin: ['refunded', 'cancelled'] },
  rejectedAt: { $exists: false },
  disputeStatus: { $exists: false },
  buyerReportedAt: { $exists: false },
});

/** Same rules as `autoReleasableFilter`, for one order already loaded. */
export function isAutoReleasable(o: Partial<IOrder>, now = new Date()): boolean {
  return (
    o.paymentType !== 'normal' &&
    o.paymentStatus === 'paid' &&
    !o.payoutReleasedAt &&
    !['refunded', 'cancelled'].includes(String(o.status)) &&
    !o.rejectedAt &&
    !o.disputeStatus &&
    !o.buyerReportedAt &&
    Boolean(o.autoReleaseWarnedAt) &&
    Boolean(o.autoReleaseAt) &&
    new Date(o.autoReleaseAt as Date).getTime() <= now.getTime()
  );
}

/**
 * Set autoReleaseAt (Buyer-Protected only) and claimableAt on a paid order,
 * once. `withAutoRelease: false` sets only claimableAt (used for orders paid
 * before auto-release existed, so they are never released by surprise).
 */
export async function scheduleRelease(
  orderId: unknown,
  { withAutoRelease = true }: { withAutoRelease?: boolean } = {}
): Promise<void> {
  const order = await Order.findById(orderId)
    .select('items paidAt paymentType paymentStatus autoReleaseDays autoReleaseAt claimableAt')
    .lean();
  if (!order || order.paymentStatus !== 'paid' || !order.paidAt) return;
  if (order.paymentType === 'normal') return; // paid to the seller at once
  if (order.autoReleaseAt && order.claimableAt) return;

  const products = await Product.find({ _id: { $in: order.items.map(i => i.product) } })
    .select('maxDelivery deliveryTimeline')
    .lean();
  const times = computeReleaseTimes(
    new Date(order.paidAt),
    products as Window[],
    order.items[0]?.product,
    order.autoReleaseDays ?? 1
  );

  await Order.updateOne(
    { _id: order._id, claimableAt: { $exists: false } },
    { $set: { claimableAt: times.claimableAt } }
  );
  if (withAutoRelease) {
    await Order.updateOne(
      { _id: order._id, autoReleaseAt: { $exists: false } },
      { $set: { autoReleaseAt: times.autoReleaseAt } }
    );
  }
}
