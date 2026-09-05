import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env';

const shared = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
  },
};

/**
 * A single IPv6 client is typically handed a whole /64, so keying on the full
 * address lets one machine rotate through millions of "distinct" clients.
 * Collapse to the /64 prefix; IPv4 addresses are used as-is.
 */
function clientIpKey(req: Request): string {
  const ip = req.ip ?? 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  return ip;
}

/** Applied to every /api/v1 route. */
export const globalLimiter = rateLimit({
  ...shared,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  skip: (req) => req.path === '/health' || req.path === '/health/db',
});

/** Tighter budget for credential endpoints, keyed by IP + submitted email. */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  validate: false, // custom keyGenerator; the built-in IP checks do not apply
  keyGenerator: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.toLowerCase() : 'anonymous';
    return `${clientIpKey(req)}:${email}`;
  },
});

/** Guards expensive model calls so one user cannot drain the token budget. */
export const aiLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 20,
});
