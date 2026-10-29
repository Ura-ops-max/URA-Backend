/**
 * Structured data (schema.org JSON-LD) for shop and product pages, from one
 * module so other uses (for example AI assistants) can reuse it.
 *
 * Only stored facts: missing fields are left out, never invented. The street
 * address only by the display rule; the phone only because shop pages
 * already show it; ratings only from real reviews (totalReviews > 0).
 */
import { publicLocation } from './location';

export type JsonLd = Record<string, unknown>;

const DAY = {
  Monday: 'Mo',
  Tuesday: 'Tu',
  Wednesday: 'We',
  Thursday: 'Th',
  Friday: 'Fr',
  Saturday: 'Sa',
  Sunday: 'Su',
} as const;
const TIME = /^\d{1,2}:\d{2}$/;

/** "Mo 09:00-17:00" for each open day with real times. */
export function openingHours(
  hours: { day?: string; open?: string; close?: string; isClosed?: boolean }[] = []
): string[] {
  return hours
    .filter(
      h =>
        !h.isClosed &&
        TIME.test(String(h.open)) &&
        TIME.test(String(h.close)) &&
        h.day &&
        h.day in DAY
    )
    .map(h => `${DAY[h.day as keyof typeof DAY]} ${h.open}-${h.close}`);
}

const SERVICE_WORDS =
  /servic|salon|barb|repair|clean|laundr|tailor|photo|event|consult|logistic|deliver|spa\b|make ?up|plumb|electric|mechanic|tutor|lesson|design|print/i;

/** Sells products (Store), offers a service (Service vendor) or neither (LocalBusiness). */
export function shopKind(
  category: string | null | undefined,
  visibleProducts: number
): 'Store' | 'Service' | 'LocalBusiness' {
  if (visibleProducts > 0) return 'Store';
  if (SERVICE_WORDS.test(String(category ?? ''))) return 'Service';
  return 'LocalBusiness';
}

const compact = (o: JsonLd): JsonLd =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
    )
  );

export interface ShopForLd {
  businessName: string;
  category?: string | null;
  businessLogo?: string | null;
  businessCover?: string | null;
  contact?: { phone?: string | null } | null;
  operatingHours?: any[];
  averageRating?: number | null;
  totalReviews?: number | null;
  area?: string | null;
  address?: any;
  hasPhysicalStore?: boolean | null;
  showStreetAddress?: boolean | null;
}

export function shopJsonLd(
  shop: ShopForLd,
  opts: { url: string; description: string; visibleProducts: number }
): JsonLd[] {
  const loc = publicLocation(shop);
  const kind = shopKind(shop.category, opts.visibleProducts);
  const id = `${opts.url}#shop`;
  const address =
    loc.city || loc.state || loc.street
      ? compact({
          '@type': 'PostalAddress',
          streetAddress: loc.street ?? undefined,
          addressLocality: loc.city ?? undefined,
          addressRegion: loc.state ?? undefined,
          addressCountry: 'NG',
        })
      : undefined;
  const rating =
    Number(shop.totalReviews) > 0 && Number(shop.averageRating) > 0
      ? {
          '@type': 'AggregateRating',
          ratingValue: Number(shop.averageRating),
          reviewCount: Number(shop.totalReviews),
        }
      : undefined;

  const business = compact({
    '@context': 'https://schema.org',
    '@type': kind === 'Store' ? 'Store' : 'LocalBusiness',
    '@id': id,
    name: shop.businessName,
    url: opts.url,
    image: shop.businessCover || shop.businessLogo || undefined,
    logo: shop.businessLogo || undefined,
    description: opts.description,
    areaServed: loc.text ?? undefined,
    address,
    telephone: shop.contact?.phone || undefined,
    openingHours: openingHours(shop.operatingHours),
    aggregateRating: rating,
  });

  if (kind !== 'Service') return [business];
  return [
    business,
    compact({
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: shop.category ? `${shop.category} by ${shop.businessName}` : shop.businessName,
      serviceType: shop.category || undefined,
      provider: { '@id': id },
      areaServed: loc.text ?? undefined,
      url: opts.url,
    }),
  ];
}

export interface ProductForLd {
  name: string;
  description?: string | null;
  media?: string[];
  price?: number | null;
  stock?: number | null;
  sku?: string | null;
}

export function productJsonLd(
  product: ProductForLd,
  opts: { url: string; shopUrl: string; shopName: string; description: string }
): JsonLd {
  const price = Number(product.price);
  return compact({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    url: opts.url,
    image: (product.media ?? []).filter(
      m => /^https?:\/\//.test(m) && !/\.(mp4|mov|webm)(\?|$)/i.test(m)
    ),
    description: opts.description || undefined,
    sku: product.sku || undefined,
    offers:
      price > 0
        ? {
            '@type': 'Offer',
            price,
            priceCurrency: 'NGN',
            availability:
              Number(product.stock) > 0
                ? 'https://schema.org/InStock'
                : 'https://schema.org/OutOfStock',
            url: opts.url,
            seller: { '@type': 'Organization', '@id': `${opts.shopUrl}#shop`, name: opts.shopName },
          }
        : undefined,
  });
}

/** Safe inside <script>: no "</script>" can end it early. */
export const ldScript = (data: JsonLd | JsonLd[]): string =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
