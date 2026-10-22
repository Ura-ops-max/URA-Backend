/**
 * Auto-release (Part 4): times set when paid, the 6-hour warning, the release
 * through the existing queue, and a reported problem blocking it for good.
 * Payluk is faked (documented escrow states); MongoDB is throwaway.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({ config: { frontend: { url: 'https://example.test' }, rateLimit: {} } }));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
const notices: { to: string; title: string; message: string }[] = [];
jest.mock('@/services/track-event.service', () => ({
  trackEvent: async (e: any) => {
    notices.push({ to: e.targetId, title: e.notificationData?.title, message: e.notificationData?.message });
  },
}));
jest.mock('@/templates/emails', () => ({ sendOrderEmail: async () => undefined }));

const fake = { escrows: new Map<string, any>(), confirms: 0 };
jest.mock('@/services/payluk.service', () => {
  const actual = jest.requireActual('@/services/payluk.service');
  const byId = (id: string) => [...fake.escrows.values()].find((e: any) => e.id === id);
  return {
    ...actual,
    verifyEscrow: async (t: string) => actual.toEscrow(fake.escrows.get(t)),
    confirmEscrow: async (id: string) => {
      const e = byId(id);
      if (e.state !== 'OPENED' || e.status !== 'ONGOING') throw new actual.PaylukError('Escrow is not OPENED', 400, 'BAD_REQUEST');
      Object.assign(e, { state: 'CLOSED', status: 'COMPLETED' });
      fake.confirms++;
      return actual.toEscrow(e);
    },
  };
});

import Order from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { PaylukJob } from '@/models/payluk-job-model';
import { toEscrow } from '@/services/payluk.service';
import { applyEscrowState } from '@/services/payment-sync.service';
import { runJob } from '@/services/payluk-jobs.service';
import { autoReleaseTick } from '@/services/auto-release.service';
import { computeReleaseTimes, isAutoReleasable } from '@/services/release-schedule.service';
import * as payments from '@/services/payment.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
  fake.escrows.clear();
  fake.confirms = 0;
  notices.length = 0;
  await Promise.all([Order, User, Business, Product, PaylukJob].map(m => (m as any).deleteMany({})));
});

let seq = 0;
async function scene(
  opts: {
    type?: 'normal' | 'protected';
    products?: { maxDelivery?: number; deliveryTimeline?: 'minutes' | 'hours' | 'days' }[];
    paidAt?: Date;
  } = {}
) {
  seq++;
  const mk = (f: string) =>
    User.create({ firstName: f, lastName: 'X', username: `ar${seq}${f}`, email: `ar${seq}${f}@example.com`, paylukCustomerId: `cus_${seq}_${f}`, phone: '08011112222' });
  const buyer = await mk('Amaka');
  const seller = await mk('Tunde');
  const shop = await Business.create({ owner: seller._id, businessName: 'Tunde Store', location: { type: 'Point', coordinates: [3.38, 6.52] } });
  const products = await Promise.all(
    (opts.products ?? [{}]).map((p, i) => Product.create({ business: shop._id, name: `P${i}`, price: 5000, stock: 8, media: [], ...p }))
  );
  const token = `PY_AR${seq}`;
  fake.escrows.set(token, { id: `esc_ar${seq}`, paymentToken: token, amount: 5000, fee: 100, additionalFee: 0, whoPays: 'buyer', state: 'OPENED', status: 'ONGOING' });
  const order = await Order.create({
    user: buyer._id,
    business: shop._id,
    orderNumber: `ORD-AR${seq}`,
    items: products.map(p => ({ product: p._id, name: p.name, price: 5000, quantity: 1 })),
    totalAmount: 5000 * products.length,
    itemsTotal: 5000 * products.length,
    shippingAddress: { phone: '08099990000' },
    paymentMethod: 'card',
    paymentType: opts.type ?? 'protected',
    paymentStatus: 'paid',
    status: 'processing',
    paylukPaymentToken: token,
    paylukEscrowId: `esc_ar${seq}`,
    paidAt: opts.paidAt ?? new Date(),
  });
  return { order, id: String(order._id), buyer: String(buyer._id), seller: String(seller._id), token };
}

/** The order as Payluk sees it now, applied like the webhook job does. */
const sync = async (id: string) => {
  const o = (await Order.findById(id))!;
  return applyEscrowState(o, toEscrow(fake.escrows.get(o.paylukPaymentToken!)));
};

