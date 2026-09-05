import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { unauthorized } from './http-error';

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  inst: string;
  sid: string;
  typ: 'access';
}

const ISSUER = 'tsa-api';

export function signAccessToken(claims: Omit<AccessTokenClaims, 'typ'>): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: ISSUER,
    audience: 'tsa-web',
  };
  return jwt.sign({ ...claims, typ: 'access' }, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: 'tsa-web',
    });

    if (typeof decoded === 'string' || decoded.typ !== 'access') {
      throw unauthorized('That token cannot be used here.');
    }

    return decoded as AccessTokenClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthorized('Your session expired. Refreshing.');
    }
    throw unauthorized('Your session is no longer valid. Sign in again.');
  }
}

export interface OpaqueToken {
  /** Sent to the client. Never written to the database. */
  raw: string;
  /** Stored. A database leak alone cannot be replayed as a session. */
  hash: string;
}

/**
 * Refresh tokens are opaque, not JWTs. A JWT refresh token cannot be revoked
 * before it expires; a random string checked against a row can be revoked the
 * instant reuse is detected.
 */
export function createOpaqueToken(bytes = 48): OpaqueToken {
  const raw = crypto.randomBytes(bytes).toString('base64url');
  return { raw, hash: sha256(raw) };
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Timing-safe comparison for tokens supplied by a caller. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Turns "30d" / "15m" / "12h" / "45s" into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported duration: ${value}`);

  const amount = Number(match[1]);
  const unit = match[2];
  const scale: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  const factor = unit ? scale[unit] : undefined;
  if (!factor) throw new Error(`Unsupported duration unit: ${value}`);

  return amount * factor;
}
