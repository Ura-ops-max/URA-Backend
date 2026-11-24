/** Checkout pricing and markOrderReady booking with Chowdeck (Chowdeck and Fez faked). */
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

const chowdeck = { quote: jest.fn(), create: jest.fn(), booking: jest.fn(), cancel: jest.fn() };
jest.mock('@/services/chowdeck.service', () => {
  const actual = jest.requireActual('@/services/chowdeck.service');
  return {
    ...actual,
    getChowdeckQuote: (...a: any[]) => chowdeck.quote(...a),
    createChowdeckDelivery: (...a: any[]) => chowdeck.create(...a),
    getChowdeckBooking: (...a: any[]) => chowdeck.booking(...a),
    cancelChowdeckDelivery: (...a: any[]) => chowdeck.cancel(...a),
  };
});
const fez = { cost: jest.fn(), create: jest.fn() };
jest.mock('@/services/fez.service', () => {
  const actual = jest.requireActual('@/services/fez.service');
  return {
    ...actual,
    isFezConfigured: () => true,
    getDeliveryCost: (...a: any[]) => fez.cost(...a),
    createDeliveryOrder: (...a: any[]) => fez.create(...a),
  };
});

import Order from '@/models/order-model';
import Cart from '@/models/cart-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { ChowdeckError } from '@/services/chowdeck.service';
import { checkoutFromCart, getOrderByIdForUser, markOrderReady } from '@/services/order.service';
import { cancelCourierBooking } from '@/services/courier.service';

const ENV = { ...process.env };
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
  process.env.CHOWDECK_API_KEY = 'k';
  process.env.CHOWDECK_CITIES = 'Lagos,Abuja';
  notices.length = 0;
  Object.values(chowdeck).forEach(f => f.mockReset());
  Object.values(fez).forEach(f => f.mockReset());
  fez.cost.mockResolvedValue({ cost: 3000, vat: 225, totalCost: 3225, state: 'Oyo', raw: {} });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await Promise.all([Order, Cart, User, Business, Product].map(m => (m as any).deleteMany({})));
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

let n = 0;
async function scene() {
  n++;
  const buyer = await User.create({ firstName: 'Amaka', lastName: 'Okafor', username: `cb${n}`, email: `cb${n}@example.com`, paylukCustomerId: `cus_b${n}` });
  const seller = await User.create({ firstName: 'Tunde', username: `cs${n}`, email: `cs${n}@example.com`, paylukCustomerId: `cus_s${n}` });
  const shop = await Business.create({
    owner: seller._id,
    businessName: 'Tunde Boots',
    address: { fullAddress: '31 Allen Ave', city: 'Ikeja', state: 'Lagos' },
    contact: { phone: '+2348011111111' },
    location: { type: 'Point', coordinates: [3.35, 6.6] },
  });
  const product = await Product.create({ business: shop._id, name: 'Chelsea Boot', category: 'Shoes', price: 15000, stock: 5, media: [] });
  return { buyer, seller, shop, product };
}

async function paidChowdeckOrder() {
  const s = await scene();
  const order = await Order.create({
    user: s.buyer._id,
    business: s.shop._id,
    orderNumber: `ORD-CD${n}`,
    items: [{ product: s.product._id, name: 'Chelsea Boot', price: 15000, quantity: 1 }],
    totalAmount: 17100,
    itemsTotal: 15000,
    deliveryFee: 2100,
    deliveryFeeCharged: 2100,
    deliveryMethod: 'delivery',
    deliveryProvider: 'chowdeck',
    chowdeckCost: 2100,
    shippingAddress: { fullAddress: '1 Admiralty Way', city: 'Lekki', state: 'Lagos', phone: '08022222222', latitude: 6.44, longitude: 3.47 },
    paymentMethod: 'card',
    paymentType: 'protected',
    paymentStatus: 'paid',
    status: 'processing',
  });
  return { ...s, order };
}

