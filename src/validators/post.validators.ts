import Joi from 'joi';
import { createSchema } from './common.schemas';

export const createPostField = {
  // We keep 'type' to distinguish the intent of the request
  type: Joi.string().valid('POST', 'PRODUCT').required(),
  
  // Requirement: Caption is required for POST, but optional for a pure PRODUCT listing
  caption: Joi.when('type', {
    is: 'POST',
    then: Joi.string().required().messages({ 'any.required': 'Caption is required for posts.' }),
    otherwise: Joi.string().optional().allow('')
  }),

  tags: Joi.array().items(Joi.string()).optional().default([]),

  productId: Joi.string().optional().allow(null),
  media: Joi.when('type', {
    is: 'PRODUCT',
    then: Joi.array().items(Joi.string()).min(1).required().messages({
      'array.min': 'Products must have at least one image or video.',
      'any.required': 'Product media is required.'
    }),
    otherwise: Joi.array().items(Joi.string()).optional()
  }),

  productName: Joi.when('type', { 
    is: 'PRODUCT', 
    then: Joi.string().required() 
  }),
  category: Joi.when('type', { 
    is: 'PRODUCT', 
    then: Joi.string().default('General') 
  }),
  description: Joi.when('type', { 
    is: 'PRODUCT', 
    then: Joi.string().required().messages({ 'any.required': 'Product description is compulsory.' }) 
  }),
  price: Joi.when('type', { 
    is: 'PRODUCT', 
    then: Joi.number().min(0).required() 
  }),
  stock: Joi.when('type', { 
    is: 'PRODUCT', 
    then: Joi.number().integer().min(0).required().messages({ 'any.required': 'Stock quantity is required.' }) 
  }),
  size: Joi.string().allow('').optional(),

  // ── Payluk escrow fields (required when type === PRODUCT) ──────
  // Who bears the Payluk platform fee.
  whoPays: Joi.when('type', {
    is:   'PRODUCT',
    then: Joi.string().valid('buyer', 'seller', 'both').default('seller'),
  }),

  // How long the seller has to deliver after payment.
  maxDelivery: Joi.when('type', {
    is:   'PRODUCT',
    then: Joi.number().integer().min(1).default(3),
  }),

  // Unit for maxDelivery.
  deliveryTimeline: Joi.when('type', {
    is:   'PRODUCT',
    then: Joi.string().valid('hours', 'days', 'minutes').default('days'),
  }),
  // ──────────────────────────────────────────────────────────────

  // Flag to tell the controller: "I created a product, now also create a Post for it"
  publishToFeed: Joi.boolean().default(false)
};

export const createCommentField = {
  content: Joi.string().required().max(500),
  postId: Joi.string().required(),
  parentId: Joi.string().allow(null),
  mentions: Joi.array().items(Joi.object({
    id: Joi.string().required(),
    entityType: Joi.string().valid('User', 'Business'),
    displayName: Joi.string()
  }))
};

export const postSchema = {
  createPost: createSchema(createPostField).min(1),
  createComment: createSchema(createCommentField).min(1)
};

export const createPostSchema = { body: postSchema.createPost };
export const createCommentSchema = { body: postSchema.createComment };