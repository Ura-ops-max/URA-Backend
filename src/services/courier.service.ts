import crypto from 'crypto';
import {
  FezError,
  getDeliveryCost,
  isFezConfigured,
  type DeliveryCostResult,
} from '@/services/fez.service';
import {
  cancelChowdeckDelivery,
  getChowdeckQuote,
  isChowdeckConfigured,
  type ChowdeckPlace,
} from '@/services/chowdeck.service';

// ─────────────────────────────────────────────────────────────
// Which courier delivers an order, and one tracking format for both.
// Rule (docs/chowdeck-relay-integration.md, section 1):
//   shop and buyer in the same service area AND that area is in
//   CHOWDECK_CITIES → Chowdeck; anything else → Fez; Chowdeck quote fails → Fez.
// Pickup and seller delivery never get here. With no Chowdeck settings,
// every delivery is Fez, exactly as before.
// ─────────────────────────────────────────────────────────────

export type CourierProvider = 'chowdeck' | 'fez';

export const PROVIDER_NAME: Record<CourierProvider, string> = { chowdeck: 'Chowdeck', fez: 'Fez' };

// ─── Places ──────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  fct: 'abuja',
  'federal capital territory': 'abuja',
  'abuja fct': 'abuja',
  'fct abuja': 'abuja',
  ph: 'port harcourt',
  'port-harcourt': 'port harcourt',
  portharcourt: 'port harcourt',
};

/** "  Lagos State " → "lagos"; "FCT" → "abuja". */
export function normalisePlace(value: unknown): string {
  const v = String(value ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+state$/, '');
  return ALIASES[v] ?? v;
}

/** CHOWDECK_CITIES, normalised. Empty means Chowdeck is never chosen. */
export function chowdeckCities(): string[] {
  return String(process.env.CHOWDECK_CITIES || '')
    .split(',')
    .map(normalisePlace)
    .filter(Boolean);
}

export interface PlaceNames {
  city?: string | null | undefined;
  state?: string | null | undefined;
}

/** The Chowdeck service area that both places are in, or null. */
export function sharedServiceArea(shop: PlaceNames, buyer: PlaceNames): string | null {
  const shopNames = [shop.city, shop.state].map(normalisePlace).filter(Boolean);
  const buyerNames = [buyer.city, buyer.state].map(normalisePlace).filter(Boolean);
  return (
    chowdeckCities().find(area => shopNames.includes(area) && buyerNames.includes(area)) ?? null
  );
}

/** Same service area, and Chowdeck is set up: Chowdeck. Otherwise Fez. */
export function chooseCourier(shop: PlaceNames, buyer: PlaceNames): CourierProvider {
  return isChowdeckConfigured() && sharedServiceArea(shop, buyer) ? 'chowdeck' : 'fez';
}

// ─── Quote (checkout and POST /delivery/cost use the same one) ─

export interface ShopForQuote {
  address?: { fullAddress?: string; city?: string; state?: string } | null;
  location?: { coordinates?: number[] } | null;
}

export interface DropoffForQuote {
  state: string;
  city?: string | null;
  fullAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface DeliveryQuote {
  provider: CourierProvider;
  totalCost: number;
  eta?: string;
  /** Present for Fez quotes (today's response fields). */
  fez?: DeliveryCostResult;
}

const joinAddress = (...parts: unknown[]) =>
  parts
    .map(p => String(p ?? '').trim())
    .filter(Boolean)
    .join(', ');

export function shopPlace(shop: ShopForQuote): ChowdeckPlace {
  const [lng, lat] = shop.location?.coordinates ?? [];
  return {
    address: joinAddress(shop.address?.fullAddress, shop.address?.city, shop.address?.state),
    ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}),
  };
}

export function dropoffPlace(d: DropoffForQuote): ChowdeckPlace {
  return {
    address: joinAddress(d.fullAddress, d.city, d.state),
    ...(Number.isFinite(Number(d.latitude)) &&
    Number.isFinite(Number(d.longitude)) &&
    d.latitude != null &&
    d.longitude != null
      ? { lat: Number(d.latitude), lng: Number(d.longitude) }
      : {}),
  };
}

/**
 * Price a delivery with the right courier. Chowdeck when the rule says so
 * and its quote works; otherwise Fez (which throws as today if Fez can't).
 */
