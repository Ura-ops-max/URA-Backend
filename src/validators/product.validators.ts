import Joi from 'joi';
import { createSchema } from './common.schemas';

const createProductBody = createSchema({
  name: Joi.string().trim().min(2).max(120).required().messages({
    'any.required': 'Product name is required.',
    'string.empty': 'Product name cannot be empty.',
    'string.min': 'Product name must be at least 2 characters.',
    'string.max': 'Product name cannot exceed 120 characters.',
  }),
  description: Joi.string().trim().min(10).required().messages({
    'any.required': 'Product description is required.',
    'string.min': 'Description must be at least 10 characters.',
  }),
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
  media: Joi.array().items(Joi.string().uri()).min(1).required().messages({
    'any.required': 'At least one product image is required.',
    'array.min': 'At least one product image is required.',
  }),
  size: Joi.string().allow('').optional(),
  whoPays: Joi.string().valid('buyer', 'seller', 'both').default('seller'),
  maxDelivery: Joi.number().integer().min(1).default(3),
  deliveryTimeline: Joi.string().valid('hours', 'days', 'weeks').default('days'),
});

const updateProductBody = createSchema({
  name: Joi.string().trim().min(2).max(120).optional(),
  description: Joi.string().trim().min(10).optional(),
  price: Joi.number().min(0).optional(),
  stock: Joi.number().integer().min(0).optional(),
  category: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  media: Joi.array().items(Joi.string().uri()).optional(),
  size: Joi.string().allow('').optional(),
});

export const createProductSchema = { body: createProductBody };
export const updateProductSchema = { body: updateProductBody };
