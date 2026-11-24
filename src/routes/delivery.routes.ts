import { Router } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { deliveryCost, deliveryTrack } from '@/controllers/delivery.controller';

const router = Router();

router.post('/cost', requireAuth, deliveryCost); // POST   /delivery/cost
// /delivery/create removed: it let any signed-in user book Fez trips on URA's
// account. Riders are now booked by the seller from the order (POST /orders/:id/ready).
// Only the order's buyer, its seller or an admin (checked in the controller).
router.get('/track/:trackingNumber', requireAuth, deliveryTrack); // GET    /delivery/track/:trackingNumber

export default router;
