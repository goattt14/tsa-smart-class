import type { CookieOptions, Response } from 'express';
import { env, isProduction } from '../config/env';
import { parseDuration } from './tokens';

export const REFRESH_COOKIE = 'tsa_rt';

/**
 * In production the SPA (vercel.app) and this API (onrender.com) are different
 * registrable domains, so the refresh cookie is cross-site and MUST be
 * SameSite=None; Secure or the browser silently drops it. Locally both sides
 * are http://localhost, where SameSite=None would be rejected for lacking
 * Secure, so development falls back to Lax.
 */
export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/api/v1/auth',
    maxAge: parseDuration(env.JWT_REFRESH_TTL),
    signed: false,
  };
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

export function clearRefreshCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, options);
}
