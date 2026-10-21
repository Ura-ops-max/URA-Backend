/**
 * Payments with a fake Payluk (in memory, following the documented escrow
 * lifecycle) and a throwaway MongoDB. No real Payluk, config or email.
 *
 * Covers: checkout creates a goods-only escrow with the fees in additionalFee;
 * Normal orders are released once (also with duplicate webhooks, a 429, events
 * out of order); a 401 flags the order; Buyer-Protected is held until the buyer
 * confirms; the webhook signature and de-duplication.
 */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({
  config: { frontend: { url: 'https://example.test' }, rateLimit: {} },
}));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
jest.mock('@/services/track-event.service', () => ({ trackEvent: async () => undefined }));
jest.mock('@/templates/emails', () => ({ sendOrderEmail: async () => undefined }));

// ── Fake Payluk ──────────────────────────────────────────────────────────────
type FakeEscrow = {
  id: string;
  paymentToken: string;
  amount: number;
  fee: number;
  additionalFee: number;
  whoPays: string;
  state: string;
  status: string;
  totalQuantity: number;
};
const fake = {
  escrows: new Map<string, FakeEscrow>(),
  releases: 0,
  created: [] as any[],
  confirmFailures: [] as Error[], // thrown by the next confirm calls, in order
};

jest.mock('@/services/payluk.service', () => {
  const actual = jest.requireActual('@/services/payluk.service');
  const byId = (id: string) => [...fake.escrows.values()].find(e => e.id === id);
  return {
    ...actual,
    createEscrow: async (opts: any) => {
      const n = fake.escrows.size + 1;
      const e: FakeEscrow = {
        id: `esc_${n}`,
        paymentToken: `PY_TOKEN_${n}`,
        amount: opts.amount,
        fee: Math.round(opts.amount * 0.02),
        additionalFee: 0,
        whoPays: opts.whoPays,
        state: 'AWAITING_PAYMENT',
        status: 'PENDING',
        totalQuantity: 1,
      };
      fake.escrows.set(e.paymentToken, e);
      fake.created.push(opts);
      return actual.toEscrow(e);
    },
    setAdditionalFee: async (token: string, fee: number) => {
      const e = fake.escrows.get(token)!;
      e.additionalFee = fee;
      return actual.toEscrow(e);
    },
    verifyEscrow: async (token: string) => actual.toEscrow(fake.escrows.get(token)),
    confirmEscrow: async (id: string) => {
      const failure = fake.confirmFailures.shift();
      if (failure) throw failure;
      const e = byId(id)!;
      if (e.state !== 'OPENED') throw new actual.PaylukError('Escrow is not OPENED', 400, 'BAD_REQUEST');
      e.state = 'CLOSED';
      e.status = 'COMPLETED';
      fake.releases++;
      return actual.toEscrow(e);
    },
  };
});

import { PaylukError } from '@/services/payluk.service';
import Order from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { PaylukJob } from '@/models/payluk-job-model';
import { PaylukWebhookEvent } from '@/models/payluk-webhook-event-model';
import { startPayment, confirmReceived, getPaymentStatus } from '@/services/payment.service';
import { tick } from '@/services/payluk-jobs.service';
import webhookRouter from '@/routes/webhook.route';

const SECRET = 'fake-webhook-signing-value';
let mongo: MongoMemoryServer;

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);
app.use('/api/v1/webhooks', webhookRouter);

const sign = (body: string) => crypto.createHmac('sha512', SECRET).update(body).digest('hex');
const sendWebhook = (payload: unknown, signature?: string) => {
  const body = JSON.stringify(payload);
  return request(app)
    .post('/api/v1/webhooks/payluk')
    .set('Content-Type', 'application/json')
    .set('x-payluk-signature', signature ?? sign(body))
    .send(body);
};

