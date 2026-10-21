import { createProductSchema } from '../../../src/validators/product.validators';
import { createPostField } from '../../../src/validators/post.validators';
import Joi from 'joi';

describe('a product with no description and no photo is valid', () => {
  it('POST /products', () => {
    const { error, value } = createProductSchema.body.validate({ name: 'Bread', price: 1200, stock: 10 });
    expect(error).toBeUndefined();
    expect(value.description).toBe('');
    expect(value.media).toEqual([]);
  });

  it('POST /posts (type PRODUCT)', () => {
    const schema = Joi.object(createPostField).unknown(true);
    const { error } = schema.validate({ type: 'PRODUCT', productName: 'Bread', price: 1200, stock: 3, description: '' });
    expect(error).toBeUndefined();
  });

  it('still rejects a product with no name or price', () => {
    expect(createProductSchema.body.validate({ price: 100, stock: 1 }).error).toBeDefined();
    expect(createProductSchema.body.validate({ name: 'Bread', stock: 1 }).error).toBeDefined();
  });
});
