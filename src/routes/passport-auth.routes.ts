import { Router } from 'express';
import { validateRequest } from '@/middleware/validation';
import { loginSchema, registerSchema, refreshTokenSchema, checkUsernameSchema } from '@/validators/auth.validators';
import {
  register,
  login,
  refresh,
  logout,
  verifyEmail,
  googleAuth,
  googleCallback,
  microsoftAuth,
  microsoftCallback,
  checkUsernameAvailability,
  enable2FA,
  disable2FA,
} from '@/controllers/passport-auth.controller';
import { requireAuth } from '@/middleware/passport-auth';

const router = Router();

// Local authentication
router.post('/register', validateRequest(registerSchema), register);
router.post('/login', validateRequest(loginSchema), login);
router.post('/logout', requireAuth, logout);
router.post('/refresh', validateRequest(refreshTokenSchema), refresh);
router.get('/verify-email', verifyEmail);
router.get('/check-username',  validateRequest(checkUsernameSchema), checkUsernameAvailability);

// 2FA
router.post('/2fa/enable', requireAuth, enable2FA);
router.post('/2fa/disable', requireAuth, disable2FA);

// Google OAuth
router.get('/google', googleAuth);
router.get('/google/callback', googleCallback);

// Microsoft OAuth
router.get('/microsoft', microsoftAuth);
router.get('/microsoft/callback', microsoftCallback);

export default router;
