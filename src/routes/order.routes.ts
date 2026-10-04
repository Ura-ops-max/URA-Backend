import express from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import {
  confirmOrderPayment,
  createOrderFromCart,
  getMyOrders,
  getOrderById,
  getReceivedOrders,
  markOrderReady,
} from '@/controllers/order.controller';

const router = express.Router();

router.use(requireAuth);

router.post('/',          createOrderFromCart);   // POST   /orders
router.post('/confirm',   confirmOrderPayment);   // POST   /orders/confirm
router.get('/',           getMyOrders);           // GET    /orders
router.get('/received',   getReceivedOrders);     // GET    /orders/received   (seller)
router.post('/:id/ready', markOrderReady);        // POST   /orders/:id/ready  (seller)
router.get('/:id',        getOrderById);          // GET    /orders/:id

export default router;
