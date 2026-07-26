import axios from 'axios';

/**
 * Thin client for the embedding Lambda (AI_EMBED_URL).
 * POST { type: "text" | "image", input: <text | image URL> } → { embedding: number[1024] }.
 * The Lambda only COMPUTES vectors; we store them ourselves (Product.imageEmbedding)
 * and query via Atlas $vectorSearch.
 */

const EMBED_URL = process.env.AI_EMBED_URL || '';

export const isEmbedConfigured = (): boolean => Boolean(EMBED_URL);

async function embed(type: 'text' | 'image', input: string): Promise<number[] | null> {
  if (!EMBED_URL || !input) return null;
  // Retry a few times — the embed Lambda occasionally returns transient 5xx
  // (cold start / image fetch hiccup). A short backoff clears most of them.
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const { data } = await axios.post(
        EMBED_URL,
        { type, input },
        { timeout: 20_000, headers: { 'content-type': 'application/json' } },
      );
      const vec = data?.embedding;
      if (Array.isArray(vec) && vec.length) return vec as number[];
      return null; // valid response but no vector — retrying won't help
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[ai-embed] ${type} embed attempt ${i}/${attempts} failed:`, msg);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  return null;
}

/** Embed an image by its public URL (product media lives on public S3). */
export const embedImageUrl = (url: string): Promise<number[] | null> => embed('image', url);

/** Embed a free-text query (unused for now, handy for hybrid search later). */
export const embedText = (text: string): Promise<number[] | null> => embed('text', text);
