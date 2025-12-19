import { Router } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { getCurrentUser, getUserProfile, updateProfile, updateBusiness, convertToBusiness } from '@/controllers/user.controller';
import { validateRequest } from '@/middleware/validation';
import { updateProfileSchema } from '@/validators/user.validators';
import { updateBusinessSchema } from '@/validators/user.validators';
import { toggleFollow, toggleBookmark } from '@/controllers/interaction.controller';

const router = Router();

router.get('/current', requireAuth, getCurrentUser);
router.get('/profile/:userId', requireAuth, getUserProfile);
router.post('/convert-to-business', requireAuth, convertToBusiness);
router.patch('/profile/update', requireAuth, validateRequest(updateProfileSchema), updateProfile);

// src/routes/user.routes.ts

// Simple JSON route - no multer needed!
router.patch('/business/update', requireAuth, validateRequest(updateBusinessSchema), updateBusiness);
router.post("/follow/:targetId", requireAuth, toggleFollow);

/**
 * @route   POST /api/users/bookmarks/toggle
 * @desc    Toggle bookmark for Business, Post, or Event
 * @access  Private
 */

router.post("/bookmarks/toggle/:targetId", requireAuth, toggleBookmark);
export default router;
