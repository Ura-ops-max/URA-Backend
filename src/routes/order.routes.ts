import express from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import multer from 'multer';
import {
  createOrderFromCart,
  getMyOrders,
  getOrderById,
  getReceivedOrders,
  markOrderReady,
} from '@/controllers/order.controller';
import {
  cancelOrder,
  rejectOrder,
  requestRefund,
  claimFunds,
  confirmReceived,
  getDispute,
  openDispute,
  payFromWallet,
  paymentStatus,
  startPayment,
} from '@/controllers/payment.controller';

// Dispute evidence: one image or PDF, kept in memory and passed to Payluk.
const evidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^(image\/|application\/pdf$)/.test(file.mimetype)),
});

const router = express.Router();

router.use(requireAuth);

router.post('/', createOrderFromCart); // POST   /orders
// Payment (both types). See services/payment.service.ts.
router.post('/:id/pay', startPayment); // POST   /orders/:id/pay
router.get('/:id/payment-status', paymentStatus); // GET    /orders/:id/payment-status
router.post('/:id/pay-from-wallet', payFromWallet); // POST   /orders/:id/pay-from-wallet
router.post('/:id/confirm-received', confirmReceived); // POST   /orders/:id/confirm-received (buyer)
router.post('/:id/dispute', evidence.single('file'), openDispute); // POST   /orders/:id/dispute
router.get('/:id/dispute', getDispute); // GET    /orders/:id/dispute
router.post('/:id/claim', claimFunds); // POST   /orders/:id/claim (seller)
router.post('/:id/cancel', cancelOrder); // POST   /orders/:id/cancel (buyer, unpaid)
router.post('/:id/reject', rejectOrder); // POST   /orders/:id/reject (seller, Buyer-Protected)
router.post('/:id/refund', requestRefund); // POST   /orders/:id/refund (buyer, after a rejection)
router.get('/', getMyOrders); // GET    /orders
router.get('/received', getReceivedOrders); // GET    /orders/received   (seller)
router.post('/:id/ready', markOrderReady); // POST   /orders/:id/ready  (seller)
router.get('/:id', getOrderById); // GET    /orders/:id

export default router;
