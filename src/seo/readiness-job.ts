/**
 * Hourly: tell owners, once, when their shop becomes ready for Google
 * ("Your shop can now be found on Google."), through the normal notices.
 * Readiness itself is never stored; it is worked out each time.
 */
import { Business } from '@/models/business-model';
import { trackEvent } from '@/services/track-event.service';
import { SEO_CONFIG } from './config';
import { shopsWithReadiness } from './shop-data';

export const READY_NOTICE = 'Your shop can now be found on Google.';

export async function notifyNewlyReadyShops(): Promise<number> {
  const candidates = await shopsWithReadiness({ googleReadyNotifiedAt: { $exists: false } });
  let sent = 0;
  for (const r of candidates) {
    if (!r.ready) continue;
    // Atomic: only one server sends it, and only ever once per shop.
    const claimed = await Business.findOneAndUpdate(
      { _id: r.shop._id, googleReadyNotifiedAt: { $exists: false } },
      { $set: { googleReadyNotifiedAt: new Date() } }
    );
    if (!claimed) continue;
    await trackEvent({
      targetId: String(r.shop.owner),
      targetModel: 'User',
      type: 'NOTIFICATION',
      notificationData: {
        type: 'SYSTEM',
        title: 'Your shop is on Google',
        message: READY_NOTICE,
        sender: String(r.shop._id),
        senderModel: 'Business',
        relatedId: String(r.shop._id),
        modelType: 'Business',
      },
    }).catch(e => console.error('[seo] ready notice failed:', (e as Error).message));
    sent++;
  }
  return sent;
}

let running = false;
export function startSeoReadinessJob(): void {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const n = await notifyNewlyReadyShops();
      if (n) console.log(`[seo] ${n} shop(s) told they can be found on Google`);
    } catch (e) {
      console.error('[seo] readiness job failed:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void run(), 60_000).unref?.();
  setInterval(() => void run(), SEO_CONFIG.readinessJobMinutes * 60_000).unref?.();
}
