import express from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import {
    createOrderFromCart,
    getMyOrders,
    getOrderById
} from '@/controllers/order.controller';

const router = express.Router();

router.use(requireAuth);

router.post('/checkout', createOrderFromCart);
router.get('/my-orders', getMyOrders);     // GET /api/orders/my-orders
router.get('/:id', getOrderById);          // GET /api/orders/:id
export default router;