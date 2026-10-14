import { Product, VISIBLE_PRODUCT } from '@/models/product-model';

/**
 * What a shop page may show. The owner gets everything; anyone else gets no
 * follower/like id lists and no loan eligibility.
 */
export function publicBusiness(business: any, isOwner: boolean): Record<string, unknown> {
  const obj = typeof business?.toObject === 'function' ? business.toObject() : { ...business };
  if (!isOwner) {
    delete obj.followers;
    delete obj.likes;
    delete obj.loanEligibility;
  }
  delete obj.descriptionVector;
  return obj;
}

/** Products a shopper can see in this shop (switched-off ones aren't counted). */
export const countShopProducts = (businessId: unknown): Promise<number> =>
  Product.countDocuments({ business: businessId, ...VISIBLE_PRODUCT });
