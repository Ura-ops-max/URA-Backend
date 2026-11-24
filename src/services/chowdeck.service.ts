import axios, { AxiosError } from 'axios';

// ─────────────────────────────────────────────────────────────
// Chowdeck Relay integration (same-city deliveries). See
// docs/chowdeck-relay-integration.md.
// Auth: every call sends `Authorization: Bearer <CHOWDECK_API_KEY>`.
// Money: Chowdeck amounts are in KOBO; URA amounts are in NAIRA. All
// conversion happens in this file only.
// Settings are read when each call runs, so turning Chowdeck on or off is
// just an environment change.
// ─────────────────────────────────────────────────────────────

// TODO(chowdeck-q1): Chowdeck's guides use https://api.relay.chowdeck.com, the
// API reference uses https://api.chowdeck.com. Confirm with Chowdeck, then set
// CHOWDECK_BASE_URL. TODO(chowdeck-q2): the sandbox host is not documented.
const DEFAULT_BASE_URL = 'https://api.relay.chowdeck.com';

export const chowdeckBaseUrl = (): string =>
  (process.env.CHOWDECK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

const apiKey = (): string => process.env.CHOWDECK_API_KEY || '';

/** Chowdeck can be used: there is an API key. City coverage is CHOWDECK_CITIES. */
export const isChowdeckConfigured = (): boolean => Boolean(apiKey());

export class ChowdeckError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly raw?: unknown
  ) {
    super(message);
    this.name = 'ChowdeckError';
  }

  /** "Possible duplicate order. Please send unique reference" */
  get isDuplicateReference(): boolean {
    return /duplicate|unique reference/i.test(this.message);
  }
}

// ─── Units ───────────────────────────────────────────────────

/** 80000 kobo = ₦800. Rounded to whole naira, as URA prices are. */
export const koboToNaira = (kobo: unknown): number => Math.round((Number(kobo) || 0) / 100);

/** ₦800 = 80000 kobo. */
export const nairaToKobo = (naira: unknown): number => Math.round((Number(naira) || 0) * 100);

/**
 * Chowdeck wants 11-digit local numbers: 08012345678.
 * Accepts +2348012345678, 2348012345678, 8012345678 and 08012345678 (spaces
 * and dashes are fine). Anything else is passed through unchanged.
 */
export function toLocalPhone(phone: unknown): string {
  const digits = String(phone ?? '').replace(/[^\d]/g, '');
  if (/^234\d{10}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^0\d{10}$/.test(digits)) return digits;
  if (/^[789]\d{9}$/.test(digits)) return `0${digits}`;
  return String(phone ?? '').trim();
}

// ─── HTTP ────────────────────────────────────────────────────

/** The HTTP client (tests replace `request`). */
export const chowdeckHttp = {
  request: (config: Parameters<typeof axios.request>[0]) => axios.request(config),
};

function toChowdeckError(err: unknown, fallback: string): ChowdeckError {
  const e = err as AxiosError<{ message?: string } | string>;
  const status = e.response?.status ?? 502;
  const body = e.response?.data;
  const message = (typeof body === 'string' ? body : body?.message) || e.message || fallback;
  // Never log the API key or a delivery PIN: only status and Chowdeck's message.
  console.error(`❌ [Chowdeck] ${status} – ${message}`);
  return new ChowdeckError(message, status, body);
}

async function chowdeckRequest<T = any>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  if (!isChowdeckConfigured()) throw new ChowdeckError('Chowdeck is not configured.', 503);
  try {
    const { data } = await chowdeckHttp.request({
      method,
      baseURL: chowdeckBaseUrl(),
      url: path,
      data: body,
      timeout: 20_000,
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    });
    // Chowdeck replies { status: "success" | "failed", message, data }.
    if ((data as any)?.status === 'failed') {
      throw new ChowdeckError((data as any)?.message || 'Chowdeck request failed', 422, data);
    }
    return data as T;
  } catch (err) {
    if (err instanceof ChowdeckError) throw err;
    throw toChowdeckError(err, `Chowdeck request failed: ${method} ${path}`);
  }
}

// ─── Quote ───────────────────────────────────────────────────

export interface ChowdeckPlace {
  address: string;
  lat?: number;
  lng?: number;
}

const hasCoords = (p: ChowdeckPlace) =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);