export async function quoteDelivery(opts: {
  shop: ShopForQuote | null;
  dropoff: DropoffForQuote;
  pickUpState?: string;
  orderValueNaira?: number;
  weight?: number;
}): Promise<DeliveryQuote> {
  const shop = opts.shop ?? {};
  // Chowdeck needs a pickup address or location from the shop's profile.
  const pickup = shopPlace(shop);
  const canPickUp = Boolean(pickup.address) || pickup.lat != null;
  const courier = !canPickUp
    ? 'fez'
    : chooseCourier(
        { city: shop.address?.city, state: shop.address?.state ?? opts.pickUpState },
        { city: opts.dropoff.city, state: opts.dropoff.state }
      );

  if (courier === 'chowdeck') {
    try {
      const q = await getChowdeckQuote({
        pickup,
        dropoff: dropoffPlace(opts.dropoff),
        ...(opts.orderValueNaira ? { orderValueNaira: opts.orderValueNaira } : {}),
      });
      return { provider: 'chowdeck', totalCost: q.totalNaira, eta: 'Same day' };
    } catch (e) {
      console.warn('[courier] Chowdeck quote failed, using Fez:', (e as Error).message);
    }
  }

  // Only possible once Chowdeck is on: a route it can't take, and no Fez.
  if (!isFezConfigured())
    throw new FezError('Delivery is not available for this address yet.', 503);
  const pickUpState = opts.pickUpState ?? shop.address?.state;
  const fez = await getDeliveryCost({
    state: opts.dropoff.state,
    ...(pickUpState ? { pickUpState } : {}),
    ...(opts.weight != null ? { weight: opts.weight } : {}),
  });
  return { provider: 'fez', totalCost: fez.totalCost, fez };
}

/** Can any courier deliver? (Fez, or Chowdeck when the route qualifies.) */
export const anyCourierConfigured = (): boolean => isFezConfigured() || isChowdeckConfigured();

// ─── Delivery PIN ────────────────────────────────────────────

/** 4-digit PIN the rider asks for at handover (1000–9999). */
export const generateDeliveryPin = (): number => crypto.randomInt(1000, 10000);

// ─── One tracking format for both couriers ───────────────────

export type DeliveryStatus =
  | 'booked'
  | 'awaiting_pickup'
  | 'in_transit'
  | 'arrived'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  booked: 'Rider being assigned',
  awaiting_pickup: 'Rider on the way to the shop',
  in_transit: 'On the way',
  arrived: 'Rider has arrived',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  failed: 'Delivery failed',
};

/** How far along a status is (cancelled and failed are final). */
export const STATUS_RANK: Record<DeliveryStatus, number> = {
  booked: 1,
  awaiting_pickup: 2,
  in_transit: 3,
  arrived: 4,
  delivered: 5,
  cancelled: 6,
  failed: 6,
};

// TODO(chowdeck-q4): the docs list preparing, awaiting_pickup, in_transit,
// success and rejected for Relay, but also picked, arrived, completed and
// cancelled elsewhere. All are mapped until Chowdeck confirms which are used.
const CHOWDECK_STATUS: Record<string, DeliveryStatus> = {
  preparing: 'booked',
  accepted: 'booked',
  awaiting_pickup: 'awaiting_pickup',
  in_transit: 'in_transit',
  picked: 'in_transit',
  arrived: 'arrived',
  success: 'delivered',
  completed: 'delivered',
  rejected: 'cancelled',
  cancelled: 'cancelled',
  failed: 'failed',
};

// Webhook event names (Chowdeck's order events; see TODO(chowdeck-q5)).
const CHOWDECK_EVENT: Record<string, DeliveryStatus> = {
  ORDER_CREATED: 'booked',
  ORDER_ASSIGNED: 'awaiting_pickup',
  ORDER_AWAITING_PICKUP: 'awaiting_pickup',
  ORDER_PICKED_UP: 'in_transit',
  ORDER_ARRIVED_AT_CUSTOMER_LOCATION: 'arrived',
  ORDER_COMPLETE: 'delivered',
  ORDER_CANCELLED: 'cancelled',
};

export function normaliseChowdeckStatus(status: unknown): DeliveryStatus | null {
  return (
    CHOWDECK_STATUS[
      String(status ?? '')
        .toLowerCase()
        .trim()
    ] ?? null
  );
}

/** Fez's words, e.g. "Pending Pick-Up", "Dispatched", "Delivered", "Returned". */
export function normaliseFezStatus(status: unknown): DeliveryStatus {
  const s = String(status ?? '').toLowerCase();
  if (/deliver(ed)?\b/.test(s) && !/undeliver|not deliver/.test(s)) return 'delivered';
  if (/cancel/.test(s)) return 'cancelled';
  if (/return|fail|undeliver|not deliver/.test(s)) return 'failed';
  if (/arriv/.test(s)) return 'arrived';
  if (/dispatch|transit|picked|out for|en route|enroute|in progress/.test(s)) return 'in_transit';
  if (/pending|pick ?-?up|assign/.test(s)) return 'awaiting_pickup';
  return 'booked';
}

export interface TimelineEntry {
  status: DeliveryStatus | null;
  label: string;
  at: string | null;
}

export interface NormalisedTracking {
  provider: CourierProvider;
  status: DeliveryStatus;
  statusLabel: string;
  trackingUrl: string | null;
  rider: { name: string | null; phone: string | null } | null;
  timeline: TimelineEntry[];
  /** The courier's own response, kept while today's apps still read Fez's format. */
  raw: unknown;
}

