import { Router } from 'express';
import { requireAuth, optionalProtect } from '@/middleware/passport-auth';
import { validateRequest } from '@/middleware/validation';
import { createPostSchema } from '../validators/post.validators';
import { getUnifiedFeed, getSocialPosts, createPost, updatePost, deletePost } from '@/controllers/post.controller';
import { toggleCommentLike, toggleLike } from '@/controllers/interaction.controller';
import { createComment, getComments } from '@/controllers/comment.controller';

const router = Router();

// Feeds
router.get('/feed',   optionalProtect, getUnifiedFeed);   // GET  /posts/feed
router.get('/social', optionalProtect, getSocialPosts);   // GET  /posts/social

// Post CRUD
router.post('/',      requireAuth, validateRequest(createPostSchema), createPost); // POST   /posts
router.patch('/:id',  requireAuth, updatePost);                                    // PATCH  /posts/:id
router.delete('/:id', requireAuth, deletePost);                                    // DELETE /posts/:id

// Interactions
router.patch('/likes/:targetType/:targetId', requireAuth, toggleLike);
router.post('/:postId/comments',             requireAuth, createComment);
router.get('/:postId/comments',              requireAuth, getComments);
router.post('/comments/:commentId/like',     requireAuth, toggleCommentLike);

export default router;
