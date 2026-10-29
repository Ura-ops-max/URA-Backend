/**
 * Which site paths the page-builder answers, and the product URL shape.
 *   /<slug>                         shop page
 *   /<slug>/p/<productId>-<name>    product page
 * Everything else (app pages, /api, files with a dot) is passed through.
 */
import { RESERVED_SLUGS } from '@/models/business-model';

export type SitePath =
  | { kind: 'shop'; slug: string }
  | { kind: 'product'; slug: string; id: string; nameSlug: string }
  | { kind: 'app' };

/** "Chelsea Boot (Brown)" to "chelsea-boot-brown". */
export function slugifyName(name: unknown): string {
  return (
    String(name ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'item'
  );
}

export const productPath = (shopSlug: string, product: { _id: unknown; name?: string }) =>
  `/${shopSlug}/p/${String(product._id)}-${slugifyName(product.name)}`;

const SLUG = /^[a-z0-9-]{1,80}$/;

export function parseSitePath(raw: string): SitePath {
  let path = String(raw ?? '').split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return { kind: 'app' };
  }
  if (!path.startsWith('/')) return { kind: 'app' };
  const seg = path.split('/').filter(Boolean);
  if (!seg.length || seg.some(s => s.includes('.'))) return { kind: 'app' };
  const slug = seg[0].toLowerCase();
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) return { kind: 'app' };
  if (seg.length === 1) return { kind: 'shop', slug };
  if (seg.length === 3 && seg[1] === 'p') {
    const m = /^([0-9a-f]{24})(?:-(.*))?$/i.exec(seg[2]);
    if (m) return { kind: 'product', slug, id: m[1].toLowerCase(), nameSlug: m[2] ?? '' };
    return { kind: 'app' };
  }
  return { kind: 'app' };
}
