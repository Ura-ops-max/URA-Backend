import { Router } from 'express';

import authRoutes from '@/routes/passport-auth.routes';
import chatRoutes from '@/routes/chat.routes';
import userRoutes from '@/routes/user.routes';
import activityRoutes from '@/routes/activity.routes';
import bookmarkRoutes from '@/routes/bookmark.routes';
import postRouted from '@/routes/post.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/chat', chatRoutes);
router.use('/user', userRoutes);
router.use('/activity', activityRoutes);
router.use('/bookmark', bookmarkRoutes);
router.use('/post', postRouted);

export default router;
