/**
 * Chowdeck delivery events (POST /api/v1/webhooks/chowdeck).
 * Updates the order's courier status once per status (Chowdeck retries, and
 * events can arrive out of order), and tells the buyer and seller.
 * "Delivered" does NOT complete the order or release escrow: the buyer still
 * confirms receipt.
 */
import crypto from 'crypto';
import Order from '@/models/order-model';
import { notifyOrderEvent, type OrderEvent } from '@/services/order-events.service';
import { STATUS_RANK, type DeliveryStatus } from '@/services/courier.service';

/** Constant-time check of x-chowdeck-signature (hex HMAC-SHA256 of the raw body). */
export function verifyChowdeckSignature(
  rawBody: Buffer | undefined,
  signature: string,
  secret: string
): boolean {
  if (!rawBody || !secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

const NOTICE: Partial<Record<DeliveryStatus, OrderEvent>> = {
  awaiting_pickup: 'RIDER_ASSIGNED',
  in_transit: 'RIDER_PICKED_UP',
  arrived: 'RIDER_ARRIVED',
  delivered: 'COURIER_DELIVERED',
  cancelled: 'COURIER_FAILED',
  failed: 'COURIER_FAILED',
};

/** Statuses an order may move FROM to reach `next` (never backwards). */
function earlierThan(next: DeliveryStatus): (string | null)[] {
  const all = Object.keys(STATUS_RANK) as DeliveryStatus[];
  const earlier = all.filter(s => STATUS_RANK[s] < STATUS_RANK[next]);
  return [null, ...earlier];
}

export type ApplyResult = 'applied' | 'duplicate' | 'unknown_order' | 'ignored';

export async function applyChowdeckEvent(event: {
  reference: string | null;
  status: DeliveryStatus | null;
}): Promise<ApplyResult> {
  if (!event.reference || !event.status) return 'ignored';
  const match = {
    fulfilment: 'chowdeck',
    $or: [{ trackingNumber: event.reference }, { orderNumber: event.reference }],
  };
  // Atomic: only the first delivery of this status (or a later one) changes it.
  const updated = await Order.findOneAndUpdate(
    { ...match, deliveryStatus: { $in: earlierThan(event.status) } },
    { $set: { deliveryStatus: event.status, deliveryUpdatedAt: new Date() } },
    { new: true }
  );
  if (!updated) return (await Order.exists(match)) ? 'duplicate' : 'unknown_order';

  const notice = NOTICE[event.status];
  if (notice) notifyOrderEvent(updated, notice).catch(() => {});
  return 'applied';
}
