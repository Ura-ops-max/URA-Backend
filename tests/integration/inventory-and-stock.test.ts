/**
 * Inventory upload checks, the stock table edits, and the stock hold at
 * checkout — against a throwaway in-memory MongoDB. No real config, Payluk,
 * email or image indexing is used (all stubbed below).
 */
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({
  config: { frontend: { url: 'https://example.test' }, rateLimit: {} },
}));
jest.mock('@/services/payluk.service', () => ({
  createPaymentLink: async () => ({ escrowId: 'e', paymentToken: 't', fee: 0 }),
  PaylukError: class extends Error {},
}));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
jest.mock('@/services/track-event.service', () => ({ trackEvent: async () => undefined }));
jest.mock('@/templates/emails', () => ({ sendOrderEmail: async () => undefined }));

import { Product } from '@/models/product-model';
import { Business } from '@/models/business-model';
import { User } from '@/models/user-model';
import Order from '@/models/order-model';
import { checkRows, commitBulk, updateStock } from '@/controllers/inventory.controller';
import { holdItems, releaseUnpaidHolds } from '@/services/stock-hold.service';
import { markOrderPaid } from '@/services/order-events.service';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(
    process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {}
  );
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
afterEach(async () => {
  await Promise.all([
    Product.deleteMany({}),
    Business.deleteMany({}),
    User.deleteMany({}),
    Order.deleteMany({}),
  ]);
});

