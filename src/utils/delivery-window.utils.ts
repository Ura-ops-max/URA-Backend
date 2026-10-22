/**
 * The product form allows "weeks", but Payluk only takes minutes, hours or days
 * (1 to 365 units). Convert to something Payluk accepts.
 */
export function toPaylukDeliveryWindow(
  maxDelivery: unknown,
  timeline: unknown
): { maxDelivery: number; deliveryTimeline: 'minutes' | 'hours' | 'days' } {
  let n = Math.round(Number(maxDelivery) || 3);
  let unit = String(timeline || 'days');
  if (unit === 'weeks') {
    n *= 7;
    unit = 'days';
  }
  if (!['minutes', 'hours', 'days'].includes(unit)) unit = 'days';
  return {
    maxDelivery: Math.min(365, Math.max(1, n)),
    deliveryTimeline: unit as 'minutes' | 'hours' | 'days',
  };
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** The same window as above, in milliseconds. */
export function deliveryWindowMs(maxDelivery: unknown, timeline: unknown): number {
  const w = toPaylukDeliveryWindow(maxDelivery, timeline);
  return w.maxDelivery * UNIT_MS[w.deliveryTimeline];
}
