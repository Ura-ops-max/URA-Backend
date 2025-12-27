import { Router } from 'express';
import {
  getUnifiedFeed,
  createPost,
  updateItem, // Added
  deleteItem, // Added
  getMyProducts, // Recommended: To populate the 'Tag Product' dropdown
  getProductCategories,
  getProductDetails
} from '@/controllers/post.controller';
import { createPostSchema } from '../validators/post.validators';
import { requireAuth, optionalProtect } from '@/middleware/passport-auth';
import { validateRequest } from '@/middleware/validation';
import { toggleLike, toggleWishlist } from '@/controllers/interaction.controller';
import { createComment, getComments } from '@/controllers/comment.controller';


const router = Router();


router.get('/product-categories', getProductCategories);

router.get('/:id', optionalProtect, getProductDetails);
// Logic: Expects /:id?type=post or /:id?type=product

router.patch('/:id', requireAuth, updateItem);
router.delete('/:id', requireAuth, deleteItem);

// --- PRODUCT INVENTORY ---
// New: Helps the business owner see their own products to link them to posts
router.get('/my-products', requireAuth, getMyProducts);

router.patch("/product/toggle/:targetId", requireAuth, toggleWishlist);
router.post('/likes/targetType/:targetId', requireAuth, toggleLike);



export default router;