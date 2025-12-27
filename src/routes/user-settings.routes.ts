import { Router } from 'express';
import * as settingsController from '@/controllers/user-settings.controller';
import { requireAuth } from '@/middleware/passport-auth'; // Your auth guard

const router = Router();

router.use(requireAuth); // All security routes require login

router.put('/update-password', settingsController.updatePassword);
router.put('/update-email', settingsController.updateEmail);
router.post('/resend-verification', settingsController.resendVerification);

export default router;