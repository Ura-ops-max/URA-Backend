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
  setupProductEscrow,
  imageSearchProducts,
} from '@/controllers/product.controller';

const router = Router();

// Discovery
router.get('/categories',  getProductCategories);                  // GET  /products/categories
router.post('/image-search', optionalProtect, imageSearchProducts); // POST /products/image-search
router.get('/',            optionalProtect, getProductCatalog);    // GET  /products
router.get('/mine',        requireAuth,     getMyProducts);        // GET  /products/mine

// Product CRUD
router.post('/',      requireAuth,     validateRequest(createProductSchema), createProduct);  // POST   /products
router.get('/:id',    optionalProtect, getProductDetails);                                     // GET    /products/:id
router.patch('/:id',  requireAuth,     validateRequest(updateProductSchema), updateProduct);   // PATCH  /products/:id
router.delete('/:id', requireAuth,     deleteProduct);             // DELETE /products/:id

// Escrow setup (retroactive for products created before Payluk was live)
router.post('/:id/escrow', requireAuth, setupProductEscrow);       // POST /products/:id/escrow

// Interactions
router.patch('/wishlist/:targetId',              requireAuth, toggleWishlist);
router.patch('/likes/:targetType/:targetId',     requireAuth, toggleLike);

export default router;