async function makeShop(paylukCustomerId: string | null = 'cus_1') {
  const user = await User.create({
    firstName: 'Ada',
    username: `ada${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    email: `ada${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`,
    ...(paylukCustomerId ? { paylukCustomerId } : {}),
  });
  const business = await Business.create({
    owner: user._id,
    businessName: 'Ada Store',
    location: { type: 'Point', coordinates: [3.38, 6.52] },
  });
  return { user, business, businessId: business._id as Types.ObjectId };
}

/** Run an asyncHandler-wrapped controller and capture its response. */
function call(handler: any, userId: string, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    let status = 200;
    const res: any = {
      status(c: number) {
        status = c;
        return res;
      },
      json(b: unknown) {
        resolve({ status, body: b });
        return res;
      },
    };
    handler({ user: { _id: userId }, body } as any, res, reject);
  });
}

describe('inventory: checking rows', () => {
  it('flags problems with a plain reason, row by row', async () => {
    const { businessId } = await makeShop();
    const { results, summary } = await checkRows(businessId, [
      { name: 'Milk', price: '₦1,200', stock: '10', sku: 'MK-1' },
      { name: 'No Price', price: '' },
      { name: 'Bad Stock', price: 100, stock: '2.5' },
      { name: 'Dup A', price: 1, sku: 'DUP' },
      { name: 'Dup B', price: 1, sku: 'dup' },
      { name: 'Same Name', price: 1 },
      { name: 'same name', price: 2 },
      { name: 'Weird', price: 1, category: 'Spaceships' },
      { name: 'Http', price: 1, image: 'http://x.test/a.jpg' },
      { name: '', price: 1 },
    ]);
    expect(results[0]).toMatchObject({ status: 'new', name: 'Milk' });
    expect(results[1].reason).toBe('Row 2: Price is missing or not a number');
    expect(results[2].reason).toMatch(/Row 3: Stock must be a whole number/);
    expect(results[3].reason).toMatch(/appears more than once/);
    expect(results[4].reason).toMatch(/appears more than once/); // case-insensitive SKU
    expect(results[5].reason).toMatch(/no item code/);
    expect(results[7].reason).toMatch(/Unknown category/);
    expect(results[8].reason).toMatch(/https/);
    expect(results[9].reason).toBe('Row 10: Name is missing');
    expect(summary).toEqual({ new: 1, update: 0, same: 0, error: 9 });
  });

  it('matches on SKU, then exact name; refuses to guess between two same-named products', async () => {
    const { businessId } = await makeShop();
    await Product.create([
      { business: businessId, name: 'Rice 5kg', price: 5000, stock: 3, sku: 'RC-5', media: [] },
      { business: businessId, name: 'Beans', price: 900, stock: 1, media: [] },
      { business: businessId, name: 'Oil', price: 100, stock: 1, media: [] },
      { business: businessId, name: 'Oil', price: 200, stock: 1, media: [] },
    ]);
    const { results } = await checkRows(businessId, [
      { name: 'Renamed rice', price: 5000, stock: 3, sku: 'RC-5' }, // same price/stock by SKU
      { name: 'Beans', price: 950, stock: 1 }, // price change by name
      { name: 'Oil', price: 150, stock: 1 },
    ]);
    expect(results[0].status).toBe('same');
    expect(results[1]).toMatchObject({ status: 'update', changes: ['price'] });
    expect(results[2].status).toBe('error');
    expect(results[2].reason).toMatch(/2 products named "Oil"/);
  });
});

describe('inventory: saving uploads', () => {
  it('creates once, then a re-upload changes nothing; a price change updates one row', async () => {
    const { user } = await makeShop();
    const rows = [
      { name: 'Peak Milk 400g', price: '3500', stock: '24', sku: 'PK-400', category: 'groceries' },
      { name: 'Indomie 70g', price: '250', stock: '120', sku: 'IND-70' },
      { name: 'Broken', price: 'abc' },
    ];
    const first = await call(commitBulk, String(user._id), { rows });
    expect(first.status).toBe(200);
    expect(first.body.saved).toEqual({ created: 2, updated: 0 });
    expect(first.body.problems).toHaveLength(1);
    const milk = await Product.findOne({ sku: 'PK-400' }).lean();
    expect(milk).toMatchObject({ category: 'Groceries', description: '', price: 3500, stock: 24 });

    const again = await call(commitBulk, String(user._id), { rows });
    expect(again.body.summary).toMatchObject({ new: 0, update: 0, same: 2 });
    expect(await Product.countDocuments()).toBe(2);

    rows[0] = { ...rows[0], price: '3600' };
    const changed = await call(commitBulk, String(user._id), { rows });
    expect(changed.body.saved).toEqual({ created: 0, updated: 1 });
    expect((await Product.findOne({ sku: 'PK-400' }).lean())?.price).toBe(3600);
  });

  it('needs a payment profile, like adding one product', async () => {
    const { user } = await makeShop(null);
    const res = await call(commitBulk, String(user._id), { rows: [{ name: 'A', price: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAYLUK_SETUP_REQUIRED');
  });

  it('refuses buyers (no shop)', async () => {
    const buyer = await User.create({ firstName: 'B', username: 'buyer1', email: 'b1@example.test' });
    const res = await call(commitBulk, String(buyer._id), { rows: [{ name: 'A', price: 1 }] });
    expect(res.status).toBe(403);
  });
});

describe('inventory: stock table edits', () => {
  it("changes only the owner's own products; a new photo becomes the main one", async () => {
    const mine = await makeShop();
    const other = await makeShop();
    const [p] = await Product.create([
      { business: mine.businessId, name: 'Mine', price: 1, stock: 1, media: ['https://x.test/old.jpg'] },
    ]);
    const [theirs] = await Product.create([
      { business: other.businessId, name: 'Theirs', price: 1, stock: 1, media: [] },
    ]);
    const res = await call(updateStock, String(mine.user._id), {
      items: [
        { id: String(p._id), stock: 7, price: 99, isHidden: true, photoUrl: 'https://x.test/new.jpg' },
        { id: String(theirs._id), stock: 0 },
      ],
    });
    expect(res.body).toMatchObject({ updated: 1, skipped: 1 });
    const after = await Product.findById(p._id).lean();
    expect(after).toMatchObject({ stock: 7, price: 99, isHidden: true });
    expect(after?.media).toEqual(['https://x.test/new.jpg', 'https://x.test/old.jpg']);
    expect((await Product.findById(theirs._id).lean())?.stock).toBe(1);
  });

  it('rejects bad values and non-https photos', async () => {
    const { user, businessId } = await makeShop();
    const [p] = await Product.create([{ business: businessId, name: 'A', price: 1, stock: 1, media: [] }]);
    for (const bad of [{ stock: -1 }, { stock: 1.5 }, { price: -2 }, { photoUrl: 'http://x.test/a.jpg' }]) {
      const res = await call(updateStock, String(user._id), { items: [{ id: String(p._id), ...bad }] });
      expect(res.status).toBe(400);
    }
  });
});

describe('stock hold at checkout', () => {
  const item = (product: unknown, quantity: number) => ({ product, name: 'Last one', quantity });

  it('holds all items or none', async () => {
    const { businessId } = await makeShop();
    const [a, b] = await Product.create([
      { business: businessId, name: 'A', price: 1, stock: 5, media: [] },
      { business: businessId, name: 'B', price: 1, stock: 1, media: [] },
    ]);
    await expect(holdItems([item(a._id, 2), item(b._id, 2)])).rejects.toThrow(/only has 1/);
    expect((await Product.findById(a._id).lean())?.stock).toBe(5); // A was put back
  });

  it('two buyers cannot both hold the last item', async () => {
    const { businessId } = await makeShop();
    const [p] = await Product.create([{ business: businessId, name: 'A', price: 1, stock: 1, media: [] }]);
    const results = await Promise.allSettled([holdItems([item(p._id, 1)]), holdItems([item(p._id, 1)])]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await Product.findById(p._id).lean())?.stock).toBe(0);
  });

  async function pendingOrder(businessId: Types.ObjectId, productId: unknown, reservedUntil: Date) {
    const buyer = await User.create({
      firstName: 'B',
      username: `b${Math.random().toString(36).slice(2, 8)}`,
      email: `b${Math.random().toString(36).slice(2, 8)}@example.test`,
    });
    return Order.create({
      user: buyer._id,
      business: businessId,
      orderNumber: `ORD-${Math.random().toString(36).slice(2, 8)}`,
      items: [{ product: productId, name: 'A', price: 1, quantity: 2 }],
      totalAmount: 2,
      shippingAddress: { phone: '0800' },
      paymentMethod: 'card',
      stockReserved: true,
      reservedUntil,
    });
  }

  it('payment after a hold does not take the stock twice', async () => {
    const { businessId } = await makeShop();
    const [p] = await Product.create([{ business: businessId, name: 'A', price: 1, stock: 5, media: [] }]);
    await holdItems([item(p._id, 2)]);
    const order = await pendingOrder(businessId, p._id, new Date(Date.now() + 60_000));
    await markOrderPaid(order._id, 'ref');
    expect((await Product.findById(p._id).lean())?.stock).toBe(3);
    // An expired-hold sweep afterwards must not put paid stock back.
    expect(await releaseUnpaidHolds({ _id: order._id })).toBe(0);
    expect((await Product.findById(p._id).lean())?.stock).toBe(3);
  });

  it('an unpaid hold is released once; a late payment then takes the stock', async () => {
    const { businessId } = await makeShop();
    const [p] = await Product.create([{ business: businessId, name: 'A', price: 1, stock: 5, media: [] }]);
    await holdItems([item(p._id, 2)]);
    const order = await pendingOrder(businessId, p._id, new Date(Date.now() - 1000));
    expect(await releaseUnpaidHolds({ reservedUntil: { $lt: new Date() } })).toBe(1);
    expect(await releaseUnpaidHolds({ reservedUntil: { $lt: new Date() } })).toBe(0);
    expect((await Product.findById(p._id).lean())?.stock).toBe(5);
    await markOrderPaid(order._id, 'late');
    expect((await Product.findById(p._id).lean())?.stock).toBe(3);
  });
});