/** Coordinates when known (most accurate), otherwise the address text. */
function placeFields(prefix: 'source' | 'destination', p: ChowdeckPlace): Record<string, unknown> {
  return hasCoords(p)
    ? { [`${prefix}_address`]: { latitude: p.lat, longitude: p.lng } }
    : { [`${prefix}_address_string`]: p.address };
}

/** POST /relay/delivery/fee → { feeId, totalNaira }. Quotes expire: use soon. */
export async function getChowdeckQuote(opts: {
  pickup: ChowdeckPlace;
  dropoff: ChowdeckPlace;
  orderValueNaira?: number;
}): Promise<{ feeId: number; totalNaira: number; raw: unknown }> {
  const data = await chowdeckRequest('POST', '/relay/delivery/fee', {
    ...placeFields('source', opts.pickup),
    ...placeFields('destination', opts.dropoff),
    ...(opts.orderValueNaira ? { estimated_order_amount: nairaToKobo(opts.orderValueNaira) } : {}),
  });
  const feeId = Number(data?.data?.id);
  const totalNaira = koboToNaira(data?.data?.total_amount);
  if (!feeId || !(totalNaira > 0)) {
    throw new ChowdeckError("Chowdeck couldn't price this delivery.", 422, data);
  }
  return { feeId, totalNaira, raw: data?.data };
}

// ─── Create ──────────────────────────────────────────────────

export interface ChowdeckContact {
  name: string;
  phone: string;
  email?: string;
}

const contact = (c: ChowdeckContact) => ({
  name: c.name,
  phone: toLocalPhone(c.phone),
  country_code: 'NG',
  ...(c.email ? { email: c.email } : {}),
});

export interface ChowdeckDelivery {
  id: number;
  reference: string;
  trackingUrl?: string;
  status: string;
  priceNaira: number;
}

/** POST /relay/delivery. `reference` must be unique (Chowdeck rejects duplicates). */
export async function createChowdeckDelivery(opts: {
  feeId: number;
  reference: string;
  itemType: string;
  orderValueNaira?: number;
  sender: ChowdeckContact;
  recipient: ChowdeckContact;
  note?: string;
  deliveryPin?: number;
}): Promise<ChowdeckDelivery> {
  const data = await chowdeckRequest('POST', '/relay/delivery', {
    fee_id: opts.feeId,
    reference: opts.reference,
    item_type: opts.itemType,
    user_action: 'sending',
    source_contact: contact(opts.sender),
    destination_contact: contact(opts.recipient),
    ...(opts.orderValueNaira ? { estimated_order_amount: nairaToKobo(opts.orderValueNaira) } : {}),
    ...(opts.note ? { customer_delivery_note: opts.note.slice(0, 500) } : {}),
    ...(opts.deliveryPin ? { delivery_pin: opts.deliveryPin } : {}),
    notification_channels: ['sms'],
  });
  return toDelivery(data?.data, opts.reference);
}

function toDelivery(d: any, fallbackReference: string): ChowdeckDelivery {
  return {
    id: Number(d?.id) || 0,
    reference: String(d?.reference || fallbackReference),
    ...(d?.tracking_url ? { trackingUrl: String(d.tracking_url) } : {}),
    status: String(d?.status || 'preparing'),
    priceNaira: koboToNaira(d?.delivery_price ?? d?.total_price),
  };
}

// ─── Read and cancel ─────────────────────────────────────────

/** GET /relay/delivery/{reference}: Chowdeck's delivery object (its own format). */
export async function getChowdeckDelivery(reference: string): Promise<any> {
  const data = await chowdeckRequest('GET', `/relay/delivery/${encodeURIComponent(reference)}`);
  return data?.data ?? {};
}

/** The delivery as a booking summary (used when a create is retried). */
export async function getChowdeckBooking(reference: string): Promise<ChowdeckDelivery> {
  return toDelivery(await getChowdeckDelivery(reference), reference);
}

/** POST /relay/delivery/{reference}/cancel. Any refund goes back to URA's Relay wallet. */
export async function cancelChowdeckDelivery(
  reference: string,
  reason: string
): Promise<{ status: string; refundNaira: number }> {
  const data = await chowdeckRequest(
    'POST',
    `/relay/delivery/${encodeURIComponent(reference)}/cancel`,
    { reason }
  );
  return {
    status: String(data?.data?.status || 'cancelled'),
    refundNaira: koboToNaira(data?.data?.refund_amount),
  };
}
