
import 'dotenv/config';
import mongoose from 'mongoose';
import { Product } from '@/models/product-model';
import { embedImageUrl, isEmbedConfigured } from '@/services/ai-embed.service';

async function main() {
  console.log('\n=== AI IMAGE SEARCH DIAGNOSTIC ===\n');

  // ── 1. Embed service ──────────────────────────────────────────────
  console.log('1) Embedding service (AI_EMBED_URL)');
  if (!isEmbedConfigured()) {
    console.log('   ✗ AI_EMBED_URL is NOT set. Add it to .env and restart. Aborting.\n');
    process.exit(1);
  }
  console.log(`   AI_EMBED_URL = ${process.env.AI_EMBED_URL}`);

  const uri = process.env.MONGODB_URI;
  if (!uri) { console.log('   ✗ MONGODB_URI not set. Aborting.\n'); process.exit(1); }
  await mongoose.connect(uri, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {});
  console.log('   Connected to MongoDB.');

  // Grab a real product image to embed as our test query.
  const sample = await Product.findOne({ 'media.0': { $exists: true } })
    .select('_id name media')
    .lean();
  if (!sample) {
    console.log('   ✗ No products with media found — nothing to test. Aborting.\n');
    process.exit(1);
  }
  const sampleUrl = (sample as any).media[0];
  console.log(`   Test image: ${sampleUrl}`);

  const vec = await embedImageUrl(sampleUrl);
  if (!vec) {
    console.log('   ✗ Embed call FAILED (returned null). The Lambda is unreachable or rejected the image.');
    console.log('     → Fix the embed endpoint first; nothing downstream can work.\n');
    process.exit(1);
  }
  console.log(`   ✓ Embed OK — got a ${vec.length}-dim vector.\n`);

  // ── 2. Embedding coverage ─────────────────────────────────────────
  console.log('2) Product embedding coverage');
  const total = await Product.countDocuments({});
  const withEmbedding = await Product.countDocuments({ imageEmbedding: { $exists: true, $ne: null } });
  console.log(`   Products total:            ${total}`);
  console.log(`   With imageEmbedding:       ${withEmbedding}`);
  if (withEmbedding === 0) {
    console.log('   ✗ NO products are embedded. Run the backfill:');
    console.log('        npx ts-node src/scripts/backfill-image-embeddings.ts');
    console.log('     Image search returns nothing until this is done.\n');
  } else if (withEmbedding < total) {
    console.log(`   ⚠ ${total - withEmbedding} product(s) not yet embedded — run the backfill to cover them.\n`);
  } else {
    console.log('   ✓ All products are embedded.\n');
  }

  // ── 3. Vector search ──────────────────────────────────────────────
  console.log('3) Atlas $vectorSearch (index: product_image_index)');
  try {
    const results = await Product.aggregate([
      {
        $vectorSearch: {
          index: 'product_image_index',
          path: 'imageEmbedding',
          queryVector: vec,
          numCandidates: 100,
          limit: 5,
        },
      },
      { $project: { name: 1, score: { $meta: 'vectorSearchScore' } } },
    ]);
    if (results.length === 0) {
      console.log('   ⚠ Query ran but returned 0 hits.');
      console.log('     Usually means the index is still building, or no embeddings exist yet.');
    } else {
      console.log(`   ✓ Vector search returned ${results.length} hit(s):`);
      results.forEach((r: any) => console.log(`       ${r.score?.toFixed(4)}  ${r.name}`));
    }
  } catch (err: any) {
    console.log('   ✗ Vector search FAILED:', err?.message || err);
    console.log('     Likely the Atlas index "product_image_index" does not exist or is not ACTIVE.');
    console.log('     → In Atlas: Search → Create Search Index → JSON editor → vectorSearch,');
    console.log('       field "imageEmbedding", 1024 dimensions, similarity "cosine".');
  }

  console.log('\n=== DONE ===\n');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
