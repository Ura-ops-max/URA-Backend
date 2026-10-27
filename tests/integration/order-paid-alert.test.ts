/**
 * "Just paid" pop-up text (Part 2), built on the server so the app, the push
 * and the email use the same words, and the privacy rule: first name and last
 * initial only, never a phone number, email or full name.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/config/env.config', () => ({ config: { frontend: { url: 'https://example.test' }, rateLimit: {} } }));
jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));
const notices: any[] = [];
jest.mock('@/services/track-event.service', () => ({ trackEvent: async (e: any) => void notices.push(e) }));
const emails: { to: string; title: string; message: string; subject: string | undefined }[] = [];
jest.mock('@/templates/emails', () => ({
  sendOrderEmail: async (to: string, title: string, message: string, _u: string, subject?: string) => {
    emails.push({ to, title, message, subject });
  },
}));

import Order from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { notifyOrderEvent, orderItemsSummary, paidPopupText } from '@/services/order-events.service';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const amaka = { firstName: 'Amaka', lastName: 'Okafor' };

describe('pop-up text', () => {
  it('one item', () => {
    expect(paidPopupText(amaka, [{ name: 'Chicken shawarma', quantity: 2, price: 6000 }])).toBe(
      'Amaka O. just paid for 2x Chicken shawarma. ₦12,000'
    );
  });

  it('several items', () => {
    const items = [
      { name: 'Chicken shawarma', quantity: 2, price: 5000 },
      { name: 'Fanta', quantity: 1, price: 2000 },
    ];
    expect(paidPopupText(amaka, items)).toBe('Amaka O. just paid for 2x Chicken shawarma and 1 more item. ₦12,000');
    expect(orderItemsSummary([...items, { name: 'Water', quantity: 3 }])).toBe('2x Chicken shawarma and 2 more items');
  });

  it('a long item name is shortened', () => {
    const long = 'Jollof rice with fried plantain, peppered turkey and coleslaw (family size)';
    const text = orderItemsSummary([{ name: long, quantity: 1 }]);
    expect(text.startsWith('1x Jollof rice with fried plantain')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(3 + 40);
  });

  it('keeps the whole line, amount included, within about 2 phone lines', () => {
    const long = 'Jollof rice with fried plantain, peppered turkey and coleslaw (family size)';
    const text = paidPopupText({ firstName: 'Chukwuemeka', lastName: 'Okonkwo' }, [
      { name: long, quantity: 10, price: 12500 },
      { name: 'Fanta', quantity: 1, price: 0 },
      { name: 'Water', quantity: 1, price: 0 },
    ]);
    expect(text.length).toBeLessThanOrEqual(68);
    expect(text.endsWith('and 2 more items. ₦125,000')).toBe(true);
    expect(text.startsWith('Chukwuemeka O. just paid for 10x Jollof')).toBe(true);
  });

  it('uses the amount given (the items total)', () => {
    expect(paidPopupText(amaka, [{ name: 'Rice', quantity: 1, price: 1 }], 12000)).toBe('Amaka O. just paid for 1x Rice. ₦12,000');
  });
});

describe('notifyOrderEvent', () => {
  it('sends the same words to the pop-up, push and email, with no contact details anywhere', async () => {
    const buyer = await User.create({ ...amaka, username: 'pt1', email: 'amaka.secret@example.com', phone: '08031112222' });
    const seller = await User.create({ firstName: 'Tunde', lastName: 'Bello', username: 'pt2', email: 'seller@example.com' });
    const shop = await Business.create({ owner: seller._id, businessName: 'Mama Put', location: { type: 'Point', coordinates: [3.38, 6.52] } });
    const order = await Order.create({
      user: buyer._id,
      business: shop._id,
      orderNumber: 'ORD-1042',
      items: [
        { product: new mongoose.Types.ObjectId(), name: 'Chicken shawarma', price: 5000, quantity: 2 },
        { product: new mongoose.Types.ObjectId(), name: 'Fanta', price: 2000, quantity: 1 },
      ],
      itemsTotal: 12000,
      totalAmount: 13500,
      deliveryMethod: 'pickup',
      shippingAddress: { phone: '08099990000', fullAddress: '1 Admiralty Way' },
      paymentMethod: 'card',
      paymentType: 'protected',
      paymentStatus: 'paid',
      status: 'processing',
    });

    await notifyOrderEvent(order, 'PAID');
    const toSeller = notices.find(n => n.targetId === String(seller._id));
    const line = 'Amaka O. just paid for 2x Chicken shawarma and 1 more item. ₦12,000';
    expect(toSeller.notificationData.summary).toBe(line); // pop-up and push
    expect(toSeller.notificationData.message.startsWith(line)).toBe(true); // in-app message
    const email = emails.find(e => e.to === 'seller@example.com')!;
    expect(email.message.startsWith(line)).toBe(true);
    expect(email.subject).toBe('New paid order ORD-1042');

    // The privacy rule, for every event the seller and buyer can get.
    for (const ev of ['READY_FOR_PICKUP', 'SELLER_DELIVERING', 'SHIPPED', 'DELIVERED', 'DISPUTED', 'REJECTED'] as const) {
      await notifyOrderEvent(order, ev);
    }
    const sellerText = JSON.stringify(notices.filter(n => n.targetId === String(seller._id)).map(n => n.notificationData));
    for (const secret of ['Okafor', '0809999', '0803111', 'amaka.secret', '@example.com', '1 Admiralty']) {
      expect(sellerText).not.toContain(secret);
    }
  });
});
