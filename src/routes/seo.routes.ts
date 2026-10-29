import { Router, Request, Response } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { Business } from '@/models/business-model';
import { siteUrl } from '@/seo/config';
import { shopsWithReadiness } from '@/seo/shop-data';
import { buildPage } from '@/seo/pages';

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

/**
 * GET /seo/page?path=/<slug> or /<slug>/p/<id>-<name>
 * The built page (real HTML for Google and people alike). The host sends shop
 * and product paths here (docs/google-routing.md).
 */
router.get('/page', async (req: Request, res: Response) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '/';
  const page = await buildPage(path);
  const cache = `public, max-age=300, s-maxage=${page.cacheSeconds}`;
  if (page.location) {
    res.set('Cache-Control', cache).redirect(301, page.location);
    return;
  }
  if (page.status >= 400) res.set('X-Robots-Tag', 'noindex');
  res.status(page.status).set('Cache-Control', cache).type('html').send(page.html);
});

export default router;
