import { Router } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { getCurrentUser, getUserProfile, updateProfile, updateBusiness, convertToBusiness, getBusinessProfile, getFollowList, getWishlistProducts } from '@/controllers/user.controller';
import { validateRequest } from '@/middleware/validation';
import { updateProfileSchema } from '@/validators/user.validators';
import { updateBusinessSchema } from '@/validators/user.validators';
import { toggleFollow, toggleBookmark } from '@/controllers/interaction.controller';

const router = Router();

router.get('/current', requireAuth, getCurrentUser);
router.get("/wishlist", requireAuth, getWishlistProducts);
router.get('/profile/:userId', requireAuth, getUserProfile);
router.get('/business/profile/:businessId', requireAuth, getBusinessProfile);
router.post('/convert-to-business', requireAuth, convertToBusiness);
router.patch('/profile/update', requireAuth, validateRequest(updateProfileSchema), updateProfile);
router.patch('/business/update', requireAuth, validateRequest(updateBusinessSchema), updateBusiness);
router.post("/follow/:targetId", requireAuth, toggleFollow);
router.post("/bookmarks/toggle/:targetId", requireAuth, toggleBookmark);
router.get("/:targetId/social", requireAuth, getFollowList);



export default router;
