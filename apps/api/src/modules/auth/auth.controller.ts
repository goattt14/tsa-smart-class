import type { Request, Response } from 'express';
import { ok } from '../../lib/api-response';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from '../../lib/cookies';
import { unauthorized } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from './auth.schemas';
import * as authService from './auth.service';

function fingerprint(req: Request): authService.RequestFingerprint {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

export async function loginHandler(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  const result = await authService.login(input.email, input.password, fingerprint(req));

  setRefreshCookie(res, result.tokens.refreshToken);

  return ok(res, {
    user: result.user,
    accessToken: result.tokens.accessToken,
    expiresIn: result.tokens.expiresIn,
  });
}

export async function refreshHandler(req: Request, res: Response) {
  // The cookie is the supported path. The body fallback exists for native
  // clients and integration tests, which have no cookie jar.
  const body = req.body as { refreshToken?: unknown } | undefined;
  const fromCookie = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  const token = fromCookie ?? (typeof body?.refreshToken === 'string' ? body.refreshToken : undefined);

  if (!token) throw unauthorized('Your session has ended. Sign in again.');

  const result = await authService.refreshSession(token, fingerprint(req));
  setRefreshCookie(res, result.tokens.refreshToken);

  return ok(res, {
    user: result.user,
    accessToken: result.tokens.accessToken,
    expiresIn: result.tokens.expiresIn,
  });
}

export async function logoutHandler(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  await authService.logout(token);
  clearRefreshCookie(res);
  return ok(res, { signedOut: true });
}

export async function logoutAllHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const count = await authService.revokeAllSessions(auth.userId, 'LOGOUT_ALL');
  clearRefreshCookie(res);
  return ok(res, { signedOut: true, sessionsEnded: count });
}

export async function meHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const user = await authService.loadCurrentUser(auth.userId);
  return ok(res, { user });
}

export async function changePasswordHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = changePasswordSchema.parse(req.body);

  await authService.changePassword(
    auth.userId,
    input.currentPassword,
    input.newPassword,
    input.signOutOtherDevices,
  );

  if (input.signOutOtherDevices) clearRefreshCookie(res);

  return ok(res, {
    updated: true,
    message: input.signOutOtherDevices
      ? 'Password changed. Sign in again on your devices.'
      : 'Password changed.',
  });
}

export async function forgotPasswordHandler(req: Request, res: Response) {
  const input = forgotPasswordSchema.parse(req.body);
  const result = await authService.requestPasswordReset(input.email, fingerprint(req));

  return ok(res, {
    // Deliberately identical whether or not the address exists.
    message: 'If that email is registered, a reset link is on its way.',
    ...(result.devToken ? { devToken: result.devToken } : {}),
  });
}

export async function resetPasswordHandler(req: Request, res: Response) {
  const input = resetPasswordSchema.parse(req.body);
  await authService.resetPassword(input.token, input.newPassword);
  clearRefreshCookie(res);
  return ok(res, { reset: true, message: 'Password updated. You can sign in now.' });
}

export async function sessionsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const sessions = await authService.listSessions(auth.userId, auth.sessionId);
  return ok(res, { sessions });
}

export async function revokeSessionHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const sessionId = req.params.sessionId ?? '';
  await authService.revokeSession(auth.userId, sessionId);
  return ok(res, { revoked: true });
}

export async function permissionsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  return ok(res, {
    role: auth.role,
    aggregateOnly: auth.aggregateOnly,
    permissions: [...auth.permissions].sort(),
  });
}
