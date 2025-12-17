// backend/validators/post.validator.ts
import Joi from 'joi';
import {
  createSchema,
} from './common.schemas';

export const createPostField = {
  type: Joi.string().valid('POST', 'PRODUCT').required(),
  caption: Joi.string().required(),
  media: Joi.array().items(Joi.string()).min(1).messages({
    'array.min': 'Please upload at least one image or video.'
  }),
  
  // Conditional fields for PRODUCT
  productName: Joi.when('type', { is: 'PRODUCT', then: Joi.string().required() }),
  category: Joi.when('type', { is: 'PRODUCT', then: Joi.string().required() }),
  description: Joi.when('type', { is: 'PRODUCT', then: Joi.string().required() }),
  price: Joi.when('type', { is: 'PRODUCT', then: Joi.number().min(0).required() }),
  stock: Joi.when('type', { is: 'PRODUCT', then: Joi.number().min(0).required() }),
  size: Joi.when('type', { is: 'PRODUCT', then: Joi.string().allow('').optional() }),
};

export const postSchema = {
  createPost: createSchema(createPostField).min(1).messages({
    'object.min': 'At least one field is required for update',
  })
};

export const createPostSchema = { body: postSchema.createPost };
