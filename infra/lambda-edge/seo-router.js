'use strict';
/**
 * CloudFront Lambda@Edge, ORIGIN REQUEST, default behaviour (S3 origin).
 * Region: us-east-1. Runtime: Node.js 20. See docs/google-routing.md.
 *
 * Sends shop pages, product pages, /sitemap.xml, /sitemaps/*.xml and
 * /robots.txt to URA's page-builder (api.ura.com.ng). Everything else stays
 * on S3; app paths with no file extension get /index.html (the single-page
 * app), which replaces the 403/404 "custom error responses" so the
 * page-builder's real 404 and 410 reach Google.
 *
 * Keep RESERVED in line with RESERVED_SLUGS in src/models/business-model.ts
 * (a test checks this).
 */
const API_HOST = 'api.ura.com.ng';

const RESERVED = new Set([
  'about',
  'contact',
  'terms',
  'privacy',
  'faq',
  'invite',
  'payments',
  'products',
  'posts',
  'auth',
  'dashboard',
  'api',
  'health',
  'b',
  'login',
  'register',
  'signin',
  'signup',
  'admin',
  'settings',
  'product',
  'businesses',
  'explore',
  'search',
  'cart',
  'checkout',
  'welcome',
  'google',
  'payment-complete',
  'payluk',
  'p',
  'seo',
  'sitemap',
  'sitemaps',
  'robots',
  'assets',
  'images',
  'sounds',
  'mock-data',
  'sw',
  'static',
  'favicon',
  'manifest',
  'site',
  'menu',
  'notifications',
  'wallet',
  'orders',
  'chat',
  'inventory',
]);

const SLUG = /^[a-z0-9-]{1,80}$/;

/** Where a viewer path goes: { path, qs } on the API, or null (stay on S3). */
function route(uri) {
  if (uri === '/robots.txt') return { path: '/api/v1/seo/robots', qs: '' };
  if (uri === '/sitemap.xml') return { path: '/api/v1/seo/sitemap/index', qs: '' };
  const sm = /^\/sitemaps\/([a-z]+-\d{1,4})\.xml$/.exec(uri);
  if (sm) return { path: '/api/v1/seo/sitemap/' + sm[1], qs: '' };

  const seg = uri.split('/').filter(Boolean);
  if (!seg.length || seg.some(s => s.includes('.'))) return null;
  const slug = seg[0].toLowerCase();
  if (!SLUG.test(slug) || RESERVED.has(slug)) return null;
  const isShop = seg.length === 1;
  const isProduct = seg.length === 3 && seg[1] === 'p' && /^[0-9a-f]{24}/i.test(seg[2]);
  if (!isShop && !isProduct) return null;
  return { path: '/api/v1/seo/page', qs: 'path=' + encodeURIComponent(uri) };
}

exports.handler = async event => {
  const req = event.Records[0].cf.request;
  const r = route(req.uri);
  if (r) {
    req.origin = {
      custom: {
        domainName: API_HOST,
        port: 443,
        protocol: 'https',
        path: '',
        sslProtocols: ['TLSv1.2'],
        readTimeout: 30,
        keepaliveTimeout: 5,
        customHeaders: {},
      },
    };
    req.headers.host = [{ key: 'Host', value: API_HOST }];
    req.uri = r.path;
    req.querystring = r.qs;
    return req;
  }
  // The app: any path without a file extension is served index.html.
  const last = req.uri.split('/').pop() || '';
  if (!last.includes('.')) req.uri = '/index.html';
  return req;
};

exports.route = route;
exports.RESERVED = RESERVED;
