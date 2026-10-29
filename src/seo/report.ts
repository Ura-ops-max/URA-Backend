/** Read-only readiness report: total, Ready, Not Ready, top reasons. */
import { REASON_TEXT, type NotReadyReason } from './readiness';
import { shopsWithReadiness } from './shop-data';

export async function readinessReport() {
  const all = await shopsWithReadiness();
  const counts = new Map<NotReadyReason, number>();
  for (const r of all)
    if (!r.ready) for (const why of r.reasons) counts.set(why, (counts.get(why) ?? 0) + 1);
  const ready = all.filter(r => r.ready).length;
  return {
    total: all.length,
    ready,
    notReady: all.length - ready,
    topReasons: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, shops]) => ({ reason, text: REASON_TEXT[reason], shops })),
    noSlug: all.filter(r => !r.shop.slug).length,
  };
}
