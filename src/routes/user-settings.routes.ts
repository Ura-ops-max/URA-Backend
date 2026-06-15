import { Router } from 'express';
import * as settingsController from '@/controllers/user-settings.controller';
import { requireAuth } from '@/middleware/passport-auth';

const router = Router();

router.use(requireAuth);

router.put('/password', settingsController.updatePassword);             
router.put('/email',    settingsController.updateEmail);              
router.post('/resend-verification', settingsController.resendVerification);

export default router;
