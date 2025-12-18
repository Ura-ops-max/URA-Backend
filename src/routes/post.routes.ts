import { Router } from 'express';
import { getUnifiedFeed, createPost } from '@/controllers/post.controller';
import { createPostSchema } from '../validators/post.validators';
import { requireAuth, optionalProtect } from '@/middleware/passport-auth';
import { validateRequest } from '@/middleware/validation';
import { toggleCommentLike, toggleLike } from '@/controllers/interaction.controller';
import { createComment, getComments } from '@/controllers/comment.controller';

// Optional: import { protect } from '@/middleware/auth-middleware';

const router = Router();

// This endpoint fetches the mix of social posts and products
// We keep it public so even non-logged-in users can see the feed
router.get('/feed', optionalProtect, getUnifiedFeed)
// Create Post or Product
router.post('/create', requireAuth, validateRequest(createPostSchema), createPost);

router.post('/comment/:commentId/like', requireAuth, toggleCommentLike);
router.post('/:postId/like', requireAuth, toggleLike);
router.get('/:postId/comments', requireAuth, getComments);

router.post('/comment', requireAuth, createComment);

export default router;