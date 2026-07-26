/**
 * One-off: embed every existing product's first image so it becomes searchable.
 * Run on the server:  npx ts-node src/scripts/backfill-image-embeddings.ts
 *
 * Safe to re-run — it only processes products that don't have an embedding yet
 * (pass `--all` to re-embed everything).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Product } from '@/models/product-model';
import { embedImageUrl, isEmbedConfigured } from '@/services/ai-embed.service';

async function main() {
  if (!isEmbedConfigured()) {
    console.error('AI_EMBED_URL is not set — aborting.');
    process.exit(1);
  }

  const all = process.argv.includes('--all');
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set — aborting.'); process.exit(1); }
  await mongoose.connect(uri, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {});
  console.log('Connected to MongoDB');

  const query = all ? {} : { imageEmbedding: { $exists: false } };
  const products = await Product.find(query).select('_id name media').lean();
  console.log(`Found ${products.length} product(s) to index.`);

  let ok = 0;
  let skipped = 0;
  for (const p of products) {
    const url = (p as any).media?.[0];
    if (!url) { skipped++; continue; }
    const embedding = await embedImageUrl(url);
    if (embedding) {
      await Product.updateOne({ _id: p._id }, { $set: { imageEmbedding: embedding } });
      ok++;
      console.log(`  ✓ ${p.name} (${p._id})`);
    } else {
      skipped++;
      console.log(`  ✗ ${p.name} (${p._id}) — embed failed`);
    }
  }

  console.log(`\nDone. Indexed ${ok}, skipped ${skipped}.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
