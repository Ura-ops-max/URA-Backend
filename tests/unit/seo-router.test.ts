/** Step 7: the CloudFront routing rule sends only shop/product/sitemap/robots paths to the API. */
import { RESERVED_SLUGS } from '@/models/business-model';
import { parseSitePath } from '@/seo/paths';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const edge = require('../../infra/lambda-edge/seo-router.js');

const ID = '68f0c3a1b2c3d4e5f6a7b8c9';

describe('Lambda@Edge routing', () => {
  it('reserved words match the Business model exactly', () => {
    expect([...edge.RESERVED].sort()).toEqual([...RESERVED_SLUGS].sort());
  });

  it('shop and product paths, sitemap and robots go to the page-builder', () => {
    expect(edge.route('/tunde-boots')).toEqual({ path: '/api/v1/seo/page', qs: 'path=%2Ftunde-boots' });
    expect(edge.route(`/tunde-boots/p/${ID}-chelsea-boot`).path).toBe('/api/v1/seo/page');
    expect(edge.route('/sitemap.xml')).toEqual({ path: '/api/v1/seo/sitemap/index', qs: '' });
    expect(edge.route('/sitemaps/products-2.xml')).toEqual({ path: '/api/v1/seo/sitemap/products-2', qs: '' });
    expect(edge.route('/robots.txt')).toEqual({ path: '/api/v1/seo/robots', qs: '' });
  });

  it('app routes, /api and static files are never taken over', () => {
    for (const p of ['/', '/dashboard', '/dashboard/wallet', '/auth/login', '/about', '/api/v1/orders', '/assets/index-abc.js', '/sw.js', '/favicon-32.png', '/payment-complete', '/welcome', '/tunde-boots/extra', '/tunde-boots/p/not-an-id']) {
      expect(edge.route(p)).toBeNull();
    }
  });

  it('agrees with the page-builder on what is a shop or product path', () => {
    for (const p of ['/tunde-boots', `/tunde-boots/p/${ID}-x`, '/dashboard', '/about', '/a.b', '/x/y']) {
      expect(edge.route(p) !== null).toBe(parseSitePath(p).kind !== 'app');
    }
  });

  it('app paths get index.html from S3; files stay as they are', async () => {
    const run = async (uri: string) => {
      const event = { Records: [{ cf: { request: { uri, querystring: '', headers: {}, origin: { s3: {} } } } }] };
      return edge.handler(event);
    };
    expect((await run('/dashboard/wallet')).uri).toBe('/index.html');
    expect((await run('/assets/index-abc.js')).uri).toBe('/assets/index-abc.js');
    const shop = await run('/tunde-boots');
    expect(shop.origin.custom.domainName).toBe('api.ura.com.ng');
    expect(shop.headers.host[0].value).toBe('api.ura.com.ng');
    expect(shop.uri).toBe('/api/v1/seo/page');
  });
});
