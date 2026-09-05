import crypto from 'node:crypto';
import { AuditAction, Role, UserStatus, type User } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { badRequest, forbidden, unauthorized, unprocessable } from '../../lib/http-error';
import { burnPasswordTime, checkPasswordStrength, hashPassword, verifyPassword } from '../../lib/password';
import { createOpaqueToken, parseDuration, sha256, signAccessToken } from '../../lib/tokens';
import { invalidateUserPermissions, resolvePermissions } from './permission.service';

/** Failed attempts before the account is frozen. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface RequestFingerprint {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  status: UserStatus;
  mustChangePassword: boolean;
  instituteId: string;
  profileId: string | null;
  permissions: string[];
}

function publicUser(
  user: Pick<
    User,
    | 'id'
    | 'email'
    | 'role'
    | 'firstName'
    | 'lastName'
    | 'avatarUrl'
    | 'status'
    | 'mustChangePassword'
    | 'instituteId'
  >,
  profileId: string | null,
  permissions: Set<string>,
): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    instituteId: user.instituteId,
    profileId,
    permissions: [...permissions].sort(),
  };
}

const profileSelect = {
  studentProfile: { select: { id: true } },
  teacherProfile: { select: { id: true } },
  parentProfile: { select: { id: true } },
  staffProfile: { select: { id: true } },
} as const;

interface WithProfiles {
  studentProfile: { id: string } | null;
  teacherProfile: { id: string } | null;
  parentProfile: { id: string } | null;
  staffProfile: { id: string } | null;
}

function pickProfileId(user: WithProfiles): string | null {
  return (
    user.studentProfile?.id ??
    user.teacherProfile?.id ??
    user.parentProfile?.id ??
    user.staffProfile?.id ??
    null
  );
}

/** Mints an access token plus a fresh refresh token in a new rotation family. */
async function startSession(
  userId: string,
  role: Role,
  instituteId: string,
  fingerprint: RequestFingerprint,
  familyId = crypto.randomUUID(),
): Promise<SessionTokens> {
  const refresh = createOpaqueToken();
  const ttlMs = parseDuration(env.JWT_REFRESH_TTL);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: refresh.hash,
      familyId,
      userAgent: fingerprint.userAgent?.slice(0, 300) ?? null,
      ipAddress: fingerprint.ip,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });

  return {
    accessToken: signAccessToken({ sub: userId, role, inst: instituteId, sid: familyId }),
    refreshToken: refresh.raw,
    expiresIn: Math.floor(parseDuration(env.JWT_ACCESS_TTL) / 1000),
  };
}

export interface LoginResult {
  user: AuthenticatedUser;
  tokens: SessionTokens;
}

export async function login(
  email: string,
  password: string,
  fingerprint: RequestFingerprint,
): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    include: profileSelect,
  });

  // Identical message and comparable timing whether or not the email exists,
  // so this endpoint cannot be used to enumerate accounts.
  if (!user) {
    await burnPasswordTime(password);
    throw unauthorized('Incorrect email or password.');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000));
    throw forbidden(`Too many failed attempts. Try again in ${minutes} minute(s).`);
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);

  if (!passwordOk) {
    const attempts = user.failedLoginCount + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : null,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorRole: user.role,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        summary: shouldLock
          ? 'Account locked after repeated failed sign-in attempts'
          : `Failed sign-in attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}`,
        ipAddress: fingerprint.ip,
        userAgent: fingerprint.userAgent,
      },
    });

    if (shouldLock) {
      throw forbidden('Too many failed attempts. This account is locked for 15 minutes.');
    }
    throw unauthorized('Incorrect email or password.');
  }

  if (user.status === UserStatus.SUSPENDED) {
    throw forbidden('This account is suspended. Contact the administrator.');
  }
  if (user.status === UserStatus.DISABLED) {
    throw forbidden('This account has been disabled.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: fingerprint.ip,
      // An invited user who successfully signs in is now an active one.
      status: user.status === UserStatus.INVITED ? UserStatus.ACTIVE : user.status,
    },
  });

  const tokens = await startSession(user.id, user.role, user.instituteId, fingerprint);
  const permissions = await resolvePermissions(user.id, user.role);

  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      actorRole: user.role,
      action: AuditAction.LOGIN,
      entityType: 'User',
      entityId: user.id,
      summary: 'Signed in',
      ipAddress: fingerprint.ip,
      userAgent: fingerprint.userAgent,
    },
  });

  return { user: publicUser(updated, pickProfileId(user), permissions), tokens };
}

/**
 * Rotates a refresh token.
 *
 * Each token may be redeemed exactly once. Presenting a token that was already
 * rotated means either a replay or a stolen cookie, and there is no way to tell
 * which, so the entire family is revoked and every session from that login
 * chain dies. The user signs in again; an attacker gets nothing.
 */