/** Run the worker until no job is due (jobs set to run later are made due). */
async function drainJobs(makeDue = true) {
  for (let i = 0; i < 20; i++) {
    if (makeDue) await PaylukJob.updateMany({ status: 'pending' }, { $set: { runAt: new Date(0) } });
    const due = await PaylukJob.countDocuments({ status: 'pending', runAt: { $lte: new Date() } });
    if (!due) return;
    await tick();
  }
}

beforeAll(async () => {
  process.env.PAYLUK_SECRET_KEY = SECRET;
  mongo = await MongoMemoryServer.create(
    process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {}
  );
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  fake.escrows.clear();
  fake.releases = 0;
  fake.created = [];
  fake.confirmFailures = [];
  await Promise.all(
    [Order, User, Business, Product, PaylukJob, PaylukWebhookEvent].map(m => (m as any).deleteMany({}))
  );
});

let seq = 0;
async function makeOrder(paymentType: 'normal' | 'protected', opts: { delivery?: number; platform?: number } = {}) {
  seq++;
  const seller = await User.create({ firstName: 'S', username: `s${seq}`, email: `s${seq}@example.com`, paylukCustomerId: `cus_seller_${seq}` });
  const buyer = await User.create({ firstName: 'B', username: `b${seq}`, email: `b${seq}@example.com`, paylukCustomerId: `cus_buyer_${seq}` });
  const biz = await Business.create({ owner: seller._id, businessName: `Shop ${seq}`, location: { type: 'Point', coordinates: [3.38, 6.52] } });
  const product = await Product.create({ business: biz._id, name: 'Rice', price: 5000, stock: 10, media: [], whoPays: 'both' });
  const delivery = opts.delivery ?? 0;
  const platform = opts.platform ?? 0;
  const order = await Order.create({
    user: buyer._id,
    business: biz._id,
    orderNumber: `ORD-${seq}`,
    items: [{ product: product._id, name: 'Rice', price: 5000, quantity: 2 }],
    totalAmount: 10000 + delivery + platform,
    itemsTotal: 10000,
    deliveryFee: delivery,
    deliveryFeeCharged: delivery,
    platformFee: platform,
    deliveryMethod: delivery ? 'delivery' : 'pickup',
    shippingAddress: { phone: '0800' },
    paymentMethod: 'card',
    paymentType,
    stockReserved: true,
    reservedUntil: new Date(Date.now() + 60_000),
  });
  return { order, buyer, seller, product };
}

/** The buyer pays in the widget: Payluk funds the escrow. */
function fund(token: string) {
  const e = fake.escrows.get(token)!;
  e.state = 'OPENED';
  e.status = 'ONGOING';
  return e;
}

describe('checkout: POST /orders/:id/pay', () => {
  it('creates a goods-only escrow; delivery + platform charge go in additionalFee', async () => {
    const { order, buyer } = await makeOrder('normal', { delivery: 2500, platform: 300 });
    const r = await startPayment(String(order._id), String(buyer._id));

    expect(fake.created[0]).toMatchObject({ amount: 10000, whoPays: 'seller', sellerCustomerId: expect.stringMatching(/^cus_seller_/) });
    const e = fake.escrows.get(r.paymentToken)!;
    expect(e.additionalFee).toBe(2800);
    // Normal: seller pays Payluk's fee, so the buyer pays goods + additionalFee.
    expect(r.amountToPay).toBe(12800);
    expect(r.breakdown).toEqual({ items: 10000, delivery: 2500, serviceFee: 300, total: 12800 });
    expect(r.reference).toBe(String(order._id));
    expect(r.customerId).toBe(buyer.paylukCustomerId);
  });

  it('Buyer-Protected uses the product fee setting; a retry reuses the escrow with a new reference', async () => {
    const { order, buyer } = await makeOrder('protected');
    const first = await startPayment(String(order._id), String(buyer._id));
    const second = await startPayment(String(order._id), String(buyer._id));
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].whoPays).toBe('both');
    expect(second.paymentToken).toBe(first.paymentToken);
    expect(second.reference).toBe(`${order._id}-2`);
    // both: the buyer pays half of the 2% fee (200 / 2 = 100).
    expect(first.amountToPay).toBe(10100);
  });

  it('refuses another user', async () => {
    const { order } = await makeOrder('normal');
    await expect(startPayment(String(order._id), String(new Types.ObjectId()))).rejects.toMatchObject({ status: 403 });
  });
});

