import { Router } from 'express';
import { getMyBookmarks } from '@/controllers/bookmark.controller';
import { requireAuth } from '@/middleware/auth';
import { toggleBookmark } from '@/controllers/interaction.controller';

const router = Router();

router.use(requireAuth); // All bookmark routes require login

// router.get('/list', getBookmarkList);
router.get('/load', getMyBookmarks);

router.post('/toggle/:targetId', toggleBookmark);

export default router;