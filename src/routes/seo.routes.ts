import { Router, Request, Response } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { Business } from '@/models/business-model';
import { siteUrl } from '@/seo/config';
import { shopsWithReadiness } from '@/seo/shop-data';

// Google visibility. Public page, sitemap and robots routes are added below.
const router = Router();

/** GET /seo/readiness/mine: the signed-in owner's shops and their next steps. */
router.get('/readiness/mine', requireAuth, async (req: Request, res: Response) => {
  const userId = String((req as any).user?._id ?? '');
  const ids = (await Business.find({ owner: userId }).select('_id').lean()).map(b => b._id);
  const rows = ids.length ? await shopsWithReadiness({ _id: { $in: ids } }) : [];
  res.json({
    success: true,
    shops: rows.map(r => ({
      businessId: String(r.shop._id),
      slug: r.shop.slug ?? null,
      url: r.shop.slug ? `${siteUrl()}/${r.shop.slug}` : null,
      ready: r.ready,
      reasons: r.reasons,
      nextSteps: r.nextSteps,
    })),
  });
});

export default router;
