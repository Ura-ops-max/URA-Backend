/**
 * Auto-release job (Buyer-Protected). Every AUTO_RELEASE_JOB_INTERVAL_SECONDS
 * (default 300):
 *  1. Warn buyers 6 hours before: "Your money goes to <shop> in 6 hours. Tap
 *     here if there is a problem." The release is never sooner than 6 hours
 *     after this warning, so the message is always true.
 *  2. Put orders that are due, and were warned, on the release queue. The
 *     queue checks the order and the escrow again just before paying.
 *  3. Give older paid orders a claimableAt (never an auto-release time).
 *
 * Any reported problem blocks auto-release for good (see release-schedule).
 */
import Order from '@/models/order-model';
import { notifyOrderEvent } from '@/services/order-events.service';
import { enqueueRelease } from '@/services/payment-sync.service';
import {
  WARN_BEFORE_MS,
  autoReleasableFilter,
  scheduleRelease,
} from '@/services/release-schedule.service';

const BATCH = 50;

export async function autoReleaseTick(
  now = new Date()
): Promise<{ warned: number; queued: number }> {
  let warned = 0;
  let queued = 0;

  // 1. Warnings.
  const soon = await Order.find({
    ...autoReleasableFilter(),
    autoReleaseAt: { $lte: new Date(now.getTime() + WARN_BEFORE_MS) },
    autoReleaseWarnedAt: { $exists: false },
  })
    .select('_id autoReleaseAt')
    .limit(BATCH)
    .lean();
  for (const o of soon) {
    const at = Math.max(
      new Date(o.autoReleaseAt as Date).getTime(),
      now.getTime() + WARN_BEFORE_MS
    );
    // Atomic: only one server sends the warning.
    const claimed = await Order.findOneAndUpdate(
      { _id: o._id, ...autoReleasableFilter(), autoReleaseWarnedAt: { $exists: false } },
      { $set: { autoReleaseWarnedAt: now, autoReleaseAt: new Date(at) } },
      { new: true }
    );
    if (claimed) {
      warned++;
      notifyOrderEvent(claimed, 'RELEASE_SOON').catch(e =>
        console.error('[auto-release] warning failed:', (e as Error).message)
      );
    }
  }

  // 2. Due releases (only ever after the warning).
  const due = await Order.find({
    ...autoReleasableFilter(),
    autoReleaseAt: { $lte: now },
    autoReleaseWarnedAt: { $exists: true },
  })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const o of due) {
    await enqueueRelease(o._id, { auto: true });
    queued++;
  }

  // 3. Orders paid before auto-release existed: let the seller claim them.
  const old = await Order.find({
    paymentType: { $ne: 'normal' },
    paymentStatus: 'paid',
    payoutReleasedAt: { $exists: false },
    claimableAt: { $exists: false },
    paidAt: { $exists: true },
  })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const o of old) await scheduleRelease(o._id, { withAutoRelease: false });

  return { warned, queued };
}

export function autoReleaseIntervalMs(): number {
  const s = Number(process.env.AUTO_RELEASE_JOB_INTERVAL_SECONDS);
  return (Number.isFinite(s) && s >= 30 ? s : 300) * 1000;
}

let running = false;

/** Start the job. Call once on server boot. */
export function startAutoReleaseJob(): void {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await autoReleaseTick();
      if (r.warned || r.queued)
        console.log(`[auto-release] warned ${r.warned}, queued ${r.queued}`);
    } catch (e) {
      console.error('[auto-release] tick failed:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(() => void run(), autoReleaseIntervalMs()).unref?.();
  console.log('[auto-release] job started');
}
