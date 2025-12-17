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
  checkUsernameAvailability
  
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

// Google OAuth
router.get('/google', googleAuth);
router.get('/google/callback', googleCallback);

// TODO: Add Apple, Facebook, etc.

export default router;
