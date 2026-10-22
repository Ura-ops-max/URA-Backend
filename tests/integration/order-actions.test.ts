/**
 * Order actions (Parts 2 and 3): who may confirm, report, respond, claim,
 * cancel, reject and get a refund, and what order lists may show.
 * Payluk is faked (documented escrow states); MongoDB is throwaway.
 */
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({ config: { frontend: { url: 'https://example.test' }, rateLimit: {} } }));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
jest.mock('@/services/track-event.service', () => ({ trackEvent: async () => undefined }));
jest.mock('@/templates/emails', () => ({ sendOrderEmail: async () => undefined }));

const fake = { escrows: new Map<string, any>(), confirms: 0, disputes: [] as any[], resolves: 0, claims: 0 };
jest.mock('@/services/payluk.service', () => {
  const actual = jest.requireActual('@/services/payluk.service');
  const byId = (id: string) => [...fake.escrows.values()].find((e: any) => e.id === id);
  return {
    ...actual,
    verifyEscrow: async (t: string) => actual.toEscrow(fake.escrows.get(t)),
    confirmEscrow: async (id: string) => {
      const e = byId(id);
      if (e.state !== 'OPENED') throw new actual.PaylukError('Escrow is not OPENED', 400, 'BAD_REQUEST');
      Object.assign(e, { state: 'CLOSED', status: 'COMPLETED' });
      fake.confirms++;
      return actual.toEscrow(e);
    },
    submitDispute: async (o: any) => {
      const e = fake.escrows.get(o.paymentToken);
      fake.disputes.push({ by: o.customerId, message: o.message });
      e.status = 'DISPUTED';
      return actual.toEscrow(e);
    },
    resolveDisputeAsRefund: async (o: any) => {
      const e = byId(o.escrowId);
      if (e.status !== 'DISPUTED') throw new actual.PaylukError('No dispute found for this escrow', 400, 'BAD_REQUEST');
      Object.assign(e, { state: 'CLOSED', status: 'REFUNDED' });
      fake.resolves++;
      return actual.toEscrow(e);
    },
    claimEscrow: async (t: string) => {
      const e = fake.escrows.get(t);
      Object.assign(e, { state: 'CLOSED', status: 'CLAIMED' });
      fake.claims++;
      return actual.toEscrow(e);
    },
  };
});

import Order from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import * as payments from '@/services/payment.service';
import { getOrdersForUser, getReceivedOrdersForSeller } from '@/services/order.service';

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
  Object.assign(fake, { confirms: 0, disputes: [], resolves: 0, claims: 0 });
  await Promise.all([Order, User, Business, Product].map(m => (m as any).deleteMany({})));
});

let seq = 0;
async function scene(opts: { type?: 'normal' | 'protected'; paid?: boolean; claimableAt?: Date } = {}) {
  seq++;
  const mk = (f: string, l: string) =>
    User.create({ firstName: f, lastName: l, username: `x${seq}${f}`, email: `x${seq}${f}@example.com`, paylukCustomerId: `cus_${seq}_${f}`, phone: '08011112222' });
  const buyer = await mk('Amaka', 'Okafor');
  const seller = await mk('Tunde', 'Bello');
  const stranger = await mk('Sade', 'Ade');
  const shop = await Business.create({ owner: seller._id, businessName: 'Tunde Store', contact: { phone: '08055556666' }, location: { type: 'Point', coordinates: [3.38, 6.52] } });
  const product = await Product.create({ business: shop._id, name: 'Rice', price: 5000, stock: 8, media: [] });
  const paid = opts.paid ?? true;
  const token = `PY_${seq}`;
  fake.escrows.set(token, { id: `esc_${seq}`, paymentToken: token, amount: 10000, fee: 200, additionalFee: 0, whoPays: 'buyer', state: paid ? 'OPENED' : 'AWAITING_PAYMENT', status: paid ? 'ONGOING' : 'PENDING' });
  const order = await Order.create({
    user: buyer._id,
    business: shop._id,
    orderNumber: `ORD-T${seq}`,
    items: [{ product: product._id, name: 'Rice', price: 5000, quantity: 2 }],
    totalAmount: 10000,
    itemsTotal: 10000,
    shippingAddress: { phone: '08099990000' },
    paymentMethod: 'card',
    paymentType: opts.type ?? 'protected',
    paymentStatus: paid ? 'paid' : 'pending',
    status: paid ? 'processing' : 'pending',
    paylukPaymentToken: token,
    paylukEscrowId: `esc_${seq}`,
    stockReserved: !paid,
    ...(paid ? { paidAt: new Date() } : {}),
    ...(opts.claimableAt ? { claimableAt: opts.claimableAt } : {}),
  });
  const id = String(order._id);
  return { buyer: String(buyer._id), seller: String(seller._id), stranger: String(stranger._id), order, id, product };
}

describe('Confirm delivery (Part 3)', () => {
  it('only the buyer of the order; a second confirm changes nothing', async () => {
    const s = await scene();
    await expect(payments.confirmReceived(s.id, s.seller)).rejects.toMatchObject({ status: 403 });
    await expect(payments.confirmReceived(s.id, s.stranger)).rejects.toMatchObject({ status: 403 });
    await expect(payments.confirmReceived(s.id, s.buyer)).resolves.toMatchObject({ payoutReleased: true });
    await expect(payments.confirmReceived(s.id, s.buyer)).rejects.toMatchObject({ status: 409 });
    expect(fake.confirms).toBe(1);
  });
});

