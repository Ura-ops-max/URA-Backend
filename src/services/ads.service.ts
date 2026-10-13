import axios from 'axios';

/**
 * Checkout ads from ura-rmn (the Retail Media Network ad server).
 *
 * We ask ura-rmn which ad to show for a given shop, server-side, so the ad
 * server's secret never reaches the browser. If anything is missing or goes
 * wrong, we simply return null and checkout shows no ad — the ad must never
 * block or break a purchase.
 */

const RMN_API_BASE = (process.env.RMN_API_BASE || '').replace(/\/$/, '');
const RMN_SECRET = process.env.RMN_SERVE_API_SECRET || '';
const TIMEOUT_MS = Math.max(500, Number(process.env.RMN_TIMEOUT_MS) || 2500);
const MAX_BYTES = 100 * 1024; // cap any ad payload at 100KB

// Map a URA business _id to its ura-rmn Store id, from RMN_STORE_MAP (JSON).
let storeMap: Record<string, string> = {};
try {
  storeMap = JSON.parse(process.env.RMN_STORE_MAP || '{}');
  if (typeof storeMap !== 'object' || storeMap === null) storeMap = {};
} catch {
  console.error('[ads] RMN_STORE_MAP is not valid JSON — ads disabled.');
  storeMap = {};
}

export interface CheckoutAd {
  format: 'html';
  html: string;
  destination?: string;
}

// Remember "this store has no ad right now" for 60s, so we don't ask ura-rmn on
// every checkout step.
const noAdUntil = new Map<string, number>();

export async function getCheckoutAd(businessId: string): Promise<CheckoutAd | null> {
  if (!RMN_API_BASE || !RMN_SECRET || !businessId) return null;

  const storeId = storeMap[businessId];
  if (!storeId) return null;

  const until = noAdUntil.get(storeId);
  if (until && until > Date.now()) return null;

  const cacheNoAd = () => noAdUntil.set(storeId, Date.now() + 60_000);

  try {
    const res = await axios.get(`${RMN_API_BASE}/api/ads/select`, {
      params: { storeId },
      headers: { Authorization: `Bearer ${RMN_SECRET}` },
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      validateStatus: () => true, // we handle the status ourselves
    });

    if (res.status !== 200 || !res.data) {
      cacheNoAd();
      return null;
    }

    const ad = res.data?.ad;
    if (!ad || ad.format !== 'html' || typeof ad.html !== 'string' || !ad.html.trim()) {
      cacheNoAd();
      return null;
    }
    if (Buffer.byteLength(ad.html, 'utf8') > MAX_BYTES) {
      cacheNoAd();
      return null;
    }

    const result: CheckoutAd = { format: 'html', html: ad.html };
    if (typeof res.data?.destination === 'string') result.destination = res.data.destination;
    return result;
  } catch (err) {
    // Never log the secret. Log only the reason.
    console.error('[ads] checkout ad fetch failed:', (err as Error).message);
    cacheNoAd();
    return null;
  }
}
