import { Router } from 'express';
import { requireAuth, optionalProtect } from '@/middleware/passport-auth';
import { validateRequest } from '@/middleware/validation';
import { createProductSchema, updateProductSchema } from '@/validators/product.validators';
import { toggleLike, toggleWishlist } from '@/controllers/interaction.controller';
import {
  createProduct,
  updateProduct,
  deleteProduct,
  getMyProducts,
  getProductCatalog,
  getProductCategories,
  getProductDetails,
  imageSearchProducts,
} from '@/controllers/product.controller';
import {
  getInventory,
  previewBulk,
  commitBulk,
  updateStock,
} from '@/controllers/inventory.controller';

const router = Router();

// Discovery
router.get('/categories', getProductCategories); // GET  /products/categories
router.post('/image-search', optionalProtect, imageSearchProducts); // POST /products/image-search
router.get('/', optionalProtect, getProductCatalog); // GET  /products
router.get('/mine', requireAuth, getMyProducts); // GET  /products/mine

// Inventory (shop owner only). Registered before '/:id' so the words aren't read as ids.
router.get('/inventory', requireAuth, getInventory); // GET   /products/inventory
router.post('/bulk/preview', requireAuth, previewBulk); // POST  /products/bulk/preview
router.post('/bulk/commit', requireAuth, commitBulk); // POST  /products/bulk/commit
router.patch('/stock', requireAuth, updateStock); // PATCH /products/stock

// Product CRUD
router.post('/', requireAuth, validateRequest(createProductSchema), createProduct); // POST   /products
router.get('/:id', optionalProtect, getProductDetails); // GET    /products/:id
router.patch('/:id', requireAuth, validateRequest(updateProductSchema), updateProduct); // PATCH  /products/:id
router.delete('/:id', requireAuth, deleteProduct); // DELETE /products/:id

// Interactions
router.patch('/wishlist/:targetId', requireAuth, toggleWishlist);
router.patch('/likes/:targetType/:targetId', requireAuth, toggleLike);

export default router;
