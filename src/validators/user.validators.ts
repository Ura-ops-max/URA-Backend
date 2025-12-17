import Joi from 'joi';
import {
  createSchema,
  optionalNameSchema,
  usernameSchema,
  bioSchema,
  uriSchema,
} from './common.schemas';
import { updateBusiness } from '@/controllers/user.controller';

const userProfileFields = {
  firstName: optionalNameSchema.label('First name').messages({
    'string.min': 'First name must be at least 2 characters long',
    'string.max': 'First name cannot exceed 50 characters',
  }),

  lastName: optionalNameSchema.label('Last name').messages({
    'string.min': 'Last name must be at least 2 characters long',
    'string.max': 'Last name cannot exceed 50 characters',
  }),

  // username: usernameSchema,
  username : usernameSchema.optional().messages({
    'string.min': 'Username must be at least 3 characters long',
    'string.max': 'Username cannot exceed 30 characters',
  }),
  
  bio: bioSchema,

  businessName: Joi.string().min(2).max(100).trim().allow('', null).optional().messages({
    'string.min': 'Business name must be at least 2 characters long',
    'string.max': 'Business name cannot exceed 100 characters',
  }),

  profilePicture: uriSchema.label('Profile picture'),

  coverPicture: uriSchema.label('Cover picture'),
};

export const userBusinessFields = {
  businessName: Joi.string().min(2).max(100).trim().allow('', null).optional().messages({
    'string.min': 'Business name must be at least 2 characters long',
    'string.max': 'Business name cannot exceed 100 characters',
  }),
  category: Joi.string().optional(),
  about: bioSchema,
  phone: Joi.string().allow('', null).optional(),
  website: Joi.string().uri().allow('', null).optional(),
  fullAddress: Joi.string().allow('', null).optional(),
  businessLogo: uriSchema.label('Business Logo'),
  businessCover: uriSchema.label('Business Cover'),
  operatingHours: Joi.array().items(
    Joi.object({
      day: Joi.string().required(),
      open: Joi.string().required(),
      close: Joi.string().required(),
    })
  ).optional(),
};


export const userSchemas = {
  updateProfile: createSchema(userProfileFields).min(1).messages({
    'object.min': 'At least one field is required for update',
  }),
  updateBusiness: createSchema(userBusinessFields).min(1).messages({
    'object.min': 'At least one field is required for update',
  }),
};

export const updateProfileSchema = { body: userSchemas.updateProfile };
export const updateBusinessSchema = { body: userSchemas.updateBusiness };

