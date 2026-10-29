/**
 * Release check for Google visibility. Fetches /sitemap.xml, one Ready shop
 * and one product, and fails (exit 1) if the sitemap, a page title or the
 * JSON-LD is missing. Run in CI or after each deploy:
 *   bun run src/scripts/seo-check.ts                 (checks PUBLIC_SITE_URL)
 *   SEO_CHECK_URL=https://<staging>.cloudfront.net bun run src/scripts/seo-check.ts
 */
import 'dotenv/config';
import { siteUrl } from '@/seo/config';

type Fetcher = (url: string) => Promise<{ status: number; text: () => Promise<string> }>;

const firstLoc = (xml: string, contains: string) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).find(u => u.includes(contains));

/** Returns the problems found (empty means all good). */
export async function runSeoCheck(base: string, get: Fetcher): Promise<string[]> {
  const problems: string[] = [];
  const page = async (url: string, kind: 'shop' | 'product') => {
    const res = await get(url);
    const html = await res.text();
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    if (res.status !== 200) problems.push(`${kind} ${url}: HTTP ${res.status}`);
    if (!title || !title.endsWith('| URA'))
      problems.push(`${kind} ${url}: page title missing (got "${title}")`);
    if (
      !html.includes('application/ld+json') ||
      !html.includes(kind === 'shop' ? '"@id"' : '"@type":"Product"')
    ) {
      problems.push(`${kind} ${url}: JSON-LD missing`);
    }
  };

  const index = await get(`${base}/sitemap.xml`);
  const indexXml = await index.text();
  if (index.status !== 200 || !indexXml.includes('<sitemapindex')) {
    return [`${base}/sitemap.xml: not a sitemap index (HTTP ${index.status})`];
  }
  const shopsUrl = firstLoc(indexXml, '/sitemaps/shops-');
  const shopsXml = shopsUrl ? await (await get(shopsUrl)).text() : '';
  const shop = firstLoc(shopsXml, base.replace(/^https?:\/\//, ''));
  if (!shop) problems.push('No Ready shop in the sitemap');
  else await page(shop, 'shop');

  const productsUrl = firstLoc(indexXml, '/sitemaps/products-');
  if (productsUrl) {
    const product = firstLoc(await (await get(productsUrl)).text(), '/p/');
    if (product) await page(product, 'product');
    else problems.push('Product sitemap is empty');
  }
  return problems;
}

async function main() {
  const base = String(process.env.SEO_CHECK_URL || siteUrl()).replace(/\/+$/, '');
  const get: Fetcher = async url => {
    const res = await globalThis.fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'URA-seo-check' },
    });
    return { status: res.status, text: () => res.text() };
  };
  const problems = await runSeoCheck(base, get);
  if (problems.length) {
    console.error(`SEO check FAILED for ${base}:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `SEO check passed for ${base}: sitemap, a Ready shop and a product all have titles and JSON-LD.`
  );
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
