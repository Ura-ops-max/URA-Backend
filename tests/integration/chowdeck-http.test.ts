/** HTTP: POST /delivery/cost, GET /delivery/track/:trackingNumber, POST /webhooks/chowdeck. */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({ config: { frontend: { url: 'https://example.test' }, rateLimit: {} } }));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
jest.mock('@/services/track-event.service', () => ({ trackEvent: async () => undefined }));
jest.mock('@/templates/emails', () => ({ sendOrderEmail: async () => undefined }));
const notices: string[] = [];
jest.mock('@/services/order-events.service', () => {
  const actual = jest.requireActual('@/services/order-events.service');
  return { ...actual, notifyOrderEvent: async (_o: any, e: string) => void notices.push(e) };
});
jest.mock('@/middleware/passport-auth', () => ({
  requireAuth: (req: any, res: any, next: any) =>
    req.headers['x-test-user'] ? ((req.user = { _id: req.headers['x-test-user'] }), next()) : res.status(401).json({}),
  optionalProtect: (_req: any, _res: any, next: any) => next(),
}));
const chowdeck = { quote: jest.fn(), get: jest.fn() };
jest.mock('@/services/chowdeck.service', () => {
  const actual = jest.requireActual('@/services/chowdeck.service');
  return { ...actual, getChowdeckQuote: (...a: any[]) => chowdeck.quote(...a), getChowdeckDelivery: (...a: any[]) => chowdeck.get(...a) };
});
const fez = { cost: jest.fn(), track: jest.fn() };
jest.mock('@/services/fez.service', () => {
  const actual = jest.requireActual('@/services/fez.service');
  return { ...actual, isFezConfigured: () => true, getDeliveryCost: (...a: any[]) => fez.cost(...a), trackDeliveryOrder: (...a: any[]) => fez.track(...a) };
});

import deliveryRoutes from '@/routes/delivery.routes';
import webhookRoutes from '@/routes/webhook.route';
import Order from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';

