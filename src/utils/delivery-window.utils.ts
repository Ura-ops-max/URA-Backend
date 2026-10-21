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
