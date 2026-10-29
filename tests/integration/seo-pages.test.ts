/** Step 4: built shop and product pages. */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));

import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { buildPage } from '@/seo/pages';
import { clearSeoCache } from '@/seo/cache';
import { setIndexHtmlForTests } from '@/seo/index-html';
import { productTitle, shopTitle } from '@/seo/titles';
import { parseSitePath, slugifyName } from '@/seo/paths';

const INDEX_HTML = `<!doctype html><html lang="en"><head>
<title>URA home</title>
<meta name="description" content="home description" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="https://www.ura.com.ng/" />
<meta property="og:title" content="home" />
<script type="module" src="/assets/index-abc.js"></script>
</head><body><div id="root"></div></body></html>`;

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
  setIndexHtmlForTests(INDEX_HTML);
});
afterAll(async () => {
  setIndexHtmlForTests(null);
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  clearSeoCache();
  await Promise.all([Business, Product, User].map(m => (m as any).deleteMany({})));
});

let n = 0;
async function shop(extra: Record<string, unknown> = {}) {
  n++;
  const owner = await User.create({ firstName: 'Tunde', lastName: 'Bello', username: `pg${n}`, email: `pg${n}.private@example.com`, phone: '08055550000' });
  return Business.create({
    owner: owner._id,
    businessName: 'Tunde Boots',
    category: 'Shoes',
    area: 'Ora East',
    address: { street: '12 Secret Close', fullAddress: '12 Secret Close, Ora East', city: 'Ikeja', state: 'Lagos' },
    contact: { phone: '08031234567', email: 'shop.private@example.com' },
    location: { type: 'Point', coordinates: [3.31, 6.55] },
    ...extra,
  });
}

const robots = (html: string) => /<meta name="robots" content="([^"]+)"/.exec(html)?.[1];

describe('shop page', () => {
  it('has its own title, description, canonical, JSON-LD and visible text', async () => {
    const b = await shop();
    await Product.create({ business: b._id, name: 'Chelsea Boot', price: 25000, stock: 3, media: ['https://cdn/1.jpg'] });
    const page = await buildPage(`/${b.slug}`);
    expect(page.status).toBe(200);
    const html = page.html!;
    expect(html).toContain('<title>Tunde Boots | Shoes in Ora East, Ikeja | URA</title>');
    expect(html).toContain('<meta name="description" content="Tunde Boots sells shoes in Ora East, Ikeja. 1 product on URA." />');
    expect(html).toContain(`<link rel="canonical" href="https://www.ura.com.ng/${b.slug}" />`);
    expect(html).toContain('"@type":"Store"');
    expect(html).toContain('<h1>Tunde Boots</h1>');
    expect(html).toMatch(/Chelsea Boot<\/a> ₦25,000/);
    expect(robots(html)).toBe('index, follow, max-image-preview:large');
    // The home page's tags are replaced, the app still loads.
    expect(html).not.toContain('URA home');
    expect(html).not.toContain('home description');
    expect(html).toContain('/assets/index-abc.js');
    expect(html).toContain('id="ura-page-data"');
  });

  it('never shows the home address or private fields', async () => {
    const b = await shop();
    await Product.create({ business: b._id, name: 'Boot', price: 1, stock: 1, media: [] });
    const html = (await buildPage(`/${b.slug}`)).html!;
    for (const secret of ['Secret Close', '3.31', '6.55', '.private@example.com', '08055550000', 'loanEligibility', '"followers":[', '"likes":[', 'googleReadyNotifiedAt']) {
      expect(html).not.toContain(secret);
    }
  });

  it('a shop with a store that shows its address does show it', async () => {
    const b = await shop({ hasPhysicalStore: true, showStreetAddress: true });
    expect((await buildPage(`/${b.slug}`)).html).toContain('Address: 12 Secret Close, Ora East');
  });

  it('not Ready: works for people but noindex; Google switch off: noindex', async () => {
    const empty = await shop();
    const page = await buildPage(`/${empty.slug}`);
    expect(page.status).toBe(200);
    expect(robots(page.html!)).toBe('noindex, follow');
    const off = await shop({ about: 'A'.repeat(60), showOnGoogle: false });
    expect(robots((await buildPage(`/${off.slug}`)).html!)).toBe('noindex, follow');
  });

  it('an unknown shop is a real 404', async () => {
    const page = await buildPage('/no-such-shop-here');
    expect(page.status).toBe(404);
    expect(robots(page.html!)).toBe('noindex, nofollow');
  });

  it('an edit clears the cached page', async () => {
    const b = await shop({ about: 'A'.repeat(60) });
    expect((await buildPage(`/${b.slug}`)).html).toContain('<h1>Tunde Boots</h1>');
    await Business.findOneAndUpdate({ _id: b._id }, { $set: { businessName: 'Tunde Shoes' } });
    expect((await buildPage(`/${b.slug}`)).html).toContain('<h1>Tunde Shoes</h1>');
  });
});

