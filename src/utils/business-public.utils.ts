import { Product, VISIBLE_PRODUCT } from '@/models/product-model';
import { publicLocation, streetAllowed } from '@/seo/location';

/**
 * What a shop page may show. The owner gets everything; anyone else gets no
 * follower/like id lists, no loan eligibility, and no street address or map
 * position unless the shop has a physical store and chose to show it (most
 * vendors sell from home). `publicLocation` is what to display.
 */
export function publicBusiness(business: any, isOwner: boolean): Record<string, unknown> {
  const obj = typeof business?.toObject === 'function' ? business.toObject() : { ...business };
  if (!isOwner) {
    delete obj.followers;
    delete obj.likes;
    delete obj.loanEligibility;
    delete obj.googleReadyNotifiedAt;
    if (!streetAllowed(obj)) {
      if (obj.address) {
        obj.address = {
          city: obj.address.city,
          state: obj.address.state,
          country: obj.address.country,
        };
      }
      delete obj.location;
    }
  }
  delete obj.descriptionVector;
  obj.publicLocation = publicLocation(obj);
  return obj;
}

/** Products a shopper can see in this shop (switched-off ones aren't counted). */
export const countShopProducts = (businessId: unknown): Promise<number> =>
  Product.countDocuments({ business: businessId, ...VISIBLE_PRODUCT });
