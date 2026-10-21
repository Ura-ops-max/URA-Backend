/**
 * Keeps a URA order in step with its Payluk escrow.
 *
 * `applyEscrowState` is the ONE place that turns "what Payluk says the escrow
 * is now" into order changes. The webhook job, the payment-status check and
 * the release job all call it, so they always agree. It is safe to call any
 * number of times, in any order: every change is a conditional update that
 * only happens once (docs: Webhooks > Don't assume order; trust data.status /
 * data.state).
 */
import Order, { IOrder, OrderStatus } from '@/models/order-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { PaylukJob } from '@/models/payluk-job-model';
import { markOrderPaid, notifyOrderEvent } from '@/services/order-events.service';
import { Escrow, isFunded } from '@/services/payluk.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Queue the automatic release of a Normal order (at most one job per order). */
export async function enqueueRelease(orderId: unknown): Promise<void> {
  const now = new Date();
  await PaylukJob.updateOne(
    { key: `release:${String(orderId)}` },
    {
      $setOnInsert: {
        type: 'release',
        status: 'pending',
        payload: { orderId: String(orderId) },
        attempts: 0,
        runAt: now,
        // Retry 429/5xx with backoff for up to 24 hours, then flag for admin.
        expiresAt: new Date(now.getTime() + DAY_MS),
      },
    },
    { upsert: true }
  );
}

/** Flag an order for a person to look at (shown in logs and the order). */
export async function flagOrder(orderId: unknown, reason: string): Promise<void> {
  console.error(`🚩 [payments] order ${String(orderId)} flagged: ${reason}`);
  await Order.updateOne({ _id: orderId }, { $set: { adminFlag: { reason, at: new Date() } } });
}

/**
 * Apply the escrow's current state to the order. Returns the updated order.
 * `escrow` must come from Payluk (verify, a webhook payload, or an API reply).
 */
export async function applyEscrowState(order: IOrder, escrow: Escrow): Promise<IOrder> {
  const id = order._id;

  // Remember what Payluk last told us (for tracing and the order page).
  await Order.updateOne(
    { _id: id },
    { $set: { paylukState: escrow.state, paylukStatus: escrow.status } }
  );

  // 1. Funded → paid (once). markOrderPaid is atomic and sends the notices.
  if (isFunded(escrow) && order.paymentStatus === 'pending') {
    await markOrderPaid(id, escrow.paymentToken || escrow.id, {
      escrowId: escrow.id,
      status: escrow.status,
      state: escrow.state,
    });
  }

  let current = (await Order.findById(id)) ?? order;

  // 2. Normal Payment: release to the seller straight away.
  if (
    current.paymentType === 'normal' &&
    current.paymentStatus === 'paid' &&
    escrow.state === 'OPENED' &&
    escrow.status === 'ONGOING' &&
    !current.payoutReleasedAt
  ) {
    await enqueueRelease(id);
  }

  // 3. Closed / disputed outcomes. Each conditional update succeeds once only,
  //    so its notice is sent once even if events repeat or arrive out of order.
  switch (escrow.status) {
    case 'COMPLETED':
    case 'CLAIMED': {
      const set: Record<string, unknown> = { payoutReleasedAt: new Date() };
      // Buyer-Protected: the buyer confirmed (or the seller claimed after the
      // window), so the order is complete. Normal: completion happens at once,
      // before delivery, so the delivery status is left alone.
      if (current.paymentType !== 'normal') set.status = OrderStatus.DELIVERED;
      const done = await Order.findOneAndUpdate(
        { _id: id, payoutReleasedAt: { $exists: false } },
        { $set: set },
        { new: true }
      );
      if (done) {
        notifyOrderEvent(
          done,
          done.paymentType === 'normal' ? 'PAYOUT_RELEASED' : 'DELIVERED'
        ).catch(() => {});
      }
      break;
    }

    case 'DISPUTED':
    case 'INVESTIGATING': {
      const next = escrow.status === 'DISPUTED' ? 'open' : 'investigating';
      const opened = await Order.findOneAndUpdate(
        { _id: id, disputeStatus: { $exists: false } },
        { $set: { disputeStatus: next, disputedAt: new Date() } },
        { new: true }
      );
      if (opened) notifyOrderEvent(opened, 'DISPUTED').catch(() => {});
      else if (next === 'investigating') {
        await Order.updateOne(
          { _id: id, disputeStatus: 'open' },
          { $set: { disputeStatus: 'investigating' } }
        );
      }
      break;
    }

    case 'REFUNDED': {
      // Returns the order as it was BEFORE this update.
      const before = await Order.findOneAndUpdate(
        { _id: id, status: { $ne: OrderStatus.REFUNDED } },
        {
          $set: {
            status: OrderStatus.REFUNDED,
            disputeStatus: 'refunded',
            stockReserved: false,
          },
        }
      );
      if (before) {
        // Put the stock back if it was taken (paid, or still held at checkout).
        if (before.paymentStatus === 'paid' || before.stockReserved) {
          for (const item of before.items) {
            await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } });
          }
        }
        const after = await Order.findById(id);
        if (after) notifyOrderEvent(after, 'REFUNDED').catch(() => {});
      }
      break;
    }

    case 'SPLIT': {
      const split = escrow.split;
      const done = await Order.findOneAndUpdate(
        { _id: id, disputeStatus: { $ne: 'split' } },
        {
          $set: {
            disputeStatus: 'split',
            ...(split
              ? {
                  splitDetails: {
                    sellerAmount: Number(split.sellerAmount) || 0,
                    buyerAmount: Number(split.buyerAmount) || 0,
                    pool: Number(split.pool) || 0,
                  },
                }
              : {}),
          },
        },
        { new: true }
      );
      if (done) notifyOrderEvent(done, 'SPLIT').catch(() => {});
      break;
    }

    default:
      break;
  }

  current = (await Order.findById(id)) ?? current;
  return current;
}

/** The buyer's Payluk customer id for an order (needed to release it). */
export async function buyerPaylukId(order: IOrder): Promise<string | null> {
  const buyer = await User.findById(order.user).select('paylukCustomerId').lean();
  return (buyer as any)?.paylukCustomerId ?? null;
}

/** Find the order an escrow belongs to (by escrow id, then payment token). */
export async function findOrderForEscrow(escrowId?: string, paymentToken?: string) {
  if (escrowId) {
    const byId = await Order.findOne({ paylukEscrowId: escrowId });
    if (byId) return byId;
  }
  if (paymentToken) return Order.findOne({ paylukPaymentToken: paymentToken });
  return null;
}
