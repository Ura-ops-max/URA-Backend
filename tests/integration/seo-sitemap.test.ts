/** Step 6: sitemap index, child sitemaps and robots.txt. */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));

import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { clearSeoCache } from '@/seo/cache';
import { robotsTxt, sitemapXml } from '@/seo/sitemap';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  clearSeoCache();
  await Promise.all([Business, Product, User].map(m => (m as any).deleteMany({})));
});

let n = 0;
async function shop(name: string, extra: Record<string, unknown> = {}) {
  n++;
  const owner = await User.create({ firstName: 'O', username: `sm${n}`, email: `sm${n}@example.com` });
  return Business.create({ owner: owner._id, businessName: name, location: { type: 'Point', coordinates: [3, 6] }, ...extra });
}
const ABOUT = 'We make strong leather boots by hand in our workshop in Ora East.';

it('lists only Ready shops and their visible products', async () => {
  const ready = await shop('Ready Boots');
  const visible = await Product.create({ business: ready._id, name: 'Chelsea Boot', price: 1, stock: 1, media: [] });
  const hidden = await Product.create({ business: ready._id, name: 'Secret', price: 1, stock: 1, media: [], isHidden: true });
  const empty = await shop('Empty Shop'); // not Ready
  const off = await shop('Off Shop', { about: ABOUT, showOnGoogle: false });

  const index = (await sitemapXml('index'))!;
  expect(index).toContain('<sitemapindex');
  expect(index).toContain('/sitemaps/pages-1.xml');
  expect(index).toContain('/sitemaps/shops-1.xml');
  expect(index).toContain('/sitemaps/products-1.xml');

  const shops = (await sitemapXml('shops-1'))!;
  expect(shops).toContain(`<loc>https://www.ura.com.ng/${ready.slug}</loc>`);
  expect(shops).not.toContain(empty.slug);
  expect(shops).not.toContain(off.slug);

  const products = (await sitemapXml('products-1'))!;
  expect(products).toContain(`https://www.ura.com.ng/${ready.slug}/p/${visible._id}-chelsea-boot`);
  expect(products).not.toContain(String(hidden._id));

  expect(await sitemapXml('products-2')).toBeNull();
  expect(await sitemapXml('nonsense')).toBeNull();
  expect(await sitemapXml('pages-1')).toContain('<loc>https://www.ura.com.ng/about</loc>');
});

it('lastmod only after a real edit, not a like or follow', async () => {
  const b = await shop('Edit Shop', { about: ABOUT });
  const p = await Product.create({ business: b._id, name: 'Boot', price: 1, stock: 1, media: [] });
  await Business.updateOne({ _id: b._id }, { $unset: { contentUpdatedAt: 1 } });
  await Product.updateOne({ _id: p._id }, { $unset: { contentUpdatedAt: 1 } });

  // A like and a follow: no lastmod.
  await Product.updateOne({ _id: p._id }, { $push: { likes: new mongoose.Types.ObjectId() } });
  await Business.updateOne({ _id: b._id }, { $push: { followers: new mongoose.Types.ObjectId() } });
  clearSeoCache();
  expect(await sitemapXml('products-1')).not.toContain('<lastmod>');
  expect(await sitemapXml('shops-1')).not.toContain('<lastmod>');

  // A real edit: lastmod appears.
  await Product.findOneAndUpdate({ _id: p._id }, { $set: { price: 2 } });
  await Business.findOneAndUpdate({ _id: b._id }, { $set: { about: `${ABOUT} New stock weekly.` } });
  const today = new Date().toISOString().slice(0, 10);
  expect(await sitemapXml('products-1')).toContain(`<lastmod>${today}</lastmod>`);
  expect(await sitemapXml('shops-1')).toContain(`<lastmod>${today}</lastmod>`);
});

it('robots.txt allows public pages, blocks private areas, points to the sitemap', () => {
  const r = robotsTxt();
  expect(r).toContain('Allow: /');
  for (const p of ['/dashboard', '/checkout', '/cart', '/wallet', '/orders', '/chat', '/api/']) expect(r).toContain(`Disallow: ${p}`);
  expect(r).toContain('Sitemap: https://www.ura.com.ng/sitemap.xml');
});