describe('product page', () => {
  it('title, price, stock, description, shop link, Product JSON-LD', async () => {
    const b = await shop();
    const p = await Product.create({ business: b._id, name: 'Chelsea Boot', description: 'Brown leather.', price: 25000, stock: 0, media: ['https://cdn/1.jpg'] });
    const page = await buildPage(`/${b.slug}/p/${p._id}-chelsea-boot`);
    expect(page.status).toBe(200);
    const html = page.html!;
    expect(html).toContain('<title>Chelsea Boot, ₦25,000 | Tunde Boots in Ikeja | URA</title>');
    expect(html).toContain('<h1>Chelsea Boot</h1>');
    expect(html).toContain('Out of stock');
    expect(html).toContain('Brown leather.');
    expect(html).toContain(`<a href="/${b.slug}">Tunde Boots</a>`);
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('<meta property="og:image" content="https://cdn/1.jpg" />');
    expect(html).not.toMatch(/payluk|likes"/i);
  });

  it('an outdated name or shop in the URL: 301 to the current URL', async () => {
    const b = await shop();
    const p = await Product.create({ business: b._id, name: 'Chelsea Boot', price: 1, stock: 1, media: [] });
    const page = await buildPage(`/${b.slug}/p/${p._id}-old-name`);
    expect(page).toMatchObject({ status: 301, location: `https://www.ura.com.ng/${b.slug}/p/${p._id}-chelsea-boot` });
    expect((await buildPage(`/someone-else/p/${p._id}-chelsea-boot`)).status).toBe(301);
  });

  it('unknown product: 404; deleted product: 410', async () => {
    const b = await shop();
    expect((await buildPage(`/${b.slug}/p/${new mongoose.Types.ObjectId()}-x`)).status).toBe(404);
    const p = await Product.create({ business: b._id, name: 'Gone', price: 1, stock: 1, media: [] });
    await Product.findOneAndDelete({ _id: p._id, business: b._id });
    expect((await buildPage(`/${b.slug}/p/${p._id}-gone`)).status).toBe(410);
  });

  it('a hidden product: noindex and none of its data', async () => {
    const b = await shop();
    const p = await Product.create({ business: b._id, name: 'Secret Drop', description: 'Not public yet', price: 999, stock: 1, media: [], isHidden: true });
    const html = (await buildPage(`/${b.slug}/p/${p._id}-secret-drop`)).html!;
    expect(robots(html)).toBe('noindex, nofollow');
    expect(html).not.toMatch(/Secret Drop|Not public yet|999/);
  });
});

describe('app routes are untouched', () => {
  it('app pages, files and api paths pass through as the plain app', async () => {
    for (const path of ['/dashboard', '/dashboard/wallet', '/auth/login', '/about', '/api/v1/orders', '/assets/index-abc.js', '/robots.txt', '/payment-complete', '/a/b']) {
      expect(parseSitePath(path)).toEqual({ kind: 'app' });
      const page = await buildPage(path);
      expect(page).toMatchObject({ status: 200, html: INDEX_HTML });
    }
  });
});

describe('titles drop missing parts', () => {
  it('shop titles', () => {
    expect(shopTitle('Tunde Boots', 'Shoes', 'Ora East, Ikeja')).toBe('Tunde Boots | Shoes in Ora East, Ikeja | URA');
    expect(shopTitle('Tunde Boots', 'Shoes', null)).toBe('Tunde Boots | Shoes | URA');
    expect(shopTitle('Tunde Boots', null, 'Ikeja')).toBe('Tunde Boots | Ikeja | URA');
    expect(shopTitle('Tunde Boots')).toBe('Tunde Boots | URA');
  });
  it('product titles', () => {
    expect(productTitle('Boot', 25000, 'Tunde Boots', 'Ikeja')).toBe('Boot, ₦25,000 | Tunde Boots in Ikeja | URA');
    expect(productTitle('Boot', 0, 'Tunde Boots', null)).toBe('Boot | Tunde Boots | URA');
  });
  it('name slugs', () => {
    expect(slugifyName('Chelsea Boot (Brown)!')).toBe('chelsea-boot-brown');
    expect(slugifyName('')).toBe('item');
  });
});
