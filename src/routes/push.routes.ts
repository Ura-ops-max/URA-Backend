import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '@/middleware/passport-auth';
import { removeSubscription, saveSubscription, validSubscription } from '@/services/push.service';

// Web push subscriptions for the signed-in user's own browsers.
const router = Router();
router.use(requireAuth);
router.use(rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

const userIdOf = (req: Request) => String((req as any).user?._id ?? '');

export const subscribe = async (req: Request, res: Response) => {
  const sub = validSubscription(req.body);
  if (!sub) return res.status(400).json({ success: false, message: 'Invalid subscription' });
  await saveSubscription(userIdOf(req), sub);
  return res.status(201).json({ success: true });
};

export const unsubscribe = async (req: Request, res: Response) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  if (!endpoint) return res.status(400).json({ success: false, message: 'endpoint is required' });
  const removed = await removeSubscription(userIdOf(req), endpoint);
  return res.status(200).json({ success: true, removed });
};

router.post('/subscriptions', subscribe); // POST   /push/subscriptions
router.delete('/subscriptions', unsubscribe); // DELETE /push/subscriptions

export default router;