export async function refreshSession(
  rawToken: string,
  fingerprint: RequestFingerprint,
): Promise<LoginResult> {
  const tokenHash = sha256(rawToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { include: profileSelect } },
  });

  if (!stored) throw unauthorized('Your session has ended. Sign in again.');

  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' },
    });

    logger.warn(
      { userId: stored.userId, familyId: stored.familyId, ip: fingerprint.ip },
      'refresh token reuse detected; session family revoked',
    );

    throw unauthorized('Your session was ended for security reasons. Sign in again.');
  }

  if (stored.expiresAt <= new Date()) {
    throw unauthorized('Your session expired. Sign in again.');
  }

  const user = stored.user;

  if (user.deletedAt) throw unauthorized('This account no longer exists.');
  if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.DISABLED) {
    throw forbidden('This account is no longer active.');
  }

  const next = createOpaqueToken();
  const ttlMs = parseDuration(env.JWT_REFRESH_TTL);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: {
        revokedAt: new Date(),
        revokedReason: 'ROTATED',
        replacedByHash: next.hash,
      },
    }),
    prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: next.hash,
        familyId: stored.familyId,
        userAgent: fingerprint.userAgent?.slice(0, 300) ?? null,
        ipAddress: fingerprint.ip,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    }),
  ]);

  const permissions = await resolvePermissions(user.id, user.role);

  return {
    user: publicUser(user, pickProfileId(user), permissions),
    tokens: {
      accessToken: signAccessToken({
        sub: user.id,
        role: user.role,
        inst: user.instituteId,
        sid: stored.familyId,
      }),
      refreshToken: next.raw,
      expiresIn: Math.floor(parseDuration(env.JWT_ACCESS_TTL) / 1000),
    },
  };
}

/** Ends the session the supplied token belongs to. Never throws on a bad token. */
export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;

  const stored = await prisma.refreshToken
    .findUnique({
      where: { tokenHash: sha256(rawToken) },
      select: { familyId: true, userId: true },
    })
    .catch(() => null);

  if (!stored) return;

  await prisma.refreshToken.updateMany({
    where: { familyId: stored.familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
  });
}

/** Revokes every live session for a user. Used on password change and by admins. */
export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  signOutOthers: boolean,
): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      passwordHash: true,
    },
  });

  if (!user) throw unauthorized('This account no longer exists.');

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw badRequest('Your current password is incorrect.');
  }

  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw unprocessable('Choose a password you have not used here before.');
  }

  const strength = checkPasswordStrength(newPassword, [
    user.email.split('@')[0] ?? '',
    user.firstName,
    user.lastName,
  ]);

  if (!strength.ok) {
    throw unprocessable('That password is not strong enough.', { problems: strength.problems });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    },
  });

  if (signOutOthers) {
    await revokeAllSessions(user.id, 'PASSWORD_CHANGED');
  }

  invalidateUserPermissions(user.id);
}

/**
 * Always resolves, whether or not the address is registered. Returning "no such
 * user" here would turn the reset form into an account-enumeration oracle.
 * The token is returned only outside production so the flow is testable without
 * a mail provider configured.
 */
export async function requestPasswordReset(
  email: string,
  fingerprint: RequestFingerprint,
): Promise<{ devToken?: string }> {
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, status: true },
  });

  if (!user || user.status === UserStatus.DISABLED) return {};

  const token = createOpaqueToken(32);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      ipAddress: fingerprint.ip,
    },
  });

  const resetUrl = `${env.APP_WEB_URL}/reset-password?token=${token.raw}`;

  if (env.MAIL_DRIVER === 'console') {
    logger.info({ email, resetUrl }, 'password reset link generated');
  }
  // Phase 6 replaces this with the real mail transport.

  return env.NODE_ENV === 'production' ? {} : { devToken: token.raw };
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: {
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  });

  if (!record || record.usedAt || record.expiresAt <= new Date()) {
    throw badRequest('This reset link is invalid or has expired. Request a new one.');
  }

  const strength = checkPasswordStrength(newPassword, [
    record.user.email.split('@')[0] ?? '',
    record.user.firstName,
    record.user.lastName,
  ]);

  if (!strength.ok) {
    throw unprocessable('That password is not strong enough.', { problems: strength.problems });
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    // Any other outstanding reset links for this user are now void.
    prisma.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null, id: { not: record.id } },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
    }),
  ]);

  invalidateUserPermissions(record.userId);
}

/** Sessions for the account settings screen. */
export async function listSessions(userId: string, currentFamilyId: string) {
  const rows = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: {
      familyId: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  const byFamily = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!byFamily.has(row.familyId)) byFamily.set(row.familyId, row);
  }

  return [...byFamily.values()].map((row) => ({
    sessionId: row.familyId,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    startedAt: row.createdAt,
    expiresAt: row.expiresAt,
    isCurrent: row.familyId === currentFamilyId,
  }));
}

export async function revokeSession(userId: string, familyId: string): Promise<void> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' },
  });

  if (result.count === 0) throw badRequest('That session is already closed.');
}

export async function loadCurrentUser(userId: string): Promise<AuthenticatedUser> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    include: profileSelect,
  });

  if (!user) throw unauthorized('This account no longer exists.');

  const permissions = await resolvePermissions(user.id, user.role);
  return publicUser(user, pickProfileId(user), permissions);
}