describe('Normal Payment: released to the seller automatically', () => {
  async function paidNormalOrder() {
    const ctx = await makeOrder('normal');
    const r = await startPayment(String(ctx.order._id), String(ctx.buyer._id));
    const e = fund(r.paymentToken);
    return { ...ctx, escrow: e };
  }

  it('funded → paid → released once; delivery status is not touched', async () => {
    const { order, escrow } = await paidNormalOrder();
    const res = await sendWebhook({ event: 'escrow.ongoing', data: { ...escrow } });
    expect(res.status).toBe(200);
    await drainJobs();

    const o = await Order.findById(order._id).lean();
    expect(o?.paymentStatus).toBe('paid');
    expect(o?.payoutReleasedAt).toBeTruthy();
    expect(o?.status).toBe('processing');
    expect(fake.releases).toBe(1);
  });

  it('the same webhook twice changes nothing', async () => {
    const { order, escrow } = await paidNormalOrder();
    const payload = { event: 'escrow.ongoing', data: { ...escrow } };
    expect((await sendWebhook(payload)).body).toEqual({ ok: true });
    expect((await sendWebhook(payload)).body).toEqual({ ok: true, duplicate: true });
    await drainJobs();
    // payment.escrow.success for the same funding: also no second release.
    await sendWebhook({ event: 'payment.escrow.success', data: { reference: 'R1', escrowDetails: { escrowId: escrow.id } } });
    await drainJobs();
    expect(fake.releases).toBe(1);
    expect(await PaylukWebhookEvent.countDocuments()).toBe(2);
    expect((await Order.findById(order._id).lean())?.payoutReleasedAt).toBeTruthy();
  });

  it('a 429 on release is retried', async () => {
    const { order, escrow } = await paidNormalOrder();
    fake.confirmFailures.push(new PaylukError('Too many request', 429, 'RATE_LIMITED'));
    await sendWebhook({ event: 'escrow.ongoing', data: { ...escrow } });
    await drainJobs(false); // first try fails and is rescheduled for later
    let job = await PaylukJob.findOne({ key: `release:${order._id}` }).lean();
    expect(job?.status).toBe('pending');
    expect(job?.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(fake.releases).toBe(0);

    await drainJobs(true); // the retry
    job = await PaylukJob.findOne({ key: `release:${order._id}` }).lean();
    expect(job?.status).toBe('done');
    expect(fake.releases).toBe(1);
  });

  it('a 401 (not a super-admin key) stops and flags the order', async () => {
    const { order, escrow } = await paidNormalOrder();
    fake.confirmFailures.push(new PaylukError('Access denied', 401, 'UNAUTHORIZED'));
    await sendWebhook({ event: 'escrow.ongoing', data: { ...escrow } });
    await drainJobs();
    const job = await PaylukJob.findOne({ key: `release:${order._id}` }).lean();
    expect(job?.status).toBe('flagged');
    expect((await Order.findById(order._id).lean())?.adminFlag?.reason).toMatch(/401/);
    expect(fake.releases).toBe(0);
  });

  it('events out of order: completed before ongoing', async () => {
    const { order, escrow } = await paidNormalOrder();
    escrow.state = 'CLOSED';
    escrow.status = 'COMPLETED'; // released elsewhere
    await sendWebhook({ event: 'escrow.completed', data: { ...escrow } });
    await sendWebhook({ event: 'escrow.ongoing', data: { ...escrow, state: 'OPENED', status: 'ONGOING' } });
    await drainJobs();
    const o = await Order.findById(order._id).lean();
    expect(o?.paymentStatus).toBe('paid');
    expect(o?.payoutReleasedAt).toBeTruthy();
    expect(fake.releases).toBe(0); // nothing left to release
  });

  it('payment-status confirms with Payluk (not the browser) and starts the release', async () => {
    const { order, buyer } = await paidNormalOrder();
    const s = await getPaymentStatus(String(order._id), String(buyer._id));
    expect(s.paymentStatus).toBe('paid');
    await drainJobs();
    expect(fake.releases).toBe(1);
  });
});

describe('Buyer-Protected Payment: held until the buyer confirms', () => {
  it('no automatic release; "I\'ve received my order" releases it', async () => {
    const { order, buyer } = await makeOrder('protected');
    const r = await startPayment(String(order._id), String(buyer._id));
    const e = fund(r.paymentToken);
    await sendWebhook({ event: 'escrow.ongoing', data: { ...e } });
    await drainJobs();
    expect(fake.releases).toBe(0);
    expect(await PaylukJob.countDocuments({ type: 'release' })).toBe(0);

    const out = await confirmReceived(String(order._id), String(buyer._id));
    expect(out.payoutReleased).toBe(true);
    expect(fake.releases).toBe(1);
    expect((await Order.findById(order._id).lean())?.status).toBe('delivered');
  });

  it('Normal orders cannot be "confirmed received"', async () => {
    const { order, buyer } = await makeOrder('normal');
    await expect(confirmReceived(String(order._id), String(buyer._id))).rejects.toMatchObject({ code: 'NORMAL_PAYMENT' });
  });

  it('a dispute pauses the order, a refund puts the stock back', async () => {
    const { order, buyer, product } = await makeOrder('protected');
    const r = await startPayment(String(order._id), String(buyer._id));
    const e = fund(r.paymentToken);
    await sendWebhook({ event: 'escrow.ongoing', data: { ...e } });
    await drainJobs();
    await sendWebhook({ event: 'escrow.disputed', data: { ...e, status: 'DISPUTED' } });
    await drainJobs();
    expect((await Order.findById(order._id).lean())?.disputeStatus).toBe('open');

    await sendWebhook({ event: 'escrow.refunded', data: { ...e, state: 'CLOSED', status: 'REFUNDED' } });
    await drainJobs();
    const o = await Order.findById(order._id).lean();
    expect(o?.status).toBe('refunded');
    expect((await Product.findById(product._id).lean())?.stock).toBe(12); // 10 + 2 back
  });
});

describe('webhook security and URA payouts', () => {
  it('rejects a bad signature and ignores unknown events', async () => {
    expect((await sendWebhook({ event: 'escrow.ongoing', data: { id: 'x' } }, 'a'.repeat(128))).status).toBe(401);
    expect((await sendWebhook({ event: 'escrow.ongoing', data: { id: 'x' } }, 'nothex')).status).toBe(401);
    const unknown = await sendWebhook({ event: 'something.new', data: { id: 'x' } });
    expect(unknown.status).toBe(200);
    expect(unknown.body.ignored).toBe(true);
  });

  it('records the delivery fee and commission Payluk paid to URA', async () => {
    const { order, buyer } = await makeOrder('normal', { delivery: 2500 });
    const r = await startPayment(String(order._id), String(buyer._id));
    const escrowId = fake.escrows.get(r.paymentToken)!.id;
    await sendWebhook({ event: 'payment.delivery.success', data: { reference: 'D1', amount: 2500, escrowDetails: { escrowId } } });
    await sendWebhook({ event: 'payment.commission.success', data: { reference: 'C1', amount: 50, escrowDetails: { escrowId } } });
    await drainJobs();
    const o = await Order.findById(order._id).lean();
    expect(o?.deliveryFeeReceived).toBe(2500);
    expect(o?.commissionReceived).toBe(50);
  });
});
