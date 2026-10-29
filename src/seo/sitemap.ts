/**
 * /sitemap.xml is a sitemap index. Its children (/sitemaps/<name>.xml):
 *   pages-1       the public site pages
 *   shops-N       Google-ready shops
 *   products-N    visible products of Google-ready shops
 * At most SEO_CONFIG.sitemapUrlsPerFile URLs per file. lastmod only from a
 * real content edit (contentUpdatedAt); left out when unknown.
 */
import { Product, VISIBLE_PRODUCT } from '@/models/product-model';
import { Business } from '@/models/business-model';
import { SEO_CONFIG, siteUrl } from './config';
import { seoCacheGet, seoCacheSet } from './cache';
import { esc } from './html';
import { productPath } from './paths';
import { shopsWithReadiness } from './shop-data';

const STATIC_PAGES = ['/', '/products', '/about', '/contact', '/faq', '/terms', '/privacy'];

const day = (d?: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function urlset(rows: { loc: string; lastmod?: string | null }[]): string {
  const body = rows
    .map(
      r =>
        `<url><loc>${esc(r.loc)}</loc>${r.lastmod ? `<lastmod>${r.lastmod}</lastmod>` : ''}</url>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

async function readyShops() {
  return (await shopsWithReadiness())
    .filter(r => r.ready && r.shop.slug)
    .sort((a, b) => String(a.shop._id).localeCompare(String(b.shop._id)));
}

async function readyShopIds() {
  return (await readyShops()).map(r => r.shop._id);
}

/** XML for a sitemap file ('index', 'pages-1', 'shops-N', 'products-N'), or null if there is none. */
async function build(file: string): Promise<string | null> {
  const per = SEO_CONFIG.sitemapUrlsPerFile;
  const site = siteUrl();

  if (file === 'index') {
    const shopCount = (await readyShops()).length;
    const productCount = await Product.countDocuments({
      ...VISIBLE_PRODUCT,
      business: { $in: await readyShopIds() },
    });
    const names = ['pages-1'];
    for (let i = 1; i <= Math.max(1, Math.ceil(shopCount / per)); i++) names.push(`shops-${i}`);
    for (let i = 1; i <= Math.ceil(productCount / per); i++) names.push(`products-${i}`);
    const body = names
      .map(n => `<sitemap><loc>${esc(`${site}/sitemaps/${n}.xml`)}</loc></sitemap>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</sitemapindex>`;
  }

  if (file === 'pages-1') return urlset(STATIC_PAGES.map(p => ({ loc: `${site}${p}` })));

  const m = /^(shops|products)-(\d{1,4})$/.exec(file);
  if (!m) return null;
  const page = Number(m[2]);
  if (page < 1) return null;

  if (m[1] === 'shops') {
    const shops = (await readyShops()).slice((page - 1) * per, page * per);
    if (!shops.length && page > 1) return null;
    const edits = new Map(
      (
        await Business.find({ _id: { $in: shops.map(s => s.shop._id) } })
          .select('contentUpdatedAt')
          .lean()
      ).map(b => [String(b._id), (b as any).contentUpdatedAt])
    );
    return urlset(
      shops.map(s => ({
        loc: `${site}/${s.shop.slug}`,
        lastmod: day(edits.get(String(s.shop._id))),
      }))
    );
  }

  const ready = await readyShops();
  const slugOf = new Map(ready.map(r => [String(r.shop._id), r.shop.slug as string]));
  const products = await Product.find({
    ...VISIBLE_PRODUCT,
    business: { $in: ready.map(r => r.shop._id) },
  })
    .sort({ _id: 1 })
    .skip((page - 1) * per)
    .limit(per)
    .select('_id name business contentUpdatedAt')
    .lean();
  if (!products.length) return null;
  return urlset(
    products.map(p => ({
      loc: `${site}${productPath(slugOf.get(String(p.business))!, p)}`,
      lastmod: day((p as any).contentUpdatedAt),
    }))
  );
}

/** Cached about 1 hour; cleared when any shop or product changes. */
export async function sitemapXml(file: string): Promise<string | null> {
  const key = `sitemap:${file}`;
  const hit = seoCacheGet<string | null>(key, SEO_CONFIG.sitemapCacheSeconds);
  if (hit !== undefined) return hit;
  const xml = await build(file);
  seoCacheSet(key, xml, ['sitemap']);
  return xml;
}

/** robots.txt: public pages allowed; private app areas and the API blocked. */
export function robotsTxt(): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /dashboard',
    'Disallow: /auth/',
    'Disallow: /payment-complete',
    'Disallow: /payments/',
    'Disallow: /checkout',
    'Disallow: /cart',
    'Disallow: /wallet',
    'Disallow: /orders',
    'Disallow: /chat',
    'Disallow: /api/',
    '',
    `Sitemap: ${siteUrl()}/sitemap.xml`,
    '',
  ].join('\n');
}
