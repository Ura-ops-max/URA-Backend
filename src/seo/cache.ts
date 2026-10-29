/**
 * Built pages, kept for about an hour. Cleared for a shop when the shop or
 * one of its products changes (model hooks call invalidateSeoForBusiness).
 * No imports, so models can use it without import loops.
 */
interface Entry<T> {
  at: number;
  value: T;
  tags: string[];
}

const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 5_000;

export function seoCacheGet<T>(key: string, ttlSeconds: number): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlSeconds * 1000) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function seoCacheSet<T>(key: string, value: T, tags: string[] = []): void {
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
  store.set(key, { at: Date.now(), value, tags });
}

/** Forget every cached page that shows this shop (and the sitemaps). */
export function invalidateSeoForBusiness(businessId: unknown): void {
  const id = String(businessId ?? '');
  for (const [key, entry] of store) {
    if ((id && entry.tags.includes(id)) || entry.tags.includes('sitemap')) store.delete(key);
  }
}

export function clearSeoCache(): void {
  store.clear();
}