const runQueuedRelease = async (id: string) => {
  const job = await PaylukJob.findOne({ key: `release:${id}` });
  if (!job) return false;
  await runJob(job);
  return true;
};

describe('release times', () => {
  const paid = new Date('2026-10-22T10:00:00Z');

  it('uses the longest product delivery time', () => {
    const t = computeReleaseTimes(
      paid,
      [
        { _id: 'a', maxDelivery: 2, deliveryTimeline: 'hours' },
        { _id: 'b', maxDelivery: 3, deliveryTimeline: 'days' },
      ],
      'a'
    );
    expect(t.autoReleaseAt.getTime() - paid.getTime()).toBe(3 * DAY);
    // Claim: the escrow's window (first product: 2 hours) + 1 day.
    expect(t.claimableAt.getTime() - paid.getTime()).toBe(2 * HOUR + DAY);
  });

  it('falls back to autoReleaseDays (default 1 day) when no product has a delivery time', () => {
    const t = computeReleaseTimes(paid, [{ _id: 'a' }], 'a');
    expect(t.autoReleaseAt.getTime() - paid.getTime()).toBe(DAY);
    // Escrow default window is 3 days (as checkout sends it) + 1 day.
    expect(t.claimableAt.getTime() - paid.getTime()).toBe(4 * DAY);
    expect(computeReleaseTimes(paid, [], null, 2).autoReleaseAt.getTime() - paid.getTime()).toBe(2 * DAY);
  });

  it('are set once when a Buyer-Protected order is seen paid; never on Normal Payment', async () => {
    const s = await scene({ products: [{ maxDelivery: 2, deliveryTimeline: 'days' }] });
    const o = await sync(s.id);
    expect(o.autoReleaseAt!.getTime() - o.paidAt!.getTime()).toBe(2 * DAY);
    expect(o.claimableAt!.getTime() - o.paidAt!.getTime()).toBe(3 * DAY);
    const again = await sync(s.id);
    expect(again.autoReleaseAt!.getTime()).toBe(o.autoReleaseAt!.getTime());

    const n = await scene({ type: 'normal' });
    await Order.updateOne({ _id: n.id }, { $set: { payoutReleasedAt: new Date() } }); // skip Normal's own release
    expect((await sync(n.id)).autoReleaseAt).toBeUndefined();
  });
});

