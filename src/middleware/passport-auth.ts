import { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { AuthenticationError } from '@/utils/errors';
import { User } from '@/models/user-model';
import { asyncHandler } from './errorHandler';

/**
 * Passport JWT authentication middleware
 * Replaces the custom requireAuth middleware
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  passport.authenticate('jwt', { session: false }, (err: Error, user: any, info: any) => {
    if (err) {
      return next(err);
    }

    if (!user) {
      return next(new AuthenticationError(info?.message || 'Unauthorized'));
    }

    // Attach user to request
    (req as any).user = user;
    next();
  })(req, res, next);
};




export const optionalProtect = (req: Request, res: Response, next: NextFunction) => {
  passport.authenticate('jwt', { session: false }, (err: Error, user: any) => {
    if (err) {
      return next(err);
    }
    
    if (user) {
      (req as any).user = user;
    }

    // ALWAYS call next() inside here to ensure the 
    // cycle continues ONLY after Passport is done.
    next();
  })(req, res, next);
};