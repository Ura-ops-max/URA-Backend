// backend/validators/post.validator.ts
import Joi from 'joi';
import { createSchema } from './common.schemas';

export const createPostField = {
  type: Joi.string().valid('POST', 'PRODUCT').required(),
  caption: Joi.string().required(),
  
  // 1. Tags: Optional array of strings
  tags: Joi.array().items(Joi.string()).optional().default([]),

  // 2. Media: Required ONLY if type is PRODUCT
  media: Joi.when('type', {
    is: 'PRODUCT',
    then: Joi.array().items(Joi.string()).min(1).required().messages({
      'array.min': 'Products must have at least one image or video.',
      'any.required': 'Product media is required.'
    }),
    otherwise: Joi.array().items(Joi.string()).optional() // Optional for regular POST
  }),
  
  // Conditional fields for PRODUCT
  productName: Joi.when('type', { is: 'PRODUCT', then: Joi.string().required() }),
  category: Joi.when('type', { is: 'PRODUCT', then: Joi.string().required() }),
  description: Joi.when('type', { is: 'PRODUCT', then: Joi.string().required() }),
  price: Joi.when('type', { is: 'PRODUCT', then: Joi.number().min(0).required() }),
  stock: Joi.when('type', { is: 'PRODUCT', then: Joi.number().min(0).required() }),
  size: Joi.when('type', { is: 'PRODUCT', then: Joi.string().allow('').optional() }),
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
  // .min(1) here ensures the body isn't empty
  createPost: createSchema(createPostField).min(1),
  createComment: createSchema(createCommentField).min(1)
};

export const createPostSchema = { body: postSchema.createPost };
export const createCommentSchema = { body: postSchema.createComment };






