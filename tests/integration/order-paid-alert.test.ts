/**
 * Seller alert for a new paid order (Part 6): email subject "New paid order
 * <number>", and a live "order_paid" event to the seller only, with names but
 * no contact details.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({ config: { frontend: { url: 'https://example.test' }, rateLimit: {} } }));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
jest.mock('@/services/track-event.service', () => ({ trackEvent: async () => undefined }));
const emails: { to: string; title: string; subject: string | undefined }[] = [];
jest.mock('@/templates/emails', () => ({
  sendOrderEmail: async (to: string, title: string, _m: string, _u: string, subject?: string) => {
    emails.push({ to, title, subject });
  },
}));
const emitted: { room: string; event: string; payload: any }[] = [];
jest.mock('@/services/socket.service', () => ({
  socketService: {
    emitTo: (room: string, event: string, payload: any) => emitted.push({ room, event, payload }),
    isOnline: () => false,
    sendNotification: () => undefined,
  },
}));

import Order from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { notifyOrderEvent } from '@/services/order-events.service';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

it('emails the seller "New paid order <number>" and alerts only the seller, live', async () => {
  const buyer = await User.create({ firstName: 'Amaka', lastName: 'Okafor', username: 'pa1', email: 'buyer@example.com', phone: '08011112222' });
  const seller = await User.create({ firstName: 'Tunde', lastName: 'Bello', username: 'pa2', email: 'seller@example.com' });
  const shop = await Business.create({ owner: seller._id, businessName: 'Mama Put', location: { type: 'Point', coordinates: [3.38, 6.52] } });
  const order = await Order.create({
    user: buyer._id,
    business: shop._id,
    orderNumber: 'ORD-1042',
    items: [{ product: new mongoose.Types.ObjectId(), name: 'Chicken shawarma', price: 3000, quantity: 2 }],
    totalAmount: 6000,
    shippingAddress: { phone: '08099990000', fullAddress: '1 Road' },
    paymentMethod: 'card',
    paymentType: 'protected',
    paymentStatus: 'paid',
    status: 'processing',
  });

  await notifyOrderEvent(order, 'PAID');

  const toSeller = emails.find(e => e.to === 'seller@example.com');
  expect(toSeller?.subject).toBe('New paid order ORD-1042');
  const toBuyer = emails.find(e => e.to === 'buyer@example.com');
  expect(toBuyer?.subject).toBeUndefined(); // buyer keeps "URA: Payment confirmed"

  expect(emitted).toEqual([
    {
      room: String(seller._id),
      event: 'order_paid',
      payload: { orderId: String(order._id), orderNumber: 'ORD-1042', buyerFirstName: 'Amaka', shopName: 'Mama Put' },
    },
  ]);
  expect(JSON.stringify(emitted)).not.toMatch(/0809|0801|example\.com|1 Road|Okafor/);

  // Other events never sound the alert.
  emitted.length = 0;
  await notifyOrderEvent(order, 'READY_FOR_PICKUP');
  expect(emitted).toEqual([]);
});
