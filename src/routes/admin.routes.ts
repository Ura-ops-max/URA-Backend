import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { User } from '@/models/user-model';
import Order from '@/models/order-model';
import { readinessReport } from '@/seo/report';

/**
 * Admin-only reports. URA has no admin role yet, so admins are the signed-in
 * users whose email is in ADMIN_EMAILS (comma-separated).
 */
const router = Router();

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const admins = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const userId = (req as any).user?._id;
  const u = userId ? await User.findById(userId).select('email').lean() : null;
  if (!u || !admins.includes(String((u as any).email).toLowerCase())) {
    res.status(403).json({ success: false, message: 'Admins only' });
    return;
  }
  next();
}

/**
 * GET /admin/reports/delivery?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Per day (by payment date): delivery fees charged to buyers, delivery fees
 * Payluk has paid into URA's merchant wallet, and Fez costs for booked riders.
 */
router.get('/reports/delivery', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from
    ? new Date(String(req.query.from))
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    res.status(400).json({ success: false, message: 'from/to must be dates (YYYY-MM-DD)' });
    return;
  }
  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);

  const days = await Order.aggregate([
    {
      $match: {
        deliveryMethod: 'delivery',
        paymentStatus: 'paid',
        paidAt: { $gte: from, $lte: end },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: 'Africa/Lagos' } },
        orders: { $sum: 1 },
        deliveryFeesCharged: { $sum: { $ifNull: ['$deliveryFeeCharged', '$deliveryFee'] } },
        deliveryFeesReceived: { $sum: { $ifNull: ['$deliveryFeeReceived', 0] } },
        deliveryFeesPending: {
          $sum: {
            $cond: [
              { $ifNull: ['$deliveryFeeReceivedAt', false] },
              0,
              { $ifNull: ['$deliveryFeeCharged', '$deliveryFee'] },
            ],
          },
        },
        ridersBooked: { $sum: { $cond: [{ $ifNull: ['$riderBookedAt', false] }, 1, 0] } },
        fezCostsPaid: {
          $sum: {
            $cond: [{ $ifNull: ['$riderBookedAt', false] }, { $ifNull: ['$fezCost', 0] }, 0],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const totals = days.reduce(
    (t, d) => {
      for (const k of [
        'orders',
        'deliveryFeesCharged',
        'deliveryFeesReceived',
        'deliveryFeesPending',
        'ridersBooked',
        'fezCostsPaid',
      ])
        t[k] = (t[k] || 0) + (d[k] || 0);
      return t;
    },
    {} as Record<string, number>
  );

  res.json({
    success: true,
    from: from.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    days: days.map(d => ({ date: d._id, ...d, _id: undefined })),
    totals: { ...totals, net: (totals.deliveryFeesReceived || 0) - (totals.fezCostsPaid || 0) },
  });
});

/** GET /admin/reports/seo: shops ready for Google, and top reasons for the rest. Read-only. */
router.get('/reports/seo', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  res.json({ success: true, ...(await readinessReport()) });
});

export default router;