const app = express();
app.use(express.json({ verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
app.use('/api/v1/delivery', deliveryRoutes);
app.use('/api/v1/webhooks', webhookRoutes);

const ENV = { ...process.env };
const SECRET = 'whsec-test';
let mongo: MongoMemoryServer;
let buyer: any, seller: any, stranger: any, shop: any;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
  buyer = await User.create({ firstName: 'Amaka', username: 'hb1', email: 'hb1@example.com' });
  seller = await User.create({ firstName: 'Tunde', username: 'hs1', email: 'hs1@example.com' });
  stranger = await User.create({ firstName: 'Sade', username: 'hx1', email: 'hx1@example.com' });
  shop = await Business.create({
    owner: seller._id,
    businessName: 'Tunde Boots',
    address: { fullAddress: '31 Allen Ave', city: 'Ikeja', state: 'Lagos' },
    location: { type: 'Point', coordinates: [3.35, 6.6] },
  });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  process.env.CHOWDECK_API_KEY = 'k';
  process.env.CHOWDECK_CITIES = 'Lagos';
  process.env.CHOWDECK_WEBHOOK_SECRET = SECRET;
  notices.length = 0;
  [...Object.values(chowdeck), ...Object.values(fez)].forEach(f => f.mockReset());
  fez.cost.mockResolvedValue({ cost: 3000, vat: 225, totalCost: 3225, state: 'Oyo', raw: { status: 'Success' } });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await Order.deleteMany({});
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

let n = 0;
async function order(extra: Record<string, unknown> = {}) {
  n++;
  return Order.create({
    user: buyer._id,
    business: shop._id,
    orderNumber: `ORD-H${n}`,
    items: [{ product: new mongoose.Types.ObjectId(), name: 'Boot', price: 15000, quantity: 1 }],
    totalAmount: 17100,
    deliveryMethod: 'delivery',
    shippingAddress: { fullAddress: '1 Admiralty Way', city: 'Lekki', state: 'Lagos', phone: '08022222222' },
    paymentMethod: 'card',
    paymentType: 'protected',
    paymentStatus: 'paid',
    status: 'shipped',
    ...extra,
  });
}

describe('POST /delivery/cost', () => {
  const cost = (body: any) => request(app).post('/api/v1/delivery/cost').set('x-test-user', String(buyer._id)).send(body);

  it('same city: Chowdeck, with totalCost kept and provider, providerName, eta added', async () => {
    chowdeck.quote.mockResolvedValue({ feeId: 1, totalNaira: 2100 });
    const res = await cost({ state: 'Lagos', city: 'Lekki', fullAddress: '1 Admiralty Way', latitude: 6.44, longitude: 3.47, businessId: String(shop._id) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { cost: 2100, vat: 0, totalCost: 2100, state: 'Lagos', provider: 'chowdeck', providerName: 'Chowdeck', eta: 'Same day' },
    });
  });

  it('state alone (old apps): Fez, with all of today\'s fields plus provider', async () => {
    const res = await cost({ state: 'Oyo', businessId: String(shop._id) });
    expect(res.body).toEqual({
      success: true,
      data: { cost: 3000, vat: 225, totalCost: 3225, state: 'Oyo', raw: { status: 'Success' }, provider: 'fez', providerName: 'Fez' },
    });
  });

  it('Chowdeck error: Fez price instead', async () => {
    chowdeck.quote.mockRejectedValue(new Error('down'));
    const res = await cost({ state: 'Lagos', city: 'Lekki', businessId: String(shop._id) });
    expect(res.body.data).toMatchObject({ provider: 'fez', totalCost: 3225 });
  });

  it('no Chowdeck settings: same as today', async () => {
    delete process.env.CHOWDECK_API_KEY;
    const res = await cost({ state: 'Lagos', city: 'Lekki', businessId: String(shop._id) });
    expect(res.body.data).toMatchObject({ provider: 'fez', totalCost: 3225 });
    expect(chowdeck.quote).not.toHaveBeenCalled();
  });
});

describe('GET /delivery/track/:trackingNumber', () => {
  const track = (t: string, user: any) => request(app).get(`/api/v1/delivery/track/${t}`).set('x-test-user', String(user._id));
  const SHAPE = ['provider', 'status', 'statusLabel', 'trackingUrl', 'rider', 'timeline', 'raw'];

  it('Chowdeck: the normalised shape; the buyer gets the PIN, the seller never does', async () => {
    const o = await order({ fulfilment: 'chowdeck', trackingNumber: 'ORD-TRK1', deliveryPin: 4821, trackingUrl: 'https://track.chowdeck.com/x' });
    chowdeck.get.mockResolvedValue({
      status: 'in_transit',
      tracking_url: 'https://track.chowdeck.com/live',
      driver: { first_name: 'Musa', last_name: 'Bello', phone: '08033333333' },
      timeline: [{ action: 'ORDER_PICKED_UP', description: 'Rider picked up the package', created_at: '2026-11-24T10:00:00Z' }],
    });
    const asBuyer = await track('ORD-TRK1', buyer);
    expect(asBuyer.status).toBe(200);
    expect(asBuyer.body.data).toMatchObject({
      provider: 'chowdeck',
      status: 'in_transit',
      statusLabel: 'On the way',
      trackingUrl: 'https://track.chowdeck.com/live',
      rider: { name: 'Musa Bello', phone: '08033333333' },
      timeline: [{ status: 'in_transit', label: 'Rider picked up the package', at: '2026-11-24T10:00:00Z' }],
      deliveryPin: 4821,
    });
    for (const k of SHAPE) expect(asBuyer.body.data).toHaveProperty(k);

    const asSeller = await track('ORD-TRK1', seller);
    expect(asSeller.status).toBe(200);
    expect(asSeller.body.data.deliveryPin).toBeUndefined();
    expect(JSON.stringify(asSeller.body)).not.toContain('4821');
    expect(o.orderNumber).toBeTruthy();
  });

  it('Fez: the same shape, with Fez\'s own response in raw', async () => {
    await order({ fulfilment: 'fez', trackingNumber: 'FEZ123' });
    fez.track.mockResolvedValue({ status: 'Success', order: { orderStatus: 'Dispatched' }, history: [{ orderStatus: 'Pending Pick-Up', statusCreationDate: '2026-11-24T09:00:00Z' }] });
    const res = await track('FEZ123', buyer);
    expect(res.body.data).toMatchObject({ provider: 'fez', status: 'in_transit', statusLabel: 'On the way', trackingUrl: null });
    expect(res.body.data.timeline[0]).toEqual({ status: 'awaiting_pickup', label: 'Pending Pick-Up', at: '2026-11-24T09:00:00Z' });
    expect(res.body.data.raw).toMatchObject({ order: { orderStatus: 'Dispatched' } });
    for (const k of SHAPE) expect(res.body.data).toHaveProperty(k);
  });

  it('only the buyer, the seller or an admin; sign-in needed; unknown is 404', async () => {
    await order({ fulfilment: 'fez', trackingNumber: 'FEZ999' });
    fez.track.mockResolvedValue({});
    expect((await track('FEZ999', stranger)).status).toBe(403);
    process.env.ADMIN_EMAILS = 'hx1@example.com';
    expect((await track('FEZ999', stranger)).status).toBe(200);
    expect((await request(app).get('/api/v1/delivery/track/FEZ999')).status).toBe(401);
    expect((await track('NOPE', buyer)).status).toBe(404);
  });
});

describe('POST /webhooks/chowdeck', () => {
  const sign = (raw: string, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const send = (body: any, signature?: string) => {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/api/v1/webhooks/chowdeck')
      .set('Content-Type', 'application/json')
      .set('x-chowdeck-signature', signature ?? sign(raw))
      .send(raw);
  };

  it('a bad signature is refused with 401 and changes nothing', async () => {
    const o = await order({ fulfilment: 'chowdeck', trackingNumber: 'ORD-W1', deliveryStatus: 'booked' });
    const body = { data: { reference: 'ORD-W1', status: 'in_transit' } };
    expect((await send(body, sign('something else'))).status).toBe(401);
    expect((await send(body, 'nothex')).status).toBe(401);
    expect((await Order.findById(o._id).lean())?.deliveryStatus).toBe('booked');
  });

  it('a valid event is applied once, even if sent twice; never backwards', async () => {
    const o = await order({ fulfilment: 'chowdeck', trackingNumber: 'ORD-W2', deliveryStatus: 'booked' });
    const body = { category: 'ORDER_PICKED_UP', payload: { reference: 'ORD-W2' } };
    expect((await send(body)).body).toEqual({ ok: true });
    expect((await send(body)).body).toEqual({ ok: true });
    expect(notices.filter(e => e === 'RIDER_PICKED_UP')).toHaveLength(1);
    // An older status arriving late does not move it back.
    await send({ data: { reference: 'ORD-W2', status: 'awaiting_pickup' } });
    expect((await Order.findById(o._id).lean())?.deliveryStatus).toBe('in_transit');
  });

  it('"delivered" only prompts the buyer: the order is not completed and no money moves', async () => {
    const o = await order({ fulfilment: 'chowdeck', trackingNumber: 'ORD-W3', deliveryStatus: 'in_transit' });
    await send({ data: { reference: 'ORD-W3', status: 'success' } });
    const after: any = await Order.findById(o._id).lean();
    expect(after.deliveryStatus).toBe('delivered');
    expect(after.status).toBe('shipped');
    expect(after.payoutReleasedAt).toBeUndefined();
    expect(notices).toEqual(['COURIER_DELIVERED']);
  });

  it('unknown orders are acknowledged; no secret set means 500', async () => {
    expect((await send({ data: { reference: 'ORD-NONE', status: 'in_transit' } })).status).toBe(200);
    delete process.env.CHOWDECK_WEBHOOK_SECRET;
    expect((await send({ data: {} })).status).toBe(500);
  });
});
