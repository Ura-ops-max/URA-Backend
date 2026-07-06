import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '@/config/env.config';

export const generateAccessToken = (payload: object): string => {
  return jwt.sign({ ...payload, type: 'access' }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
};

export const generateRefreshToken = (payload: object): string => {
  return jwt.sign({ ...payload, type: 'refresh' }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  });
};

export const verifyToken = (token: string, refresh = false): Record<string, unknown> => {
  const decoded = jwt.verify(token, refresh ? config.jwt.refreshSecret : config.jwt.secret);
  if (typeof decoded === 'string') {
    throw new Error('Invalid token format: Expected object payload.');
  }
  return decoded as Record<string, unknown>;
};

export const generateEmailToken = (): { token: string; hash: string; expires: Date } => {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return { token, hash, expires };
};

/**
 * Short, human-friendly 6-digit verification code (e.g. "418302").
 * The plain code is emailed to the user; only its hash is stored.
 * Verified via the same token flow (the endpoint hashes the submitted code).
 */
export const generateVerificationCode = (): { code: string; hash: string; expires: Date } => {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  return { code, hash, expires };
};
