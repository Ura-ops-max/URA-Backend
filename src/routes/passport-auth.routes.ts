import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '@/config/env.config';
import { validateRequest } from '@/middleware/validation';
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  checkUsernameSchema,
} from '@/validators/auth.validators';
import {
  register,
  login,
  refresh,
  logout,
  verifyEmail,
  resendVerificationPublic,
  forgotPassword,
  resetPassword,
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

// Stricter limit on login: per IP + the account being targeted, to slow down
// password guessing without locking out a whole office behind one IP.
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.loginMax,
  keyGenerator: req => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.',
    error: { code: 'LOGIN_RATE_LIMIT_EXCEEDED' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// General limit for the other sensitive auth routes (per IP).
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
    error: { code: 'AUTH_RATE_LIMIT_EXCEEDED' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Local authentication
router.post('/register', authLimiter, validateRequest(registerSchema), register);
router.post('/login', loginLimiter, validateRequest(loginSchema), login);
router.post('/logout', requireAuth, logout);
router.post('/refresh', validateRequest(refreshTokenSchema), refresh);
router.get('/verify-email', verifyEmail);
router.post('/resend-verification', authLimiter, resendVerificationPublic);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);
router.get('/check-username', validateRequest(checkUsernameSchema), checkUsernameAvailability);

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
