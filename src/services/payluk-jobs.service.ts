/**
 * Background worker for Payluk: processes stored jobs one at a time, so the
 * webhook can answer Payluk fast and releases survive server restarts.
 *
 * Job types:
 *  - webhook: apply a received Payluk event to its order.
 *  - release: pay the seller (confirm-payment as the buyer): a Normal Payment
 *    at once, or a Buyer-Protected order when its auto-release time comes.
 *
 * Safety: a job is claimed with an atomic update (status pending → running,
 * with a lock that expires), so two workers can never run the same job. The
 * release job re-checks the escrow before calling Payluk, and never releases
 * an order that is already released or not OPENED.
 */
import Order from '@/models/order-model';
import { IPaylukJob, PaylukJob } from '@/models/payluk-job-model';
import { PaylukError, confirmEscrow, toEscrow, verifyEscrow } from '@/services/payluk.service';
import {
  applyEscrowState,
  buyerPaylukId,
  findOrderForEscrow,
  flagOrder,
} from '@/services/payment-sync.service';
import { isAutoReleasable } from '@/services/release-schedule.service';

const POLL_MS = 3_000;
const LOCK_MS = 5 * 60_000;
const MAX_JOBS_PER_TICK = 5;

/** Wait before retry n (1, 2, …): 30s, 1m, 2m … capped at 30 minutes. */
export const retryDelayMs = (attempt: number) =>
  Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));

class Skip extends Error {}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** Release the escrow to the seller, once (Normal, or Buyer-Protected auto-release). */
export async function runRelease(job: IPaylukJob): Promise<void> {
  const orderId = String(job.payload.orderId);
  const auto = job.payload.auto === true;
  const order = await Order.findById(orderId);
  if (!order) throw new Skip(`order ${orderId} not found`);
  if (order.payoutReleasedAt) throw new Skip('already released');
  if (order.paymentType !== 'normal') {
    if (!auto) throw new Skip('not a Normal Payment order');
    // Checked again right before paying: a problem reported since the job was
    // queued, a rejection or a refund stops it.
    if (!isAutoReleasable(order)) throw new Skip('auto-release no longer allowed');
  }
  if (!order.paylukPaymentToken || !order.paylukEscrowId) throw new Skip('no escrow on order');

  // Check the escrow's real state first; it may already be completed or disputed.
  const before = await verifyEscrow(order.paylukPaymentToken, 'background');
  const synced = await applyEscrowState(order, before);
  if (synced.payoutReleasedAt) throw new Skip('released (seen on verify)');
  if (before.state !== 'OPENED' || before.status !== 'ONGOING') {
    // Not funded yet: try again later. Closed or disputed: nothing to release.
    if (before.state === 'AWAITING_PAYMENT') throw new PaylukError('not funded yet', 409, 'SERVER');
    throw new Skip(`escrow is ${before.state}/${before.status}`);
  }

  const buyerId = await buyerPaylukId(order);
  if (!buyerId) throw new Skip('buyer has no Payluk id');

  await Order.updateOne(
    { _id: order._id },
    { $set: { releaseRequestedAt: new Date(), releaseRequestedBy: 'auto' } }
  );
  const after = await confirmEscrow(order.paylukEscrowId, buyerId, 'background');
  await applyEscrowState(synced, after.id ? after : before);
}

