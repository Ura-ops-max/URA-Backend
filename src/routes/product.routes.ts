import { Router } from 'express';
import {
  updateItem,
  deleteItem,
  getMyProducts,
  getProductCategories,
  getProductDetails
} from '@/controllers/post.controller';
import { requireAuth, optionalProtect } from '@/middleware/passport-auth';
import { toggleLike, toggleWishlist } from '@/controllers/interaction.controller';


const router = Router();


router.get('/product-categories', getProductCategories);

router.get('/:id', optionalProtect, getProductDetails);

router.patch('/:id', requireAuth, updateItem);
router.delete('/:id', requireAuth, deleteItem);

// --- PRODUCT INVENTORY ---
// New: Helps the business owner see their own products to link them to posts
router.get('/my-products', requireAuth, getMyProducts);

router.patch("/product/toggle/:targetId", requireAuth, toggleWishlist);
router.post('/likes/targetType/:targetId', requireAuth, toggleLike);



export default router;