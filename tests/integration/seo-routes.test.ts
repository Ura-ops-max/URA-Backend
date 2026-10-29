/** Step 9: the real HTTP endpoints (status codes, redirects, headers). */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
jest.mock('@/middleware/passport-auth', () => ({
  requireAuth: (req: any, res: any, next: any) =>
    req.headers['x-test-user'] ? ((req.user = { _id: req.headers['x-test-user'] }), next()) : res.status(401).json({}),
}));

import seoRoutes from '@/routes/seo.routes';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { clearSeoCache } from '@/seo/cache';
import { setIndexHtmlForTests } from '@/seo/index-html';

const app = express();
app.use('/api/v1/seo', seoRoutes);

let mongo: MongoMemoryServer;
let owner: any;
let shop: any;
let product: any;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
  setIndexHtmlForTests('<!doctype html><html><head><title>URA</title></head><body><div id="root"></div></body></html>');
  owner = await User.create({ firstName: 'T', username: 'rt1', email: 'rt1@example.com' });
  shop = await Business.create({ owner: owner._id, businessName: 'Tunde Boots', location: { type: 'Point', coordinates: [3, 6] } });
  product = await Product.create({ business: shop._id, name: 'Chelsea Boot', price: 25000, stock: 1, media: [] });
});
afterAll(async () => {
  setIndexHtmlForTests(null);
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(() => clearSeoCache());

it('shop page: 200 HTML, cached about an hour', async () => {
  const res = await request(app).get('/api/v1/seo/page').query({ path: `/${shop.slug}` });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/html/);
  expect(res.headers['cache-control']).toBe('public, max-age=300, s-maxage=3600');
  expect(res.text).toContain('<h1>Tunde Boots</h1>');
});

it('outdated product URL: 301 with the new Location', async () => {
  const res = await request(app).get('/api/v1/seo/page').query({ path: `/${shop.slug}/p/${product._id}-old` });
  expect(res.status).toBe(301);
  expect(res.headers.location).toBe(`https://www.ura.com.ng/${shop.slug}/p/${product._id}-chelsea-boot`);
});

it('unknown shop: real 404 with noindex; deleted product: 410', async () => {
  const missing = await request(app).get('/api/v1/seo/page').query({ path: '/no-such-shop' });
  expect(missing.status).toBe(404);
  expect(missing.headers['x-robots-tag']).toBe('noindex');
  const gone = await Product.create({ business: shop._id, name: 'Gone', price: 1, stock: 1, media: [] });
  await Product.findOneAndDelete({ _id: gone._id, business: shop._id });
  expect((await request(app).get('/api/v1/seo/page').query({ path: `/${shop.slug}/p/${gone._id}-gone` })).status).toBe(410);
});

it('sitemap index and robots.txt load with the right types', async () => {
  const sm = await request(app).get('/api/v1/seo/sitemap/index');
  expect(sm.status).toBe(200);
  expect(sm.headers['content-type']).toMatch(/application\/xml/);
  expect(sm.text).toContain('<sitemapindex');
  expect((await request(app).get('/api/v1/seo/sitemap/bogus')).status).toBe(404);
  const robots = await request(app).get('/api/v1/seo/robots');
  expect(robots.headers['content-type']).toMatch(/text\/plain/);
  expect(robots.text).toContain('Sitemap: https://www.ura.com.ng/sitemap.xml');
});

it("the owner's readiness: needs sign-in, shows next steps", async () => {
  expect((await request(app).get('/api/v1/seo/readiness/mine')).status).toBe(401);
  const res = await request(app).get('/api/v1/seo/readiness/mine').set('x-test-user', String(owner._id));
  expect(res.body.shops[0]).toMatchObject({ slug: shop.slug, ready: true, url: `https://www.ura.com.ng/${shop.slug}` });
  expect(res.body.shops[0].nextSteps).toContain('Add your area');
});
