/**
 * Web push for order notices (Part 1): every order notice to a user is also
 * pushed, with the same title and words; other notices are not.
 */
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const pushed: { userId: string; payload: any }[] = [];
jest.mock('@/services/push.service', () => ({
  sendPushToUser: async (userId: string, payload: any) => {
    pushed.push({ userId, payload });
    return 1;
  },
}));
jest.mock('@/services/socket.service', () => ({
  socketService: { isOnline: () => false, sendNotification: () => undefined },
}));

import { trackEvent } from '@/services/track-event.service';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(() => (pushed.length = 0));

const user = String(new Types.ObjectId());
const order = String(new Types.ObjectId());
const note = (modelType: string) => ({
  type: 'BUSINESS',
  title: 'New paid order ORD-1',
  message: 'Amaka O. just paid for 2x Chicken shawarma. ₦12,000',
  sender: String(new Types.ObjectId()),
  senderModel: 'User',
  relatedId: order,
  modelType,
});

it('pushes order notices with the same words, opening the order', async () => {
  await trackEvent({ targetId: user, targetModel: 'User', type: 'NOTIFICATION', notificationData: note('Order') });
  await new Promise(r => setTimeout(r, 20));
  expect(pushed).toEqual([
    {
      userId: user,
      payload: { title: 'New paid order ORD-1', body: 'Amaka O. just paid for 2x Chicken shawarma. ₦12,000', url: `/dashboard/orders/${order}` },
    },
  ]);
});

it('does not push other notices, or notices to a shop profile', async () => {
  await trackEvent({ targetId: user, targetModel: 'User', type: 'NOTIFICATION', notificationData: note('Post') });
  await trackEvent({ targetId: user, targetModel: 'Business', type: 'NOTIFICATION', notificationData: note('Order') });
  await new Promise(r => setTimeout(r, 20));
  expect(pushed).toEqual([]);
});
