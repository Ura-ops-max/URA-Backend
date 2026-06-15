import express from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { addToCart, updateCartQuantity, removeFromCart, getCart } from '@/controllers/cart.controller';

const router = express.Router();

router.use(requireAuth);

router.get('/',                     getCart);            // GET    /cart
router.post('/items',               addToCart);          // POST   /cart/items
router.patch('/items',              updateCartQuantity); // PATCH  /cart/items
router.delete('/items/:productId',  removeFromCart);     // DELETE /cart/items/:productId

export default router;
