import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '@/middleware/passport-auth';
import { getCheckoutAd } from '@/services/ads.service';

const router = Router();

// Modest per-user/IP limit — the ad is cosmetic, so cap how often it's asked for.
const adsLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ad: null },
});

// GET /api/v1/ads/checkout?businessId=<URA business id>
// Always 200. Returns { ad: null } on any problem so checkout never breaks.
router.get('/checkout', requireAuth, adsLimiter, async (req: Request, res: Response) => {
  try {
    const businessId = String(req.query.businessId || '');
    const ad = await getCheckoutAd(businessId);
    res.status(200).json({ ad });
  } catch {
    res.status(200).json({ ad: null });
  }
});

export default router;
