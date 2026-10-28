/** The read-only audit counts the right things. */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('@/services/ai-embed.service', () => ({ embedImageUrl: async () => null }));

import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { auditCounts } from '@/scripts/seo-audit';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {});
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

it('counts shops and products missing each field', async () => {
  const owner = await User.create({ firstName: 'A', username: 'aud1', email: 'aud1@example.com' });
  const owner2 = await User.create({ firstName: 'B', username: 'aud2', email: 'aud2@example.com' });
  const full = await Business.create({
    owner: owner._id,
    businessName: 'Full Shop',
    about: 'We sell good shoes',
    businessLogo: 'https://img/logo.png',
    address: { city: 'Ikeja', state: 'Lagos' },
    location: { type: 'Point', coordinates: [3.3, 6.5] },
  });
  await Business.create({ owner: owner2._id, businessName: 'Bare Shop', location: { type: 'Point', coordinates: [3.3, 6.5] } });
  await Product.create({ business: full._id, name: 'Boot', price: 5000, stock: 1, media: ['https://img/1.jpg'] });
  await Product.create({ business: full._id, name: 'Free', price: 0, stock: 1, media: [] });
  await Product.create({ business: full._id, name: 'Hidden', price: 10, stock: 1, media: ['x'], isHidden: true });

  const r = await auditCounts();
  expect(r.shops).toMatchObject({ total: 2, noSlug: 0, noAbout: 1, noCityOrState: 1, noLogo: 1, noVisibleProducts: 1 });
  expect(r.products).toMatchObject({ total: 3, visible: 2, noPhoto: 1, noPrice: 1 });
});
