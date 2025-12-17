import { Router } from 'express';
import { getUnifiedFeed, createPost } from '@/controllers/post.controller';
import { createPostSchema } from '../validators/post.validators';
import { requireAuth } from '@/middleware/passport-auth';
import { validateRequest } from '@/middleware/validation';

// Optional: import { protect } from '@/middleware/auth-middleware';

const router = Router();

// This endpoint fetches the mix of social posts and products
// We keep it public so even non-logged-in users can see the feed
router.get('/feed', getUnifiedFeed);





// Create Post or Product
router.post('/create', requireAuth, validateRequest(createPostSchema), createPost);

export default router;