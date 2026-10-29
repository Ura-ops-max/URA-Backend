/**
 * Loads shops with their visible product counts and readiness. Shared by the
 * readiness job, the admin report, the sitemap and the owner's "Google
 * ready" bar, so they always agree.
 */
import { Business } from '@/models/business-model';
import { Product, VISIBLE_PRODUCT } from '@/models/product-model';
import { computeReadiness, type Readiness } from './readiness';

export const READINESS_FIELDS =
  '_id owner slug businessName about category area showOnGoogle googleReadyNotifiedAt updatedAt address.city address.state';

/** Visible products per shop id. */
export async function visibleProductCounts(businessIds?: unknown[]): Promise<Map<string, number>> {
  const match: Record<string, unknown> = { ...VISIBLE_PRODUCT };
  if (businessIds) match.business = { $in: businessIds };
  const rows = await Product.aggregate([
    { $match: match },
    { $group: { _id: '$business', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n as number]));
}

export interface ShopReadiness extends Readiness {
  shop: any;
  visibleProducts: number;
}

/** Shops (all, or those matching `filter`) with their readiness. */
export async function shopsWithReadiness(
  filter: Record<string, unknown> = {}
): Promise<ShopReadiness[]> {
  const shops = await Business.find(filter).select(READINESS_FIELDS).lean();
  const counts = await visibleProductCounts(shops.map(s => s._id));
  return shops.map(shop => {
    const visibleProducts = counts.get(String(shop._id)) ?? 0;
    return { shop, visibleProducts, ...computeReadiness(shop as any, visibleProducts) };
  });
}
