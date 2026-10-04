/**
 * One-off: assign a slug to every existing business that doesn't have one yet,
 * so every business gets a public URL (ura.com.ng/<slug>).
 * Run on the server:  npx ts-node src/scripts/backfill-business-slugs.ts
 *
 * Safe to re-run — it only touches businesses with no slug. The actual slug
 * generation happens in the Business model's pre-save hook, so this script
 * just needs to call .save() on each one.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Business } from '@/models/business-model';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set — aborting.'); process.exit(1); }
  await mongoose.connect(uri, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {});
  console.log('Connected to MongoDB');

  const businesses = await Business.find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] });
  console.log(`Found ${businesses.length} business(es) without a slug.`);

  let ok = 0;
  for (const b of businesses) {
    await b.save(); // pre-save hook assigns a unique slug from businessName
    console.log(`  ✓ ${b.businessName} → ${b.slug}`);
    ok++;
  }

  console.log(`\nDone. Assigned ${ok} slug(s).`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
