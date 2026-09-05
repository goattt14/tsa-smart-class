import type { Role } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden, unauthorized } from '../lib/http-error';
import { SENSITIVE_KEYS } from '../modules/auth/permissions.catalog';
import type { AuthContext } from '../types/express';

/** Narrows req.auth for controllers that sit behind requireAuth. */
export function requireContext(req: Request): AuthContext {
  if (!req.auth) throw unauthorized('Sign in to continue.');
  return req.auth;
}

/** Allows the request only for the listed roles. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = requireContext(req);
      if (!roles.includes(auth.role)) {
        throw forbidden('Your role does not have access to this resource.');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Requires every listed permission key.
 *
 * A MANAGEMENT account in aggregate-only mode is refused any sensitive key even
 * if some override handed it over, because aggregate-only is a stronger promise
 * to families than a permission row is a grant to staff. Clearing the flag is
 * the deliberate, auditable way to change that.
 */
export function requirePermission(...keys: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = requireContext(req);

      for (const key of keys) {
        if (auth.aggregateOnly && SENSITIVE_KEYS.has(key)) {
          throw forbidden(
            'This account is limited to aggregate reporting and cannot open individual student records.',
          );
        }
        if (!auth.permissions.has(key)) {
          throw forbidden(`You are missing the "${key}" permission.`);
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Allows the request if the caller holds any one of the listed permissions. */
export function requireAnyPermission(...keys: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = requireContext(req);
      const allowed = keys.some(
        (key) => auth.permissions.has(key) && !(auth.aggregateOnly && SENSITIVE_KEYS.has(key)),
      );
      if (!allowed) {
        throw forbidden('You do not have access to this resource.');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Lets a user reach their own record without a broad permission, while anyone
 * else needs the escalated key. `param` names the route parameter holding the
 * target user id.
 */
export function requireSelfOrPermission(param: string, ...keys: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireContext(req);
      if (req.params[param] === auth.userId || req.params[param] === 'me') {
        next();
        return;
      }
      requirePermission(...keys)(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

/** Blocks aggregate-only accounts from a route outright. */
export const denyAggregateOnly: RequestHandler = (req, _res, next) => {
  try {
    const auth = requireContext(req);
    if (auth.aggregateOnly) {
      throw forbidden(
        'This account is limited to aggregate reporting and cannot open individual student records.',
      );
    }
    next();
  } catch (error) {
    next(error);
  }
};
