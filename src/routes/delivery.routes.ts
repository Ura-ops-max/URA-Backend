import { Router } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { deliveryCost, deliveryCreate, deliveryTrack } from '@/controllers/delivery.controller';

const router = Router();

router.post('/cost', requireAuth, deliveryCost);          // POST   /delivery/cost
router.post('/create', requireAuth, deliveryCreate);      // POST   /delivery/create
router.get('/track/:orderNumber', deliveryTrack);         // GET    /delivery/track/:orderNumber (public)

export default router;
