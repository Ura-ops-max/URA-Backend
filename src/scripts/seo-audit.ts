/**
 * Read-only audit of shop and product data for Google visibility.
 * Changes nothing. Run on the server (it reads MONGODB_URI from .env there):
 *   bun run src/scripts/seo-audit.ts
 *
 * Prints counts with the exact fields checked:
 *   shops: total; no `slug`; no `about`; no `address.city` or `address.state`;
 *   no `businessLogo`; no visible products (Product `isHidden` != true)
 *   products: total; visible; no `media[0]`; no `price` (missing or 0)
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Business } from '@/models/business-model';
import { Product, VISIBLE_PRODUCT } from '@/models/product-model';

const empty = (field: string) => ({
  $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }],
});

export async function auditCounts() {
  const visibleCounts = await Product.aggregate([
    { $match: VISIBLE_PRODUCT },
    { $group: { _id: '$business', n: { $sum: 1 } } },
  ]);
  const withProducts = new Set(visibleCounts.map(r => String(r._id)));
  const shopIds = (await Business.find({}).select('_id').lean()).map(b => String(b._id));

  return {
    shops: {
      total: shopIds.length,
      noSlug: await Business.countDocuments(empty('slug')),
      noAbout: await Business.countDocuments(empty('about')),
      noCityOrState: await Business.countDocuments({
        $or: [empty('address.city'), empty('address.state')],
      }),
      noCity: await Business.countDocuments(empty('address.city')),
      noState: await Business.countDocuments(empty('address.state')),
      noLogo: await Business.countDocuments(empty('businessLogo')),
      noVisibleProducts: shopIds.filter(id => !withProducts.has(id)).length,
    },
    products: {
      total: await Product.countDocuments({}),
      visible: await Product.countDocuments(VISIBLE_PRODUCT),
      noPhoto: await Product.countDocuments({
        $or: [{ media: { $exists: false } }, { media: { $size: 0 } }],
      }),
      noPrice: await Product.countDocuments({
        $or: [{ price: { $exists: false } }, { price: null }, { price: { $lte: 0 } }],
      }),
    },
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Run this on the server.');
    process.exit(1);
  }
  await mongoose.connect(uri, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {});
  const r = await auditCounts();
  console.log(JSON.stringify(r, null, 2));
  if (r.shops.noSlug > 0) {
    console.log(
      `\n${r.shops.noSlug} shop(s) have no slug. To fix (safe to re-run): npx ts-node src/scripts/backfill-business-slugs.ts`
    );
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