describe('checkout', () => {
  it('same city: priced by Chowdeck on the server, stored with the provider', async () => {
    const s = await scene();
    await Cart.create({ user: s.buyer._id, items: [{ product: s.product._id, quantity: 1 }] });
    chowdeck.quote.mockResolvedValue({ feeId: 9, totalNaira: 2100 });
    const r = await checkoutFromCart(
      String(s.buyer._id),
      { fullAddress: '1 Admiralty Way', city: 'Lekki', state: 'Lagos', phone: '08022222222', latitude: 6.44, longitude: 3.47 },
      'card',
      undefined,
      undefined,
      { deliveryMethod: 'delivery', deliveryFee: 1 } // a fee from the client is ignored
    );
    const o: any = await Order.findById(r.order._id).lean();
    expect(o).toMatchObject({ deliveryProvider: 'chowdeck', deliveryFee: 2100, deliveryFeeCharged: 2100, chowdeckCost: 2100 });
    expect(o.fezCost).toBeUndefined();
    expect(o.shippingAddress).toMatchObject({ latitude: 6.44, longitude: 3.47 });
    expect(fez.cost).not.toHaveBeenCalled();
  });

  it('interstate: Fez as today', async () => {
    const s = await scene();
    await Cart.create({ user: s.buyer._id, items: [{ product: s.product._id, quantity: 1 }] });
    const r = await checkoutFromCart(String(s.buyer._id), { fullAddress: 'x', city: 'Ibadan', state: 'Oyo', phone: '08022222222' }, 'card', undefined, undefined, { deliveryMethod: 'delivery' });
    const o: any = await Order.findById(r.order._id).lean();
    expect(o).toMatchObject({ deliveryProvider: 'fez', deliveryFee: 3225, fezCost: 3225 });
    expect(chowdeck.quote).not.toHaveBeenCalled();
  });
});

