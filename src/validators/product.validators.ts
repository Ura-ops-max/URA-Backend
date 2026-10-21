import Joi from 'joi';
import { createSchema } from './common.schemas';

const createProductBody = createSchema({
  name: Joi.string().trim().min(2).max(120).required().messages({
    'any.required': 'Product name is required.',
    'string.empty': 'Product name cannot be empty.',
    'string.min': 'Product name must be at least 2 characters.',
    'string.max': 'Product name cannot exceed 120 characters.',
  }),
  // Optional: a product can be listed with no description.
  description: Joi.string().trim().max(2000).allow('').optional().default(''),
  price: Joi.number().min(0).required().messages({
    'any.required': 'Price is required.',
    'number.min': 'Price cannot be negative.',
  }),
  stock: Joi.number().integer().min(0).required().messages({
    'any.required': 'Stock quantity is required.',
    'number.min': 'Stock cannot be negative.',
  }),
  category: Joi.string().optional().default('General'),
  tags: Joi.array().items(Joi.string()).optional().default([]),
  // Optional: without a photo the app shows a tile with the name's initials.
  media: Joi.array().items(Joi.string().uri()).optional().default([]),
  size: Joi.string().allow('').optional(),
  whoPays: Joi.string().valid('buyer', 'seller', 'both').default('seller'),
  maxDelivery: Joi.number().integer().min(1).default(3),
  deliveryTimeline: Joi.string().valid('hours', 'days', 'weeks').default('days'),
});

const updateProductBody = createSchema({
  name: Joi.string().trim().min(2).max(120).optional(),
  description: Joi.string().trim().max(2000).allow('').optional(),
  price: Joi.number().min(0).optional(),
  stock: Joi.number().integer().min(0).optional(),
  category: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  media: Joi.array().items(Joi.string().uri()).optional(),
  size: Joi.string().allow('').optional(),
});

export const createProductSchema = { body: createProductBody };
export const updateProductSchema = { body: updateProductBody };
