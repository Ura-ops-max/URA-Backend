import { Router } from 'express';
import { getBookmarkList } from '@/controllers/bookmark.controller';
import { requireAuth } from '@/middleware/auth';

const router = Router();

router.use(requireAuth); // All bookmark routes require login

router.get('/list', getBookmarkList);
// router.post('/toggle/:postId', toggleBookmark);

export default router;