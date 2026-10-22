/**
 * Web push (VAPID) for sellers' "New paid order" alerts, so they hear about
 * an order even when URA is not open. Off unless VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY and VAPID_SUBJECT are set. Payloads carry names and order
 * numbers only, never contact details.
 */
import { URL } from 'url';
import webpush from 'web-push';
import { PushSubscription } from '@/models/push-subscription-model';

export interface PushPayload {
  title: string;
  body: string;
  /** Path inside URA to open on tap, e.g. /dashboard/orders/<id>. */
  url: string;
}

let configuredWith: string | null = null;

/** Set up VAPID from the environment. False when push is not configured. */
export function pushConfigured(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return false;
  const key = `${subject}|${pub}`;
  if (configuredWith !== key) {
    webpush.setVapidDetails(subject, pub, priv);
    configuredWith = key;
  }
  return true;
}

/** A subscription a browser may save: https endpoint and both keys. */
export function validSubscription(
  body: any
): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';
  if (
    !endpoint ||
    endpoint.length > 1000 ||
    !p256dh ||
    p256dh.length > 200 ||
    !auth ||
    auth.length > 100
  ) {
    return null;
  }
  try {
    if (new URL(endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** Save (or move to this user) the browser's subscription. */
export async function saveSubscription(
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } }
): Promise<void> {
  // One browser = one endpoint. Whoever is signed in there now gets its alerts.
  await PushSubscription.updateOne(
    { endpoint: sub.endpoint },
    { $set: { user: userId, keys: sub.keys } },
    { upsert: true }
  );
}

/** Remove the user's own subscription only. */
export async function removeSubscription(userId: string, endpoint: string): Promise<number> {
  const r = await PushSubscription.deleteOne({ user: userId, endpoint });
  return r.deletedCount ?? 0;
}

/** Send to every browser the user subscribed. Gone subscriptions are removed. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!pushConfigured()) return 0;
  const subs = await PushSubscription.find({ user: userId }).lean();
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        JSON.stringify(payload),
        { TTL: 60 * 60, urgency: 'high' }
      );
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: s._id });
      } else {
        console.error('[push] send failed:', e?.statusCode ?? '', e?.message ?? e);
      }
    }
  }
  return sent;
}