export function normaliseChowdeckTracking(
  d: any,
  fallback?: { trackingUrl?: string | null }
): NormalisedTracking {
  const status = normaliseChowdeckStatus(d?.status) ?? 'booked';
  // TODO: Chowdeck's example has an empty `driver` object; the rider field
  // names are not documented. These are the likely names; confirm with Chowdeck.
  const drv = d?.driver ?? d?.rider ?? {};
  const riderName = drv.name || [drv.first_name, drv.last_name].filter(Boolean).join(' ') || null;
  const riderPhone = drv.phone || drv.phone_number || null;
  const timeline: TimelineEntry[] = (Array.isArray(d?.timeline) ? d.timeline : []).map(
    (t: any) => ({
      status: CHOWDECK_EVENT[String(t?.action ?? '')] ?? normaliseChowdeckStatus(t?.status),
      label: String(t?.description || t?.action || ''),
      at: t?.created_at ?? null,
    })
  );
  return {
    provider: 'chowdeck',
    status,
    statusLabel: STATUS_LABEL[status],
    trackingUrl: d?.tracking_url || fallback?.trackingUrl || null,
    rider: riderName || riderPhone ? { name: riderName, phone: riderPhone } : null,
    timeline,
    raw: d,
  };
}

export function normaliseFezTracking(raw: any): NormalisedTracking {
  const d = raw?.data ?? raw;
  const history: any[] = Array.isArray(d?.history) ? d.history : [];
  const last = history[history.length - 1];
  const current =
    d?.order?.orderStatus ?? d?.orderStatus ?? last?.orderStatus ?? last?.status ?? d?.status;
  const status = normaliseFezStatus(current);
  return {
    provider: 'fez',
    status,
    statusLabel: STATUS_LABEL[status],
    trackingUrl: null,
    rider:
      d?.order?.riderName || d?.riderName
        ? {
            name: d?.order?.riderName ?? d?.riderName ?? null,
            phone: d?.order?.riderPhone ?? d?.riderPhone ?? null,
          }
        : null,
    timeline: history.map(h => {
      const words = h?.orderStatus ?? h?.status ?? '';
      return {
        status: normaliseFezStatus(words),
        label: String(words),
        at: h?.statusCreationDate ?? h?.createdAt ?? h?.date ?? null,
      };
    }),
    raw,
  };
}

// ─── Webhook events ──────────────────────────────────────────

/**
 * The delivery reference and status in a Chowdeck webhook.
 * TODO(chowdeck-q5): Chowdeck's docs only describe ORDER_* events for food
 * orders ({ category, description, payload }). Until Relay's payload is
 * confirmed, this reads the reference and status from the likely places.
 */
export function parseChowdeckEvent(body: any): {
  reference: string | null;
  status: DeliveryStatus | null;
} {
  const p = body?.payload ?? body?.data ?? body ?? {};
  const reference = String(p?.reference ?? body?.reference ?? '').trim() || null;
  const status =
    normaliseChowdeckStatus(p?.status ?? body?.status) ??
    CHOWDECK_EVENT[String(body?.category ?? body?.event ?? '')] ??
    null;
  return { reference, status };
}

// ─── Cancellation ────────────────────────────────────────────

/** Before the rider picks it up, a Chowdeck delivery can be cancelled. */
export const cancellableChowdeckStatus = (s?: string | null) =>
  // TODO(chowdeck-q6): which statuses Chowdeck lets us cancel is not documented.
  !s || s === 'booked' || s === 'awaiting_pickup';

/**
 * Cancel a booked Chowdeck delivery for an order that was cancelled or
 * refunded. Returns what happened; never throws. A refusal (for example the
 * rider already picked it up) is flagged on the order for an admin.
 */
export async function cancelCourierBooking(
  order: any,
  reason: string
): Promise<'cancelled' | 'not_needed' | 'refused'> {
  if (order?.fulfilment !== 'chowdeck' || !order?.trackingNumber) return 'not_needed';
  if (!cancellableChowdeckStatus(order.deliveryStatus)) {
    await flag(
      order,
      `Chowdeck delivery ${order.trackingNumber} is ${order.deliveryStatus}; not cancelled automatically.`
    );
    return 'refused';
  }
  try {
    await cancelChowdeckDelivery(order.trackingNumber, reason);
    await setStatus(order, 'cancelled');
    return 'cancelled';
  } catch (e) {
    await flag(
      order,
      `Could not cancel Chowdeck delivery ${order.trackingNumber}: ${(e as Error).message}`
    );
    return 'refused';
  }
}

// Late imports keep this module free of model loading at import time.
async function setStatus(order: any, status: DeliveryStatus) {
  const { default: Order } = await import('@/models/order-model');
  await Order.updateOne(
    { _id: order._id },
    { $set: { deliveryStatus: status, deliveryUpdatedAt: new Date() } }
  );
}

async function flag(order: any, reason: string) {
  console.error(`🚩 [courier] order ${String(order._id)}: ${reason}`);
  const { default: Order } = await import('@/models/order-model');
  await Order.updateOne(
    { _id: order._id },
    { $set: { adminFlag: { reason, at: new Date() } } }
  ).catch(() => undefined);
}
