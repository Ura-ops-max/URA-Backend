import express from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import {
  confirmOrderPayment,
  createOrderFromCart,
  getMyOrders,
  getOrderById,
} from '@/controllers/order.controller';

const router = express.Router();

router.use(requireAuth);

router.post('/',          createOrderFromCart);   // POST   /orders
router.post('/confirm',   confirmOrderPayment);   // POST   /orders/confirm
router.get('/',           getMyOrders);           // GET    /orders
router.get('/:id',        getOrderById);          // GET    /orders/:id

export default router;
