import { Router } from 'express';
import { requireAuth } from '@/middleware/passport-auth';
import { paylukProxy } from '@/controllers/payluk-proxy.controller';

const router = Router();

// All Payluk calls are forwarded server-side; require a logged-in URA user.
router.use(requireAuth, paylukProxy);

export default router;
