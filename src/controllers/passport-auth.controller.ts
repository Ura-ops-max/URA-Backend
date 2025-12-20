import { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import bcrypt from 'bcryptjs';
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
import { eventEmitter } from '@/services/event-emitter.services';
import { Types } from 'mongoose';

/**
 * Register new user (Local)
 */
export const register = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { firstName, lastName, email, password, username } = req.body;

  const exists = await User.findOne({ email });
  if (exists) {
    const errorDetails: ErrorDetail[] = [
      {
        field: 'email',
        message: 'An account with this email already exists. Please sign in.',
        location: 'body',
      },
    ];
    throw new ValidationError('Validation failed', errorDetails);
  }

  const hashedPassword = password ? await bcrypt.hash(password, 12) : undefined;
  const { token, hash, expires } = generateEmailToken();

  const user = await User.create({
    firstName,
    lastName,
    username,
    email,
    password: hashedPassword,
    emailVerificationToken: hash,
    emailVerificationExpires: expires,
  });

  // 🚨 EVENT LOG: User Registered
  eventEmitter.emit('activityLogged', {
    actorId: (user._id as Types.ObjectId).toString(),
    actionType: 'signup',
    targetModel: 'User',
    targetId: (user._id as Types.ObjectId).toString(),
    targetOwnerId: (user._id as Types.ObjectId).toString(),
  });

  // backend/controllers/auth.controller.ts

  // ... user creation code ...

  try {
    await sendVerificationEmail(email, token);
  } catch (emailError) {
    // We log the error so you know it failed, but we DON'T stop the response
    console.error("Verification email failed to send:", emailError);
  }

  // Always return success if the user was created
  res.status(HTTP_STATUS.CREATED).json({
    success: true,
    message: 'Registration successful. Please check your email to verify your account.',
  });
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
      // if (!user) throw new AuthenticationError(info?.message || 'Invalid credentials');

      user.lastLoginAt = new Date();
      await user.save();

      // 🚨 EVENT LOG: User Logged In
      eventEmitter.emit('activityLogged', {
        actorId: user.id.toString(),
        actionType: 'signup', // You can map 'signup' to general 'access' or add 'login' to your schema
        targetModel: 'User',
        targetId: user.id.toString(),
        targetOwnerId: user.id.toString(),
      });

      const accessToken = generateAccessToken({ userId: user.id, email: user.email });
      const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: { accessToken, refreshToken, user }
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

      // 🚨 EVENT LOG: OAuth Login
      eventEmitter.emit('activityLogged', {
        actorId: user.id.toString(),
        actionType: 'signup',
        targetModel: 'User',
        targetId: user.id.toString(),
        targetOwnerId: user.id.toString(),
      });

      const accessToken = generateAccessToken({ userId: user.id, email: user.email });
      const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

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

  // 🚨 EVENT LOG: Email Verified
  eventEmitter.emit('activityLogged', {
    actorId: (user._id as Types.ObjectId).toString(),
    actionType: 'signup',
    targetModel: 'User',
    targetId: (user._id as Types.ObjectId).toString(),
    targetOwnerId: (user._id as Types.ObjectId).toString(),
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