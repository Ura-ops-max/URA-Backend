/** Order notices carry only the order's id and number, never the whole order. */
import { trimRelatedOrders } from '@/controllers/log.controller';

describe('trimRelatedOrders', () => {
  it('keeps only _id and orderNumber of a populated order', () => {
    const [n] = trimRelatedOrders([
      {
        _id: 'n1',
        modelType: 'Order',
        relatedId: {
          _id: 'o1',
          orderNumber: 'ORD-1',
          paylukPaymentToken: 'PY_SECRET',
          shippingAddress: { phone: '08099990000', fullAddress: '1 Road' },
        },
      },
    ]);
    expect(n.relatedId).toEqual({ _id: 'o1', orderNumber: 'ORD-1' });
    expect(JSON.stringify(n)).not.toMatch(/PY_SECRET|0809|1 Road/);
  });

  it('leaves other notices alone', () => {
    const post = { _id: 'n2', modelType: 'Post', relatedId: { _id: 'p1', content: 'hi' } };
    const chat = { _id: 'n3', relatedId: 'c1' };
    expect(trimRelatedOrders([post, chat])).toEqual([post, chat]);
  });
});
