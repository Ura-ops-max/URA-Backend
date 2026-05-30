import { Router } from 'express';
import { requireAuth } from '@/middleware/auth';
import { getPresignedUploadUrl } from '@/controllers/upload.controller';

const router = Router();

router.use(requireAuth); // Only authenticated users can request upload URLs

// POST /api/upload/presign
router.post('/presign', getPresignedUploadUrl);

export default router;
