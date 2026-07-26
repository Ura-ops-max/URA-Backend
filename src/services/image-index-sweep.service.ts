/**
 * Auto catch-up for image search.
 * ---------------------------------
 * New products embed on create/edit, but an embed can occasionally fail (a
 * transient Lambda 5xx, an image not yet reachable, etc.). This sweep runs on a
 * timer and embeds any product still missing an `imageEmbedding`, so a newly
 * onboarded business's products always become searchable — nothing is left out.
 */
import { Product } from '@/models/product-model';
import { embedImageUrl, isEmbedConfigured } from '@/services/ai-embed.service';

// Keep each run small so it never competes with live traffic.
const BATCH = 10;
const INTERVAL_MS = 5 * 60_000; // every 5 minutes
const FIRST_RUN_DELAY_MS = 60_000; // wait a minute after boot

let running = false;

async function sweepOnce(): Promise<void> {
  if (running) return; // don't overlap runs
  running = true;
  try {
    const products = await Product.find({
      imageEmbedding: { $exists: false },
      'media.0': { $exists: true },
    })
      .select('_id name media')
      .limit(BATCH)
      .lean();

    if (products.length === 0) return;

    let ok = 0;
    for (const p of products) {
      const url = (p as any).media?.[0];
      const embedding = await embedImageUrl(url);
      if (embedding) {
        await Product.updateOne({ _id: p._id }, { $set: { imageEmbedding: embedding } });
        ok++;
      }
    }
    if (ok) console.log(`🔎 [image-sweep] embedded ${ok}/${products.length} product(s)`);
  } catch (err) {
    console.error('[image-sweep] run failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

/** Start the periodic catch-up. Call once on server boot. */
export function startImageIndexSweep(): void {
  if (!isEmbedConfigured()) {
    console.log('[image-sweep] AI_EMBED_URL not set — sweep disabled.');
    return;
  }
  setTimeout(() => {
    void sweepOnce();
    setInterval(() => void sweepOnce(), INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log('[image-sweep] scheduled — catches any un-embedded products every 5 min.');
}
