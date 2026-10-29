/**
 * Words for a shop's page, built only from stored facts. Missing facts are
 * left out, never guessed. Plain English, no em dashes.
 */
import { SEO_CONFIG } from './config';
import { publicLocation, shortPlace, type LocatedShop } from './location';

export interface DescribableShop extends LocatedShop {
  businessName?: string | null;
  about?: string | null;
  category?: string | null;
}

const clean = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** "Tunde Boots sells shoes in Ora East, Lagos. 12 products on URA." */
export function generatedDescription(shop: DescribableShop, visibleProducts: number): string {
  const name = clean(shop.businessName) || 'This shop';
  const category = clean(shop.category).toLowerCase();
  const place = shortPlace(publicLocation(shop));
  let first: string;
  if (category && place) first = `${name} sells ${category} in ${place}.`;
  else if (category) first = `${name} sells ${category}.`;
  else if (place) first = `${name} is a shop in ${place}.`;
  else first = `${name} is a shop on URA.`;
  const count =
    visibleProducts > 0
      ? ` ${visibleProducts} product${visibleProducts === 1 ? '' : 's'} on URA.`
      : '';
  return `${first}${count}`;
}

/** The shop's own About when it has one; otherwise the generated line. */
export function shopDescription(shop: DescribableShop, visibleProducts: number): string {
  return clean(shop.about) || generatedDescription(shop, visibleProducts);
}

/** About 155 characters, cut at a word, for the meta description. */
export function metaDescription(
  text: string,
  max: number = SEO_CONFIG.metaDescriptionChars
): string {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(max * 0.6)));
  return `${atWord.replace(/[\s,.;:]+$/, '')}…`;
}
