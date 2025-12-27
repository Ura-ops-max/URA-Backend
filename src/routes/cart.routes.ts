import express from 'express';
import { requireAuth } from '@/middleware/auth';
import { 
    addToCart, 
    updateCartQuantity, 
    removeFromCart,
    getCart
} from '@/controllers/cart.controller';

const router = express.Router();

router.use(requireAuth); // All cart actions require login

router.get('/', getCart); // GET /api/cart
router.post('/add', addToCart);
router.put('/update', updateCartQuantity);
router.delete('/remove/:productId', removeFromCart);

export default router;