import { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import mongoose, { Types } from 'mongoose';
import { User } from '@/models/user-model';
import { AuthenticationError, ValidationError, ErrorDetail } from '@/utils/errors';
import {
  generateAccessToken,
  generateRefreshToken,
  generateEmailToken,
  verifyToken,
} from '@/services/token.service';
import { sendVerificationEmail } from '@/services/email.service';
import { asyncHandler } from '@/middleware/errorHandler';
import { blacklistToken } from '@/services/token-blacklist.service';
import { config } from '@/config/env.config';
import { HTTP_STATUS } from '@/constants';
import { trackEvent } from '@/services/track-event.service';
import { createPaylukCustomer } from '@/services/payluk.service';

/**
 * Register new user (Local)
 */
export const register = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { firstName, lastName, email, password, username, phone } = req.body;

  const exists = await User.findOne({ email });
  if (exists) {
    throw new ValidationError('Validation failed', [
      { field: 'email', message: 'An account with this email already exists. Please sign in.', location: 'body' },
    ] as ErrorDetail[]);
  }

  const hashedPassword = password ? await bcrypt.hash(password, 12) : undefined;
  const { token, hash, expires } = generateEmailToken();

  // Use a MongoDB session so that if the DB write fails after Payluk succeeds
  // the user record is never persisted (prevents half-saved state).
  // Conversely, if Payluk throws, the transaction aborts before any DB write.
  const session = await mongoose.startSession();
  let user: InstanceType<typeof User>;

  try {
    await session.withTransaction(async () => {
      // Create user document inside the transaction
      const [created] = await User.create(
        [{ firstName, lastName, username, email, phone, password: hashedPassword,
           emailVerificationToken: hash, emailVerificationExpires: expires }],
        { session }
      );
      user = created;

      // Create Payluk customer inside the same logical unit.
      // If this throws the transaction aborts and the user is never saved.
      if (phone) {
        const paylukResult = await createPaylukCustomer({ firstName, lastName, email, phone });
        await User.updateOne(
          { _id: user._id },
          { paylukCustomerId: paylukResult.customerId },
          { session }
        );
        user.paylukCustomerId = paylukResult.customerId;
      }
    });
  } finally {
    await session.endSession();
  }

  res.status(HTTP_STATUS.CREATED).json({
    success: true,
    message: 'Registration successful. Please check your email to verify your account.',
  });

  // Fire-and-forget after response is sent
  Promise.all([
    sendVerificationEmail(email, token).catch(e => console.error('Verification email failed:', e)),
    trackEvent({
      targetId: (user!._id as Types.ObjectId).toString(),
      targetModel: 'User',
      type: 'ACTIVITY',
      activityData: {
        action: 'SIGNUP',
        description: 'Account created successfully',
        metadata: { ip: req.ip, userAgent: req.headers['user-agent'] },
      },
    }).catch(e => console.error('trackEvent failed:', e)),
  ]);
});

/**
 * Login with email/password
 */
export const login = asyncHandler(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    passport.authenticate('local', { session: false }, async (err: Error, user: any, info: any) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: info?.message || 'Invalid credentials',
          code: 'AUTHENTICATION_ERROR'
        });
      }

      user.lastLoginAt = new Date();
      await user.save();

      // 🚨 TRACK EVENT: Successful Login
      await trackEvent({
          targetId: user.id.toString(),
          targetModel: 'User',
          type: 'ACTIVITY',
          activityData: {
              action: 'LOGIN',
              description: 'User logged in via Email/Password',
              metadata: {ip: req.ip, userAgent: req.headers['user-agent']}
          }
      });

      const accessToken = generateAccessToken({ userId: user.id, email: user.email });
      const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

      const userObj = user.toObject ? user.toObject() : { ...user };
      delete userObj.password;
      delete userObj.twoFactorSecret;
      delete userObj.mfaRecoveryCodes;
      delete userObj.emailVerificationToken;
      delete userObj.emailVerificationExpires;

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: { accessToken, refreshToken, user: userObj }
      });
    })(req, res, next);
  }
);

/**
 * Google OAuth - Callback
 */
