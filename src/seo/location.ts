/**
 * Where a shop is, as shown to the public. Uses only what is already stored.
 * Rule: show area, city and state. Show the street address only when the
 * shop has a physical store AND chose to show it. Never the home address or
 * the map position otherwise.
 */
export interface LocatedShop {
  area?: string | null;
  address?: {
    street?: string | null;
    city?: string | null;
    state?: string | null;
    fullAddress?: string | null;
  } | null;
  hasPhysicalStore?: boolean | null;
  showStreetAddress?: boolean | null;
}

const clean = (v: unknown) => String(v ?? '').trim();

/** May the street address be shown? Both switches must be on. */
export const streetAllowed = (b: LocatedShop) =>
  b.hasPhysicalStore === true && b.showStreetAddress === true;

export interface PublicLocation {
  area: string | null;
  city: string | null;
  state: string | null;
  /** Only when the display rule allows it. */
  street: string | null;
  /** "Ora East, Ikeja, Lagos" (missing parts left out, no repeats). */
  text: string | null;
}

export function publicLocation(b: LocatedShop): PublicLocation {
  const area = clean(b.area) || null;
  const city = clean(b.address?.city) || null;
  const state = clean(b.address?.state) || null;
  const street = streetAllowed(b)
    ? clean(b.address?.fullAddress) || clean(b.address?.street) || null
    : null;
  const parts: string[] = [];
  for (const p of [area, city, state]) {
    if (p && !parts.some(x => x.toLowerCase() === p.toLowerCase())) parts.push(p);
  }
  return { area, city, state, street, text: parts.length ? parts.join(', ') : null };
}

/** "Ora East, Ikeja" for titles: area and city (or state when no city). */
export function shortPlace(loc: PublicLocation): string | null {
  const parts: string[] = [];
  for (const p of [loc.area, loc.city ?? loc.state]) {
    if (p && !parts.some(x => x.toLowerCase() === p.toLowerCase())) parts.push(p);
  }
  return parts.length ? parts.join(', ') : null;
}
