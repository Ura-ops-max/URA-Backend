import { Router } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import {
  getCurrentUser,
  getUserProfile,
  updateProfile,
  updateBusiness,
  convertToBusiness,
  getBusinessProfile,
  getFollowList,
  getWishlistProducts,
  updateShippingAddress,
} from '@/controllers/user.controller';
import { validateRequest } from '@/middleware/validation';
import { updateProfileSchema, updateBusinessSchema } from '@/validators/user.validators';
import { toggleFollow, toggleBookmark } from '@/controllers/interaction.controller';

const router = Router();

// Current user
router.get('/me',                requireAuth, getCurrentUser);
router.get('/me/wishlist',       requireAuth, getWishlistProducts);
router.patch('/me/profile',      requireAuth, validateRequest(updateProfileSchema), updateProfile);
router.patch('/me/business',     requireAuth, validateRequest(updateBusinessSchema), updateBusiness);
router.patch('/me/shipping',     requireAuth, updateShippingAddress);
router.post('/me/convert-to-business', requireAuth, convertToBusiness);

// Other users
router.get('/:userId',                    requireAuth, getUserProfile);
router.get('/:userId/social',             requireAuth, getFollowList);
router.get('/business/:businessId',       requireAuth, getBusinessProfile);

// Social interactions
router.post('/follow/:targetId',          requireAuth, toggleFollow);
router.post('/bookmarks/:targetId',       requireAuth, toggleBookmark);

export default router;
