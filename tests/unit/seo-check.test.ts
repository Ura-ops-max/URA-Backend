/** Step 8: the release check fails when the title, JSON-LD or sitemap is missing. */
import { runSeoCheck } from '@/scripts/seo-check';

const BASE = 'https://www.ura.com.ng';
const SHOP = `${BASE}/tunde-boots`;
const PRODUCT = `${BASE}/tunde-boots/p/68f0c3a1b2c3d4e5f6a7b8c9-boot`;

const site = (over: Record<string, string> = {}) => {
  const pages: Record<string, string> = {
    [`${BASE}/sitemap.xml`]: `<sitemapindex><sitemap><loc>${BASE}/sitemaps/shops-1.xml</loc></sitemap><sitemap><loc>${BASE}/sitemaps/products-1.xml</loc></sitemap></sitemapindex>`,
    [`${BASE}/sitemaps/shops-1.xml`]: `<urlset><url><loc>${SHOP}</loc></url></urlset>`,
    [`${BASE}/sitemaps/products-1.xml`]: `<urlset><url><loc>${PRODUCT}</loc></url></urlset>`,
    [SHOP]: '<title>Tunde Boots | Shoes | URA</title><script type="application/ld+json">{"@id":"x#shop"}</script>',
    [PRODUCT]: '<title>Boot, ₦1 | Tunde Boots | URA</title><script type="application/ld+json">{"@type":"Product"}</script>',
    ...over,
  };
  return async (url: string) => ({ status: pages[url] ? 200 : 404, text: async () => pages[url] ?? '' });
};

describe('seo-check', () => {
  it('passes when everything is there', async () => {
    expect(await runSeoCheck(BASE, site())).toEqual([]);
  });
  it('fails without a sitemap', async () => {
    expect(await runSeoCheck(BASE, site({ [`${BASE}/sitemap.xml`]: '' }))).toEqual([
      `${BASE}/sitemap.xml: not a sitemap index (HTTP 404)`,
    ]);
  });
  it('fails when the shop has no title or the product no JSON-LD', async () => {
    const problems = await runSeoCheck(BASE, site({ [SHOP]: '<title>URA home</title><script type="application/ld+json">{"@id":"x"}</script>', [PRODUCT]: '<title>Boot | URA</title>' }));
    expect(problems.join('\n')).toMatch(/shop .*page title missing/);
    expect(problems.join('\n')).toMatch(/product .*JSON-LD missing/);
  });
  it('fails when no shop is Ready', async () => {
    expect(await runSeoCheck(BASE, site({ [`${BASE}/sitemaps/shops-1.xml`]: '<urlset></urlset>' }))).toContain('No Ready shop in the sitemap');
  });
});