export const googleCallback = asyncHandler(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    passport.authenticate('google', { session: false }, async (err: Error, user: any) => {
      if (err || !user) {
        return res.redirect(`${config.frontend.url}/auth/login?error=oauth_failed`);
      }

      user.lastLoginAt = new Date();
      await user.save();

      const accessToken = generateAccessToken({ userId: user.id, email: user.email });
      const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

      // Fire-and-forget — must not block or crash the redirect
      trackEvent({
        targetId: user.id.toString(),
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
          action: 'LOGIN_OAUTH',
          description: 'User logged in via Google',
          metadata: { ip: req.ip, userAgent: req.headers['user-agent'] },
        },
      }).catch(e => console.error('[googleCallback] trackEvent failed:', e));

      res.redirect(
        `${config.frontend.url}/auth/oauth/success?accessToken=${accessToken}&refreshToken=${refreshToken}`
      );
    })(req, res, next);
  }
);

/**
 * Verify email
 */
export const verifyEmail = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const token = String(req.query.token || '');
  if (!token) throw new ValidationError('Verification token is required');

  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    emailVerificationToken: hash,
    emailVerificationExpires: { $gt: new Date() },
  });

  if (!user) throw new ValidationError('Invalid or expired verification token');

  user.emailVerified = true;
  user.emailVerificationToken = undefined as unknown as string;
  user.emailVerificationExpires = undefined as unknown as Date;
  await user.save();

  // 🚨 TRACK EVENT: Identity Verification
  await trackEvent({
      targetId: (user._id as Types.ObjectId).toString(),
      targetModel: 'User',
      type: 'ACTIVITY',
      activityData: {
          action: 'EMAIL_VERIFIED',
          description: 'User successfully verified their email address',
      }
  });

  res.status(HTTP_STATUS.OK).json({
    success: true,
    message: 'Email verified successfully. You can now log in.',
  });
});

/**
 * Logout
 */
export const logout = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;
  const user = (req as any).user;
  const accessToken = user?.token;

  if (!user) throw new AuthenticationError('User not authenticated');

  // 🚨 TRACK EVENT: Logout Audit
  await trackEvent({
      targetId: user.id.toString(),
      targetModel: 'User',
      type: 'ACTIVITY',
      activityData: {
          action: 'LOGOUT',
          description: 'User logged out and invalidated session',
      }
  });

  if (accessToken) {
    try {
      const decoded = verifyToken(accessToken) as any;
      const expiresAt = new Date(decoded.exp * 1000);
      await blacklistToken(accessToken, 'access', user.id, expiresAt);
    } catch (e) { }
  }

  if (refreshToken) {
    try {
      const decoded = verifyToken(refreshToken, true) as any;
      const expiresAt = new Date(decoded.exp * 1000);
      await blacklistToken(refreshToken, 'refresh', user.id, expiresAt);
    } catch (e) { }
  }

  res.status(HTTP_STATUS.OK).json({ success: true, message: 'Logged out successfully' });
});

export const checkUsernameAvailability = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const username = req.query.username as string;
  if (!username?.trim()) {
    res.status(HTTP_STATUS.OK).json({ available: true, message: 'Username is required.' });
    return;
  }

  const normalizedUsername = username.trim().toLowerCase();
  const exists = await User.findOne({ username: normalizedUsername });

  res.status(HTTP_STATUS.OK).json({
    available: !exists,
    message: exists ? 'This username is already taken.' : 'Username is available.',
  });
});

export const refresh = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new ValidationError('Refresh token is required');

  try {
    const decoded = verifyToken(refreshToken, true) as { userId: string; email: string };
    const accessToken = generateAccessToken({ userId: decoded.userId, email: decoded.email });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Token refreshed successfully',
      data: { accessToken },
    });
  } catch {
    throw new AuthenticationError('Invalid or expired refresh token');
  }
});

export const googleAuth = passport.authenticate('google', {
  scope: ['profile', 'email'],
  session: false,
});

export const enable2FA = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  if (!user) throw new AuthenticationError('User not authenticated');

  const secret = speakeasy.generateSecret({ name: `URA (${user.email})` });
  const qrDataURL = await QRCode.toDataURL(secret.otpauth_url as string);

  user.twoFactorSecret = secret.base32;
  user.twoFactorEnabled = true;
  await user.save();

  res.status(HTTP_STATUS.OK).json({
    success: true,
    message: '2FA enabled successfully',
    data: { qrDataURL, secret: secret.base32 },
  });
});

export const disable2FA = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  if (!user) throw new AuthenticationError('User not authenticated');

  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined as unknown as string;
  await user.save();

  res.status(HTTP_STATUS.OK).json({ success: true, message: '2FA disabled successfully' });
});