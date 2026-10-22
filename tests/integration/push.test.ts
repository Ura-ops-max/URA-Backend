/**
 * Web push (Part 6): subscriptions belong to the signed-in user, only https
 * endpoints are accepted, a user can only remove their own, and gone
 * subscriptions (404/410) are cleaned up. web-push itself is faked.
 */
import express from 'express';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const sent: { endpoint: string; payload: any }[] = [];
const gone = new Set<string>();
jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      if (gone.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    },
  },
}));
jest.mock('@/middleware/passport-auth', () => ({
  requireAuth: (req: any, res: any, next: any) =>
    req.headers['x-test-user'] ? ((req.user = { _id: req.headers['x-test-user'] }), next()) : res.status(401).json({ message: 'Unauthorized' }),
}));

import pushRoutes from '@/routes/push.routes';
import { PushSubscription } from '@/models/push-subscription-model';
import { sendPushToUser } from '@/services/push.service';

const app = express();
app.use(express.json());
app.use('/push', pushRoutes);

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
  sent.length = 0;
  gone.clear();
  await PushSubscription.deleteMany({});
  process.env.VAPID_PUBLIC_KEY = 'test-public';
  process.env.VAPID_PRIVATE_KEY = 'test-private';
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';
});

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });
const alice = String(new Types.ObjectId());
const bob = String(new Types.ObjectId());

describe('POST /push/subscriptions', () => {
  it('needs a signed-in user', async () => {
    expect((await request(app).post('/push/subscriptions').send(sub('https://push.example/1'))).status).toBe(401);
  });

  it('only accepts https endpoints with both keys', async () => {
    for (const bad of [sub('http://push.example/1'), sub('javascript:alert(1)'), { endpoint: 'https://push.example/1' }, {}]) {
      expect((await request(app).post('/push/subscriptions').set('x-test-user', alice).send(bad)).status).toBe(400);
    }
    expect(await PushSubscription.countDocuments()).toBe(0);
  });

  it('saves the subscription for the signed-in user', async () => {
    const res = await request(app).post('/push/subscriptions').set('x-test-user', alice).send(sub('https://push.example/a'));
    expect(res.status).toBe(201);
    const saved = await PushSubscription.findOne({ endpoint: 'https://push.example/a' }).lean();
    expect(String(saved?.user)).toBe(alice);
  });
});

describe('DELETE /push/subscriptions', () => {
  it("can't remove another user's subscription", async () => {
    await request(app).post('/push/subscriptions').set('x-test-user', alice).send(sub('https://push.example/a'));
    const res = await request(app).delete('/push/subscriptions').set('x-test-user', bob).send({ endpoint: 'https://push.example/a' });
    expect(res.body.removed).toBe(0);
    expect(await PushSubscription.countDocuments()).toBe(1);
    const own = await request(app).delete('/push/subscriptions').set('x-test-user', alice).send({ endpoint: 'https://push.example/a' });
    expect(own.body.removed).toBe(1);
  });
});

describe('sendPushToUser', () => {
  it("sends to the user's browsers only and removes gone ones", async () => {
    await PushSubscription.create([
      { user: alice, ...sub('https://push.example/a1') },
      { user: alice, ...sub('https://push.example/a2') },
      { user: bob, ...sub('https://push.example/b1') },
    ]);
    gone.add('https://push.example/a2');
    const n = await sendPushToUser(alice, { title: 'New paid order ORD-1', body: 'From Amaka', url: '/dashboard/orders/1' });
    expect(n).toBe(1);
    expect(sent).toEqual([{ endpoint: 'https://push.example/a1', payload: { title: 'New paid order ORD-1', body: 'From Amaka', url: '/dashboard/orders/1' } }]);
    expect(await PushSubscription.exists({ endpoint: 'https://push.example/a2' })).toBeNull();
  });

  it('does nothing when VAPID is not set', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    await PushSubscription.create({ user: alice, ...sub('https://push.example/a1') });
    expect(await sendPushToUser(alice, { title: 't', body: 'b', url: '/' })).toBe(0);
    expect(sent).toEqual([]);
  });
});
