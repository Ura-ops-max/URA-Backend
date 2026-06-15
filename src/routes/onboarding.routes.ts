import express from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { setupPaylukCustomer } from '@/controllers/order.controller';

const router = express.Router();

router.use(requireAuth);

router.post('/setup-payment-profile', setupPaylukCustomer);

export default router;