describe('markOrderReady', () => {
  it('re-quotes, then creates with reference = order number and the saved PIN', async () => {
    const { order, seller } = await paidChowdeckOrder();
    chowdeck.quote.mockResolvedValue({ feeId: 55, totalNaira: 2300 });
    chowdeck.create.mockResolvedValue({ id: 3122, reference: order.orderNumber, trackingUrl: 'https://track.chowdeck.com/x', status: 'preparing', priceNaira: 2300 });

    const done = await markOrderReady(String(order._id), String(seller._id));

    expect(chowdeck.quote.mock.invocationCallOrder[0]).toBeLessThan(chowdeck.create.mock.invocationCallOrder[0]);
    expect(chowdeck.quote).toHaveBeenCalledWith({
      pickup: { address: '31 Allen Ave, Ikeja, Lagos', lat: 6.6, lng: 3.35 },
      dropoff: { address: '1 Admiralty Way, Lekki, Lagos', lat: 6.44, lng: 3.47 },
      orderValueNaira: 15000,
    });
    const body = chowdeck.create.mock.calls[0][0];
    expect(body).toMatchObject({
      feeId: 55,
      reference: order.orderNumber,
      itemType: 'Shoes',
      orderValueNaira: 15000,
      sender: { name: 'Tunde Boots', phone: '+2348011111111' },
      recipient: { name: 'Amaka Okafor', phone: '08022222222' },
    });
    const saved: any = await Order.findById(order._id).select('+deliveryPin').lean();
    expect(body.deliveryPin).toBe(saved.deliveryPin);
    expect(saved.deliveryPin).toBeGreaterThanOrEqual(1000);
    expect(saved.deliveryPin).toBeLessThanOrEqual(9999);
    expect(saved).toMatchObject({
      status: 'shipped',
      fulfilment: 'chowdeck',
      trackingNumber: order.orderNumber,
      trackingUrl: 'https://track.chowdeck.com/x',
      chowdeckCost: 2300,
      deliveryStatus: 'booked',
    });
    expect(saved.riderBookedAt).toBeTruthy();
    expect((done as any).deliveryPin).toBeUndefined(); // not on the seller's copy
    expect(notices).toContain('SHIPPED');
    expect(fez.create).not.toHaveBeenCalled();
  });

  it('a retry after a booking already went through is safe (duplicate reference)', async () => {
    const { order, seller } = await paidChowdeckOrder();
    chowdeck.quote.mockResolvedValue({ feeId: 56, totalNaira: 2100 });
    chowdeck.create.mockRejectedValue(new ChowdeckError('Possible duplicate order. Please send unique reference', 400));
    chowdeck.booking.mockResolvedValue({ id: 3122, reference: order.orderNumber, status: 'awaiting_pickup', priceNaira: 2100 });

    await markOrderReady(String(order._id), String(seller._id));
    expect(chowdeck.booking).toHaveBeenCalledWith(order.orderNumber);
    expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'shipped', fulfilment: 'chowdeck', trackingNumber: order.orderNumber });
  });

  it('the same PIN is sent again on a retry after a failure', async () => {
    const { order, seller } = await paidChowdeckOrder();
    chowdeck.quote.mockResolvedValue({ feeId: 57, totalNaira: 2100 });
    chowdeck.create.mockRejectedValueOnce(new ChowdeckError('Chowdeck is down', 503));
    await expect(markOrderReady(String(order._id), String(seller._id))).rejects.toMatchObject({ status: 502 });
    expect(notices).toContain('DELIVERY_BOOKING_FAILED');
    expect((await Order.findById(order._id).lean())?.status).toBe('processing');

    chowdeck.create.mockResolvedValueOnce({ id: 1, reference: order.orderNumber, status: 'preparing', priceNaira: 2100 });
    await markOrderReady(String(order._id), String(seller._id));
    expect(chowdeck.create.mock.calls[1][0].deliveryPin).toBe(chowdeck.create.mock.calls[0][0].deliveryPin);
  });

  it('order details: the buyer sees the PIN, the seller never does', async () => {
    const { order, seller, buyer } = await paidChowdeckOrder();
    await Order.updateOne({ _id: order._id }, { $set: { deliveryPin: 4821 } });
    const asBuyer: any = await getOrderByIdForUser(String(order._id), String(buyer._id));
    const asSeller: any = await getOrderByIdForUser(String(order._id), String(seller._id));
    expect(JSON.parse(JSON.stringify(asBuyer.order)).deliveryPin).toBe(4821);
    expect(JSON.stringify(asSeller.order)).not.toContain('4821');
  });
});

describe('cancellation', () => {
  it('before pickup: the Chowdeck delivery is cancelled', async () => {
    const { order } = await paidChowdeckOrder();
    await Order.updateOne({ _id: order._id }, { $set: { fulfilment: 'chowdeck', trackingNumber: order.orderNumber, deliveryStatus: 'awaiting_pickup' } });
    chowdeck.cancel.mockResolvedValue({ status: 'cancelled', refundNaira: 2100 });
    const o = await Order.findById(order._id).lean();
    expect(await cancelCourierBooking(o, 'Order refunded')).toBe('cancelled');
    expect(chowdeck.cancel).toHaveBeenCalledWith(order.orderNumber, 'Order refunded');
    expect((await Order.findById(order._id).lean())?.deliveryStatus).toBe('cancelled');
  });

  it('after pickup: not cancelled, flagged for an admin', async () => {
    const { order } = await paidChowdeckOrder();
    await Order.updateOne({ _id: order._id }, { $set: { fulfilment: 'chowdeck', trackingNumber: order.orderNumber, deliveryStatus: 'in_transit' } });
    const o = await Order.findById(order._id).lean();
    expect(await cancelCourierBooking(o, 'Order refunded')).toBe('refused');
    expect(chowdeck.cancel).not.toHaveBeenCalled();
    expect((await Order.findById(order._id).lean())?.adminFlag?.reason).toMatch(/in_transit/);
  });

  it('not a Chowdeck order: nothing to do', async () => {
    const { order } = await paidChowdeckOrder();
    expect(await cancelCourierBooking(await Order.findById(order._id).lean(), 'x')).toBe('not_needed');
  });
});
