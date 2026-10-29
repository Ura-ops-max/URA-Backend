/** Page titles. Missing parts are left out. */
export const naira = (n: number) => `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;

/** "Tunde Boots | Shoes in Ora East, Ikeja | URA" / "Tunde Boots | Shoes | URA" / "Tunde Boots | URA". */
export function shopTitle(name: string, category?: string | null, place?: string | null): string {
  const c = String(category ?? '').trim();
  const p = String(place ?? '').trim();
  const middle = c && p ? `${c} in ${p}` : c || p;
  return [name.trim(), middle, 'URA'].filter(Boolean).join(' | ');
}

/** "Chelsea Boot, ₦25,000 | Tunde Boots in Ikeja | URA" (missing parts left out). */
export function productTitle(
  name: string,
  price?: number | null,
  shopName?: string | null,
  city?: string | null
): string {
  const first = Number(price) > 0 ? `${name.trim()}, ${naira(Number(price))}` : name.trim();
  const s = String(shopName ?? '').trim();
  const c = String(city ?? '').trim();
  const second = s && c ? `${s} in ${c}` : s;
  return [first, second, 'URA'].filter(Boolean).join(' | ');
}
