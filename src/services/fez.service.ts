import axios, { AxiosInstance, AxiosError } from 'axios';

// ─────────────────────────────────────────────────────────────
// Fez Delivery integration
// Auth: POST /user/authenticate { user_id, password } → authToken + secret-key.
// Subsequent calls send `Authorization: Bearer <authToken>` and `secret-key`.
// Credentials come from the Fez B2B dashboard → Developers → Manage Keys.
// ─────────────────────────────────────────────────────────────

const FEZ_BASE = (process.env.FEZ_BASE_URL || 'https://apisandbox.fezdelivery.co/v1').replace(/\/$/, '');
const USER_ID = process.env.FEZ_USER_ID || '';
const PASSWORD = process.env.FEZ_PASSWORD || '';

export const isFezConfigured = (): boolean => Boolean(USER_ID && PASSWORD);

const fezAxios: AxiosInstance = axios.create({ baseURL: FEZ_BASE, timeout: 20_000 });

export class FezError extends Error {
  constructor(message: string, public readonly statusCode = 502, public readonly raw?: unknown) {
    super(message);
    this.name = 'FezError';
  }
}

// Cache the auth token until shortly before it expires.
let cached: { authToken: string; secretKey: string; expiresAt: number } | null = null;

async function authenticate(): Promise<{ authToken: string; secretKey: string }> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

  try {
    const { data } = await fezAxios.post('/user/authenticate', { user_id: USER_ID, password: PASSWORD });
    const authToken = data?.authDetails?.authToken;
    const secretKey = data?.orgDetails?.['secret-key'];
    if (!authToken || !secretKey) throw new FezError('Fez authentication did not return a token', 502, data);

    const expireToken = data?.authDetails?.expireToken;
    const expiresAt = expireToken ? new Date(expireToken).getTime() : Date.now() + 30 * 60 * 1000;
    cached = { authToken, secretKey, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 30 * 60 * 1000 : expiresAt };
    return cached;
  } catch (err) {
    cached = null;
    throw toFezError(err, 'Fez authentication failed');
  }
}

// Fez can invalidate a token before our cached expiry, replying "Invalid
// session" / 401. Detect that so we can drop the cache and re-authenticate.
function isAuthError(err: unknown): boolean {
  const e = err as AxiosError<{ description?: string; message?: string }>;
  const status = e.response?.status;
  const msg = (e.response?.data?.description || e.response?.data?.message || e.message || '').toLowerCase();
  return status === 401 || status === 403 || /invalid session|token|unauthor|expired/.test(msg);
}

async function doFezRequest<T>(method: 'GET' | 'POST', url: string, body: unknown, auth: { authToken: string; secretKey: string }): Promise<T> {
  const { data } = await fezAxios.request<T>({
    method,
    url,
    data: body,
    // Fez's live API requires the `Bearer ` prefix (verified via curl — the
    // raw token returns "Authorization token is missing").
    headers: { Authorization: `Bearer ${auth.authToken}`, 'secret-key': auth.secretKey },
  });
  return data;
}

async function fezRequest<T = any>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const auth = await authenticate();
  try {
    return await doFezRequest<T>(method, url, body, auth);
  } catch (err) {
    // Stale/invalid session → force a fresh login and retry once.
    if (isAuthError(err)) {
      console.warn('[Fez] session rejected — re-authenticating and retrying once…');
      cached = null;
      try {
        const fresh = await authenticate();
        return await doFezRequest<T>(method, url, body, fresh);
      } catch (retryErr) {
        throw toFezError(retryErr, `Fez request failed: ${method} ${url}`);
      }
    }
    throw toFezError(err, `Fez request failed: ${method} ${url}`);
  }
}

function toFezError(err: unknown, fallback: string): FezError {
  const e = err as AxiosError<{ description?: string; message?: string }>;
  const status = e.response?.status ?? 502;
  const message = e.response?.data?.description || e.response?.data?.message || e.message || fallback;
  console.error(`❌ [Fez] ${status} – ${message}`);
  return new FezError(message, status, e.response?.data);
}

// ─── Delivery cost / quote ───────────────────────────────────
export type DeliveryCostResult = { cost: number; vat: number; totalCost: number; state: string; raw: unknown };

export async function getDeliveryCost(opts: {
  state: string;
  pickUpState?: string;
  weight?: number;
}): Promise<DeliveryCostResult> {
  const data = await fezRequest('POST', '/order/cost', {
    state: opts.state,
    ...(opts.pickUpState ? { pickUpState: opts.pickUpState } : {}),
    ...(opts.weight != null ? { weight: opts.weight } : {}),
  });

  const totalCost = Number(data?.totalCost ?? 0);

  // Fez can reply HTTP 200 with a non-success body (e.g. a state it doesn't
  // serve from this pickup). Treat that as a real error so the UI shows a clear
  // message instead of hanging on "Calculating…" or quoting ₦0.
  if (data?.status !== 'Success' || !(totalCost > 0)) {
    throw new FezError(
      data?.description || `Delivery to ${opts.state} isn't available right now.`,
      422,
      data,
    );
  }

  return {
    cost: Number(data?.cost?.cost ?? 0),
    vat: Number(data?.vat?.vatAmount ?? 0),
    totalCost,
    state: data?.cost?.state ?? opts.state,
    raw: data,
  };
}

// ─── Create order / shipment ─────────────────────────────────
export type CreateDeliveryInput = {
  uniqueID: string;          // our order id
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  recipientState: string;    // Nigerian state or FCT
  valueOfItem: string | number;
  weight?: number;
  recipientEmail?: string;
  itemDescription?: string;
  pickUpState?: string;
  pickUpAddress?: string;
};

export async function createDeliveryOrder(order: CreateDeliveryInput): Promise<{ trackingNo: string | null; raw: unknown }> {
  // Fez accepts an array of order objects; BatchID groups them.
  const payload = [
    {
      ...order,
      valueOfItem: String(order.valueOfItem),
      weight: order.weight ?? 1,
      BatchID: order.uniqueID,
    },
  ];
  const data = await fezRequest('POST', '/order', payload);
  const orderNos = (data?.orderNos ?? {}) as Record<string, string>;
  const trackingNo = orderNos[order.uniqueID] ?? Object.values(orderNos)[0] ?? null;
  return { trackingNo, raw: data };
}

// ─── Track ───────────────────────────────────────────────────
export async function trackDeliveryOrder(orderNumber: string): Promise<unknown> {
  return fezRequest('GET', `/order/track/${encodeURIComponent(orderNumber)}`);
}
