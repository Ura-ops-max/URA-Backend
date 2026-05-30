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
import webhookRouter from "@/routes/webhook.route"

const router = Router();

router.use('/auth', authRoutes);
router.use('/chat', chatRoutes);
router.use('/user', userRoutes);
router.use('/log', logRoutes);
router.use('/bookmark', bookmarkRoutes);
router.use('/post', postRouted);
router.use('/product', productRoutes);
router.use('/search', searchRoutes);
router.use('/order', orderRoutes);
router.use('/cart', cartRoutes);
router.use('/settings', settingsRoutes);
router.use('/reviews', reviewsRoutes);
router.use('/upload', uploadRoutes);
router.use('/webhooks', webhookRouter);

export default router;
