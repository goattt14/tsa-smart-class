import { Role, UserStatus } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { unauthorized, forbidden } from '../lib/http-error';
import { verifyAccessToken } from '../lib/tokens';
import { resolvePermissions } from '../modules/auth/permission.service';
import type { AuthContext } from '../types/express';

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

interface ScopeShape {
  aggregateOnly?: unknown;
}

/**
 * Verifies the access token, then re-reads the user from the database.
 *
 * The extra query is intentional. A JWT issued fifteen minutes ago cannot know
 * that the account was suspended ten minutes ago; checking status on every
 * request means a disabled account loses access immediately rather than at
 * token expiry.
 */
export async function buildAuthContext(token: string): Promise<AuthContext> {
  const claims = verifyAccessToken(token);

  const user = await prisma.user.findFirst({
    where: { id: claims.sub, deletedAt: null },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      instituteId: true,
      lockedUntil: true,
      studentProfile: { select: { id: true } },
      teacherProfile: { select: { id: true } },
      parentProfile: { select: { id: true } },
      staffProfile: { select: { id: true, accessScope: true } },
    },
  });

  if (!user) throw unauthorized('This account no longer exists.');

  if (user.status === UserStatus.SUSPENDED) {
    throw forbidden('This account is suspended. Contact the administrator.');
  }
  if (user.status === UserStatus.DISABLED) {
    throw forbidden('This account has been disabled.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw forbidden('This account is temporarily locked.');
  }

  const profileId =
    user.studentProfile?.id ??
    user.teacherProfile?.id ??
    user.parentProfile?.id ??
    user.staffProfile?.id ??
    null;

  const scope = (user.staffProfile?.accessScope ?? null) as ScopeShape | null;
  const aggregateOnly = user.role === Role.MANAGEMENT ? scope?.aggregateOnly !== false : false;

  return {
    userId: user.id,
    instituteId: user.instituteId,
    role: user.role,
    email: user.email,
    sessionId: claims.sid,
    permissions: await resolvePermissions(user.id, user.role),
    profileId,
    aggregateOnly,
  };
}

/** Rejects the request unless a valid access token is present. */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = bearerToken(req);
    if (!token) throw unauthorized('Sign in to continue.');
    req.auth = await buildAuthContext(token);
    next();
  } catch (error) {
    next(error);
  }
}

/** Attaches auth when a token is present, but allows anonymous callers through. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    req.auth = await buildAuthContext(token);
  } catch {
    // An invalid token on an optional route is treated as anonymous.
  }
  next();
}
