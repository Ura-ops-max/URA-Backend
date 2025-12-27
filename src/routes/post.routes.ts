import { Router } from 'express';
import { 
  getUnifiedFeed, 
  createPost, 
  updateItem, // Added
  deleteItem, // Added
  getMyProducts, // Recommended: To populate the 'Tag Product' dropdown
  getSocialPosts,
  getProductCatalog
} from '@/controllers/post.controller';
import { createPostSchema } from '../validators/post.validators';
import { requireAuth, optionalProtect } from '@/middleware/passport-auth';
import { validateRequest } from '@/middleware/validation';
import { toggleCommentLike, toggleLike } from '@/controllers/interaction.controller';
import { createComment, getComments } from '@/controllers/comment.controller';

const router = Router();

// --- FEED & DISCOVERY ---
router.get('/feed', optionalProtect, getUnifiedFeed);

// --- CREATION ---
router.post('/create', requireAuth, validateRequest(createPostSchema), createPost);

// --- EDIT & DELETE ---
// Logic: Expects /:id?type=post or /:id?type=product
router.patch('/:id', requireAuth, updateItem); 
router.delete('/:id', requireAuth, deleteItem);

// --- PRODUCT INVENTORY ---
// New: Helps the business owner see their own products to link them to posts
router.get('/my-products', requireAuth, getMyProducts);
router.get('/social', optionalProtect, getSocialPosts);
router.get('/product', requireAuth, getProductCatalog);

// --- INTERACTIONS ---
router.post('/comment/:commentId/like', requireAuth, toggleCommentLike);
router.patch('/likes/:targetType/:targetId', requireAuth, toggleLike);
router.get('/:postId/comments', requireAuth, getComments);
router.post('/comment', requireAuth, createComment);

export default router;