/** Apply a stored webhook event to its order. */
export async function runWebhook(job: IPaylukJob): Promise<void> {
  const event = String(job.payload.event || '');
  const data = (job.payload.data || {}) as Record<string, any>;

  if (event.startsWith('escrow.')) {
    const order = await findOrderForEscrow(data.id, data.paymentToken);
    if (!order) throw new Skip(`no order for escrow ${data.id}`);
    let escrow = toEscrow(data);
    // A funding event is confirmed with Payluk before the order is marked paid.
    if (
      order.paymentStatus === 'pending' &&
      (escrow.state === 'OPENED' || escrow.state === 'CLOSED')
    ) {
      escrow = await verifyEscrow(order.paylukPaymentToken || escrow.paymentToken, 'background');
    }
    await applyEscrowState(order, escrow);
    return;
  }

  if (event === 'payment.escrow.success') {
    const order = await findOrderForEscrow(data.escrowDetails?.escrowId);
    if (!order) throw new Skip('no order for this escrow payment');
    if (!order.paylukPaymentToken) throw new Skip('order has no payment token');
    await applyEscrowState(order, await verifyEscrow(order.paylukPaymentToken, 'background'));
    return;
  }

  // URA's own payouts from Payluk: record them on the order (once).
  if (event === 'payment.delivery.success' || event === 'payment.commission.success') {
    const order = await findOrderForEscrow(data.escrowDetails?.escrowId);
    if (!order) throw new Skip(`no order for ${event}`);
    const field = event === 'payment.delivery.success' ? 'deliveryFee' : 'commission';
    await Order.updateOne(
      { _id: order._id, [`${field}ReceivedAt`]: { $exists: false } },
      {
        $set: {
          [`${field}Received`]: Number(data.amount) || 0,
          [`${field}ReceivedAt`]: new Date(),
        },
      }
    );
    return;
  }

  throw new Skip(`event ${event} needs no action`);
}

// ─── Worker ──────────────────────────────────────────────────────────────────

async function claimNext(): Promise<IPaylukJob | null> {
  const now = new Date();
  return PaylukJob.findOneAndUpdate(
    {
      runAt: { $lte: now },
      $or: [
        { status: 'pending' },
        // A worker that crashed mid-job: take it over once its lock expires.
        { status: 'running', lockedUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: 'running', lockedUntil: new Date(now.getTime() + LOCK_MS) },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, new: true }
  );
}

export async function runJob(job: IPaylukJob): Promise<void> {
  try {
    if (job.type === 'release') await runRelease(job);
    else await runWebhook(job);
    await PaylukJob.updateOne({ _id: job._id }, { $set: { status: 'done', lastError: undefined } });
  } catch (e) {
    if (e instanceof Skip) {
      console.log(`[payluk-jobs] ${job.key}: done (${e.message})`);
      await PaylukJob.updateOne(
        { _id: job._id },
        { $set: { status: 'done', lastError: e.message } }
      );
      return;
    }
    const err = e as PaylukError;
    const message = (err?.message || String(e)).slice(0, 300);

    // Payluk says our key may not do this (not a merchant super-admin key).
    // Retrying will not help: stop and flag the order for a person.
    if (err instanceof PaylukError && err.code === 'UNAUTHORIZED') {
      await PaylukJob.updateOne(
        { _id: job._id },
        { $set: { status: 'flagged', lastError: message } }
      );
      if (job.payload.orderId) {
        await flagOrder(
          job.payload.orderId,
          'Payluk refused the release (401 Access denied). Check that PAYLUK_SECRET_KEY belongs to a merchant super-admin account.'
        );
      }
      return;
    }

    const giveUp = Date.now() >= new Date(job.expiresAt).getTime();
    if (giveUp) {
      await PaylukJob.updateOne(
        { _id: job._id },
        { $set: { status: 'failed', lastError: message } }
      );
      if (job.payload.orderId)
        await flagOrder(job.payload.orderId, `Release gave up after 24 hours: ${message}`);
      return;
    }
    const delay = retryDelayMs(job.attempts);
    console.warn(
      `[payluk-jobs] ${job.key} attempt ${job.attempts} failed: ${message}. Retry in ${Math.round(delay / 1000)}s`
    );
    await PaylukJob.updateOne(
      { _id: job._id },
      { $set: { status: 'pending', lastError: message, runAt: new Date(Date.now() + delay) } }
    );
  }
}

let ticking = false;
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      const job = await claimNext();
      if (!job) break;
      await runJob(job);
    }
  } catch (e) {
    console.error('[payluk-jobs] tick failed:', (e as Error).message);
  } finally {
    ticking = false;
  }
}

/** Start the worker. Call once on server boot. */
export function startPaylukWorker(): void {
  setInterval(() => void tick(), POLL_MS).unref?.();
  console.log('[payluk-jobs] worker started');
}
