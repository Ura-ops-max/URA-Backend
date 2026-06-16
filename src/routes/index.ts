import { Router } from 'express';

import authRoutes from '@/routes/passport-auth.routes';
import chatRoutes from '@/routes/chat.routes';
import userRoutes from '@/routes/user.routes';
import logRoutes from '@/routes/log.routes';
import bookmarkRoutes from '@/routes/bookmark.routes';
import postRouted from '@/routes/post.routes';
import productRoutes from '@/routes/product.routes';
import searchRoutes from '@/routes/search.routes';
import orderRoutes from '@/routes/order.routes';
import cartRoutes from '@/routes/cart.routes';
import settingsRoutes from '@/routes/user-settings.routes';
import reviewsRoutes from '@/routes/reviews.routes';
import uploadRoutes from '@/routes/upload.routes';
import webhookRouter from '@/routes/webhook.route';
import onboardingRoutes from '@/routes/onboarding.routes';
import paylukRoutes from '@/routes/payluk.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/conversations', chatRoutes);
router.use('/users', userRoutes);
router.use('/logs', logRoutes);
router.use('/bookmarks', bookmarkRoutes);
router.use('/posts', postRouted);
router.use('/products', productRoutes);
router.use('/search', searchRoutes);
router.use('/orders', orderRoutes);
router.use('/cart', cartRoutes);
router.use('/settings', settingsRoutes);
router.use('/reviews', reviewsRoutes);
router.use('/upload', uploadRoutes);
router.use('/webhooks', webhookRouter);
router.use('/onboarding', onboardingRoutes);
router.use('/payluk', paylukRoutes);

export default router;
