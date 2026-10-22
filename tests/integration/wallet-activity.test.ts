/**
 * Wallet rows with names (GET /wallet/activity) and held orders (GET
 * /wallet/held). Payluk's history is faked; MongoDB is throwaway.
 * Key rule: a user only ever sees names from their OWN orders.
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({
  config: { frontend: { url: 'https://example.test' }, rateLimit: {} },
}));
jest.mock('@/templates/emails', () => ({ sendOrderEmail: async () => undefined }));
jest.mock('@/services/track-event.service', () => ({ trackEvent: async () => undefined }));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
const history: any[] = [];
jest.mock('@/services/payluk.service', () => {
  const actual = jest.requireActual('@/services/payluk.service');
  return { ...actual, getPaymentHistory: async () => ({ data: history, pagination: { count: history.length } }) };
});

import Order from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { getActivity, getHeld } from '@/controllers/payment.controller';

let mongo: MongoMemoryServer;
let currentUser: any = null;
const app = express();
app.use((req, _res, next) => {
  (req as any).user = currentUser;
  next();
});
app.get('/wallet/activity', getActivity);
app.get('/wallet/held', getHeld);

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

let seq = 0;
async function person(first: string, last: string, payluk = true) {
  seq++;
  return User.create({
    firstName: first,
    lastName: last,
    username: `p${seq}`,
    email: `p${seq}@example.com`,
    phone: '08012345678',
    ...(payluk ? { paylukCustomerId: `cus_${seq}` } : {}),
  });
}

async function setup() {
  const amaka = await person('Amaka', 'Okafor'); // buyer
  const tunde = await person('Tunde', 'Bello'); // seller
  const stranger = await person('Sade', 'Ade'); // has nothing to do with it
  const shop = await Business.create({ owner: tunde._id, businessName: "Tunde's Shop", location: { type: 'Point', coordinates: [3.38, 6.52] } });
  const order = await Order.create({
    user: amaka._id,
    business: shop._id,
    orderNumber: 'ORD-AAA1',
    items: [{ product: new mongoose.Types.ObjectId(), name: 'Rice', price: 5000, quantity: 1 }],
    totalAmount: 5000,
    itemsTotal: 5000,
    shippingAddress: { phone: '08099999999' },
    paymentMethod: 'card',
    paymentType: 'protected',
    paymentStatus: 'paid',
    paylukPaymentToken: 'PY_TOKEN_A',
    paidAt: new Date(),
  });
  return { amaka, tunde, stranger, shop, order };
}

const as = (u: any) => (currentUser = { _id: u._id });

beforeEach(async () => {
  history.length = 0;
  await Promise.all([Order.deleteMany({}), User.deleteMany({}), Business.deleteMany({})]);
});

describe('GET /wallet/activity', () => {
  it('seller sees "From Amaka O. · ORD-…", Held, and no codes or contact details', async () => {
    const { tunde, order } = await setup();
    history.push({ id: 't1', reference: 'R-LONG-CODE', amount: 5000, fee: 0, transactionType: 'escrow', creditType: 'credit', status: 'success', createdAt: '2026-10-21T10:00:00Z', escrowDetails: { paymentToken: 'PY_TOKEN_A' } });
    as(tunde);
    const res = await request(app).get('/wallet/activity');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      type: 'Payment received',
      details: 'From Amaka O. · ORD-AAA1',
      status: 'Held',
      orderId: String(order._id),
    });
    const body = JSON.stringify(res.body);
    for (const secret of ['R-LONG-CODE', 'PY_TOKEN_A', '08099999999', '08012345678', 'example.com', 'cus_', 'Okafor']) {
      expect(body).not.toContain(secret);
    }
  });

  it('buyer sees "To <shop> · ORD-…"; released after payout', async () => {
    const { amaka, order } = await setup();
    await Order.updateOne({ _id: order._id }, { $set: { payoutReleasedAt: new Date() } });
    history.push({ id: 't2', reference: String(order._id), amount: 5100, fee: 100, transactionType: 'escrow', creditType: 'debit', status: 'success', createdAt: '2026-10-21T10:00:00Z' });
    as(amaka);
    const res = await request(app).get('/wallet/activity');
    expect(res.body.data[0]).toMatchObject({ type: 'Payment sent', details: "To Tunde's Shop · ORD-AAA1", status: 'Released' });
  });

  it("a stranger never sees names from other people's orders", async () => {
    const { stranger, order } = await setup();
    // Even if the stranger's Payluk history somehow pointed at that order:
    history.push(
      { id: 't3', reference: String(order._id), amount: 5000, transactionType: 'escrow', creditType: 'credit', status: 'success', escrowDetails: { paymentToken: 'PY_TOKEN_A' } },
      { id: 't4', reference: 'WD-1', amount: 2000, transactionType: 'withdrawal', creditType: 'debit', status: 'pending' }
    );
    as(stranger);
    const res = await request(app).get('/wallet/activity');
    expect(res.body.data[0]).toMatchObject({ details: 'Payment', orderId: null });
    expect(res.body.data[1]).toMatchObject({ type: 'Withdrawal', details: 'To your bank', status: 'Pending' });
    expect(JSON.stringify(res.body)).not.toMatch(/Amaka|Tunde|ORD-AAA1/);
  });

  it('needs a payment profile', async () => {
    const noProfile = await person('No', 'Profile', false);
    as(noProfile);
    const res = await request(app).get('/wallet/activity');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYLUK_PROFILE_REQUIRED');
  });
});

describe('GET /wallet/held', () => {
  it('lists Buyer-Protected orders still holding money, for both sides, and nobody else', async () => {
    const { amaka, tunde, stranger, order } = await setup();
    as(tunde);
    expect((await request(app).get('/wallet/held')).body.orders).toEqual([
      expect.objectContaining({ orderId: String(order._id), role: 'seller', name: 'Amaka O.', amount: 5000 }),
    ]);
    as(amaka);
    expect((await request(app).get('/wallet/held')).body.orders[0]).toMatchObject({ role: 'buyer', name: "Tunde's Shop" });
    as(stranger);
    expect((await request(app).get('/wallet/held')).body.orders).toEqual([]);

    await Order.updateOne({ _id: order._id }, { $set: { payoutReleasedAt: new Date() } });
    as(tunde);
    expect((await request(app).get('/wallet/held')).body.orders).toEqual([]);
  });
});
