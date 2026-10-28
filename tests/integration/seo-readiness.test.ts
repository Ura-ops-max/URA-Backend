/** Step 3: readiness from stored data, the one-time notice, generated descriptions. */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
const notices: any[] = [];
jest.mock('@/services/track-event.service', () => ({ trackEvent: async (e: any) => void notices.push(e) }));

import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { computeReadiness } from '@/seo/readiness';
import { generatedDescription, metaDescription, shopDescription } from '@/seo/describe';
import { shopsWithReadiness } from '@/seo/shop-data';
import { notifyNewlyReadyShops, READY_NOTICE } from '@/seo/readiness-job';
import { readinessReport } from '@/seo/report';

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
  notices.length = 0;
  await Promise.all([Business, Product, User].map(m => (m as any).deleteMany({})));
});

const ABOUT = 'We make strong leather boots by hand in our workshop in Ora East.';

describe('the four readiness cases', () => {
  const shop = { businessName: 'Tunde Boots', showOnGoogle: true };
  it('About and products: Ready', () => expect(computeReadiness({ ...shop, about: ABOUT }, 3).ready).toBe(true));
  it('About, no products: Ready', () => expect(computeReadiness({ ...shop, about: ABOUT }, 0).ready).toBe(true));
  it('No About, has products: Ready', () => expect(computeReadiness(shop, 1).ready).toBe(true));
  it('No About, no products: not Ready', () => {
    const r = computeReadiness(shop, 0);
    expect(r).toMatchObject({ ready: false, reasons: ['no-about-or-products'] });
    expect(r.nextSteps).toEqual(['Add an About (at least 50 characters)', 'Add a product', 'Add your area']);
  });
  it('a short About does not count; city and state are not needed', () => {
    expect(computeReadiness({ ...shop, about: 'Boots.' }, 0).ready).toBe(false);
    expect(computeReadiness({ ...shop, about: ABOUT }, 0).reasons).toEqual([]);
  });
  it('"Show my shop on Google" off or no name: not Ready', () => {
    expect(computeReadiness({ ...shop, about: ABOUT, showOnGoogle: false }, 5).reasons).toEqual(['google-off']);
    expect(computeReadiness({ businessName: ' ', about: ABOUT }, 5).reasons).toEqual(['no-name']);
  });
});

describe('readiness updates by itself, and the notice is sent once', () => {
  it('becomes Ready after a product or an About, stops when both are gone', async () => {
    const owner = await User.create({ firstName: 'T', username: 'rd1', email: 'rd1@example.com' });
    const b = await Business.create({ owner: owner._id, businessName: 'Tunde Boots', location: { type: 'Point', coordinates: [3, 6] } });
    const now = async () => (await shopsWithReadiness({ _id: b._id }))[0].ready;

    expect(await now()).toBe(false);
    expect(await notifyNewlyReadyShops()).toBe(0);

    const p = await Product.create({ business: b._id, name: 'Boot', price: 5000, stock: 1, media: [] });
    expect(await now()).toBe(true);
    expect(await notifyNewlyReadyShops()).toBe(1);
    expect(notices[0]).toMatchObject({ targetId: String(owner._id), notificationData: { message: READY_NOTICE } });

    await Product.updateOne({ _id: p._id }, { $set: { isHidden: true } }); // hidden products don't count
    expect(await now()).toBe(false);
    await Business.updateOne({ _id: b._id }, { $set: { about: ABOUT } });
    expect(await now()).toBe(true);
    await Business.updateOne({ _id: b._id }, { $set: { about: '' } });
    expect(await now()).toBe(false);

    // Ready again later: never a second notice.
    await Business.updateOne({ _id: b._id }, { $set: { about: ABOUT } });
    expect(await notifyNewlyReadyShops()).toBe(0);
    expect(notices).toHaveLength(1);
  });

  it('the admin report counts Ready shops and top reasons', async () => {
    const o1 = await User.create({ firstName: 'A', username: 'rp1', email: 'rp1@example.com' });
    const o2 = await User.create({ firstName: 'B', username: 'rp2', email: 'rp2@example.com' });
    await Business.create({ owner: o1._id, businessName: 'Ready One', about: ABOUT, location: { type: 'Point', coordinates: [3, 6] } });
    await Business.create({ owner: o2._id, businessName: 'Empty One', location: { type: 'Point', coordinates: [3, 6] } });
    const r = await readinessReport();
    expect(r).toMatchObject({ total: 2, ready: 1, notReady: 1 });
    expect(r.topReasons[0]).toMatchObject({ reason: 'no-about-or-products', shops: 1 });
  });
});

describe('descriptions use stored facts only', () => {
  it('builds from name, category, area, city and product count', () => {
    expect(
      generatedDescription({ businessName: 'Tunde Boots', category: 'Shoes', area: 'Ora East', address: { city: 'Lagos' } }, 12)
    ).toBe('Tunde Boots sells shoes in Ora East, Lagos. 12 products on URA.');
  });
  it('leaves out any missing fact', () => {
    expect(generatedDescription({ businessName: 'Tunde Boots', category: 'Shoes' }, 0)).toBe('Tunde Boots sells shoes.');
    expect(generatedDescription({ businessName: 'Tunde Boots', address: { state: 'Imo' } }, 1)).toBe(
      'Tunde Boots is a shop in Imo. 1 product on URA.'
    );
    expect(generatedDescription({ businessName: 'Tunde Boots' }, 0)).toBe('Tunde Boots is a shop on URA.');
  });
  it('uses the About when there is one; never the street address', () => {
    expect(shopDescription({ businessName: 'X', about: ABOUT }, 0)).toBe(ABOUT);
    expect(generatedDescription({ businessName: 'X', address: { street: '12 Secret Close', fullAddress: '12 Secret Close' } }, 0)).not.toContain('Secret');
  });
  it('meta description is about 155 characters, cut at a word', () => {
    const m = metaDescription('word '.repeat(80));
    expect(m.length).toBeLessThanOrEqual(155);
    expect(m.endsWith('…')).toBe(true);
    expect(metaDescription('Short.')).toBe('Short.');
  });
});