describe('auto-release job', () => {
  it('warns the buyer once, 6 hours ahead, then releases through the queue', async () => {
    const s = await scene();
    await sync(s.id); // autoReleaseAt = paid + 1 day
    const now = Date.now();

    // Too early: nothing.
    expect(await autoReleaseTick(new Date(now))).toEqual({ warned: 0, queued: 0 });

    // 18 hours later: the warning.
    const t18 = new Date(now + 18 * HOUR + 60_000);
    expect(await autoReleaseTick(t18)).toEqual({ warned: 1, queued: 0 });
    await new Promise(r => setTimeout(r, 50));
    const warning = notices.find(n => n.to === s.buyer);
    expect(warning?.message).toBe('Your money goes to Tunde Store in 6 hours. Tap here if there is a problem.');
    expect(notices.some(n => n.to === s.seller)).toBe(false);
    // Never sent twice.
    expect((await autoReleaseTick(t18)).warned).toBe(0);

    // Due: queued on the existing release queue, then paid to the shop.
    const t24 = new Date(t18.getTime() + 6 * HOUR + 60_000);
    expect(await autoReleaseTick(t24)).toEqual({ warned: 0, queued: 1 });
    // The queue checks the time against the real clock, so move the order's time back.
    await Order.updateOne({ _id: s.id }, { $set: { autoReleaseAt: new Date(Date.now() - 1000) } });
    expect(await runQueuedRelease(s.id)).toBe(true);
    const done = (await Order.findById(s.id))!;
    expect(fake.confirms).toBe(1);
    expect(done.payoutReleasedAt).toBeTruthy();
    expect(done.releasedBy).toBe('auto');
    expect(done.status).toBe('delivered');
  });

  it('a short delivery time still gives the buyer the full 6 hours after the warning', async () => {
    const s = await scene({ products: [{ maxDelivery: 1, deliveryTimeline: 'hours' }] });
    await sync(s.id);
    const now = new Date();
    expect((await autoReleaseTick(now)).warned).toBe(1);
    const o = (await Order.findById(s.id))!;
    expect(o.autoReleaseAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 6 * HOUR);
    expect((await autoReleaseTick(new Date(now.getTime() + HOUR))).queued).toBe(0);
  });

  it('a reported problem blocks it for good, even after the problem is resolved', async () => {
    const s = await scene();
    await sync(s.id);
    await Order.updateOne({ _id: s.id }, { $set: { buyerReportedAt: new Date(), disputeStatus: 'open' } });
    const later = new Date(Date.now() + 3 * DAY);
    expect(await autoReleaseTick(later)).toEqual({ warned: 0, queued: 0 });
    await Order.updateOne({ _id: s.id }, { $set: { disputeStatus: 'resolved' } });
    expect(await autoReleaseTick(later)).toEqual({ warned: 0, queued: 0 });
    expect(await PaylukJob.countDocuments()).toBe(0);
  });

  it('a problem reported after the release was queued stops it before Payluk is called', async () => {
    const s = await scene();
    await sync(s.id);
    const now = Date.now();
    await autoReleaseTick(new Date(now + 18 * HOUR + 60_000));
    await autoReleaseTick(new Date(now + 25 * HOUR));
    await Order.updateOne(
      { _id: s.id },
      { $set: { autoReleaseAt: new Date(Date.now() - 1000), buyerReportedAt: new Date() } }
    );
    await runQueuedRelease(s.id);
    expect(fake.confirms).toBe(0);
    expect((await Order.findById(s.id))!.payoutReleasedAt).toBeUndefined();
  });

  it('a rejected order is never auto-released', async () => {
    const s = await scene();
    await sync(s.id);
    await Order.updateOne({ _id: s.id }, { $set: { rejectedAt: new Date() } });
    expect(await autoReleaseTick(new Date(Date.now() + 3 * DAY))).toEqual({ warned: 0, queued: 0 });
  });

  it('orders paid before this existed get a claim time but are never auto-released', async () => {
    const s = await scene({ paidAt: new Date(Date.now() - 10 * DAY) });
    await autoReleaseTick(new Date());
    const o = (await Order.findById(s.id))!;
    expect(o.claimableAt).toBeTruthy();
    expect(o.autoReleaseAt).toBeUndefined();
    expect((await autoReleaseTick(new Date(Date.now() + 30 * DAY))).queued).toBe(0);
  });

  it('isAutoReleasable needs the warning and the time to have passed', () => {
    const base = { paymentType: 'protected', paymentStatus: 'paid', status: 'shipped' } as const;
    const past = new Date(Date.now() - 1000);
    expect(isAutoReleasable({ ...base, autoReleaseAt: past } as any)).toBe(false);
    expect(isAutoReleasable({ ...base, autoReleaseAt: past, autoReleaseWarnedAt: past } as any)).toBe(true);
    expect(isAutoReleasable({ ...base, autoReleaseAt: new Date(Date.now() + HOUR), autoReleaseWarnedAt: past } as any)).toBe(false);
  });
});

describe('releasedBy', () => {
  it("is 'buyer' when the buyer confirms delivery", async () => {
    const s = await scene();
    await sync(s.id);
    await payments.confirmReceived(s.id, s.buyer);
    expect((await Order.findById(s.id))!.releasedBy).toBe('buyer');
  });

  it("is 'admin' when the money is released without URA asking (resolved by an admin)", async () => {
    const s = await scene();
    await sync(s.id);
    Object.assign(fake.escrows.get(s.token), { state: 'CLOSED', status: 'COMPLETED' });
    await sync(s.id);
    expect((await Order.findById(s.id))!.releasedBy).toBe('admin');
  });
});