describe('Report a problem / respond / claim (Part 3)', () => {
  it('a stranger cannot report, respond or claim', async () => {
    const s = await scene({ claimableAt: new Date(Date.now() - 1000) });
    await expect(payments.submitOrderDispute(s.id, s.stranger, 'x')).rejects.toMatchObject({ status: 403 });
    await expect(payments.claimOrderFunds(s.id, s.stranger)).rejects.toMatchObject({ status: 403 });
    expect(fake.disputes).toHaveLength(0);
    expect(fake.claims).toBe(0);
  });

  it('buyer reports once; the seller can respond once, only after a report', async () => {
    const s = await scene();
    await expect(payments.submitOrderDispute(s.id, s.seller, 'mine')).rejects.toMatchObject({ status: 400 });
    await payments.submitOrderDispute(s.id, s.buyer, 'Never arrived');
    await expect(payments.submitOrderDispute(s.id, s.buyer, 'again')).rejects.toMatchObject({ status: 400 });
    await payments.submitOrderDispute(s.id, s.seller, 'It was delivered');
    await expect(payments.submitOrderDispute(s.id, s.seller, 'again')).rejects.toMatchObject({ status: 400 });
    expect(fake.disputes).toHaveLength(2);
  });

  it('Normal Payment: no confirm, no report', async () => {
    const s = await scene({ type: 'normal' });
    await expect(payments.confirmReceived(s.id, s.buyer)).rejects.toMatchObject({ code: 'NORMAL_PAYMENT' });
    await expect(payments.submitOrderDispute(s.id, s.buyer, 'x')).rejects.toMatchObject({ status: 400 });
  });
});

describe('Cancel (buyer, unpaid only)', () => {
  it('cancels an unpaid order and puts the held stock back; others cannot', async () => {
    const s = await scene({ paid: false });
    await Product.updateOne({ _id: s.product._id }, { $inc: { stock: -2 } }); // the checkout hold
    await expect(payments.cancelOrder(s.id, s.seller)).rejects.toMatchObject({ status: 403 });
    await expect(payments.cancelOrder(s.id, s.buyer)).resolves.toEqual({ status: 'cancelled' });
    expect((await Product.findById(s.product._id).lean())?.stock).toBe(8);
    await expect(payments.cancelOrder(s.id, s.buyer)).rejects.toMatchObject({ status: 400 });
  });

  it('a paid order cannot be cancelled', async () => {
    const s = await scene();
    await expect(payments.cancelOrder(s.id, s.buyer)).rejects.toMatchObject({ status: 400 });
  });
});

describe('Reject order and Get my money back', () => {
  it('seller rejects, stock returns once, buyer gets a full refund through a dispute', async () => {
    const s = await scene();
    await expect(payments.rejectOrder(s.id, s.buyer)).rejects.toMatchObject({ status: 403 });
    await expect(payments.rejectOrder(s.id, s.seller, 'Out of rice')).resolves.toEqual({ rejected: true });
    await expect(payments.rejectOrder(s.id, s.seller)).rejects.toMatchObject({ status: 400 });
    expect((await Product.findById(s.product._id).lean())?.stock).toBe(10);

    await expect(payments.confirmReceived(s.id, s.buyer)).rejects.toMatchObject({ status: 400 });
    await expect(payments.requestRefund(s.id, s.stranger)).rejects.toMatchObject({ status: 403 });
    await expect(payments.requestRefund(s.id, s.buyer)).resolves.toEqual({ refunded: true, pending: false });
    expect(fake.disputes).toHaveLength(1);
    expect(fake.resolves).toBe(1);
    const o = await Order.findById(s.id).lean();
    expect(o?.status).toBe('refunded');
    expect((await Product.findById(s.product._id).lean())?.stock).toBe(10); // not added twice
  });

  it('Normal Payment cannot be rejected here', async () => {
    const s = await scene({ type: 'normal' });
    await expect(payments.rejectOrder(s.id, s.seller)).rejects.toMatchObject({ code: 'NORMAL_PAYMENT' });
  });
});

describe('Claim payment (seller)', () => {
  it('only after the delivery window plus a day', async () => {
    const early = await scene({ claimableAt: new Date(Date.now() + 3600_000) });
    const list = await getReceivedOrdersForSeller(early.seller);
    expect(list[0].actions.claimPayment).toBe(false);
    const due = await scene({ claimableAt: new Date(Date.now() - 1000) });
    expect((await getReceivedOrdersForSeller(due.seller))[0].actions.claimPayment).toBe(true);
    await expect(payments.claimOrderFunds(due.id, due.seller)).resolves.toMatchObject({ payoutReleased: true });
  });
});

describe('Order lists', () => {
  it('Shop Orders show "Amaka O." and no phone or payment codes; My Orders show the shop', async () => {
    const s = await scene();
    const shopList = await getReceivedOrdersForSeller(s.seller);
    expect(shopList[0]).toMatchObject({ buyerName: 'Amaka O.', role: 'seller', actions: expect.objectContaining({ reject: true, markReady: true }) });
    const body = JSON.stringify(shopList);
    for (const secret of ['0809999', '08011112222', 'Okafor', 'PY_', 'esc_', 'example.com', 'cus_']) expect(body).not.toContain(secret);

    const mine = await getOrdersForUser(s.buyer);
    expect(mine[0]).toMatchObject({ shop: expect.objectContaining({ businessName: 'Tunde Store' }), actions: expect.objectContaining({ confirmDelivery: true, reportProblem: true }) });
    expect(JSON.stringify(mine)).not.toContain('PY_');
    // The buyer gets the shop's phone (for WhatsApp); the seller list never has it.
    expect(mine[0].shop?.phone).toBe('08055556666');
    expect(shopList[0].shop?.phone).toBeNull();
    expect(String(new Types.ObjectId()).length).toBe(24);
  });
});
