import type { CorsOptions } from 'cors';
import { corsOrigins, env } from './env';

/** Vercel preview deployments look like https://<project>-<hash>-<scope>.vercel.app */
const VERCEL_PREVIEW = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

export function isOriginAllowed(origin: string): boolean {
  if (corsOrigins.includes(origin)) return true;
  if (env.ALLOW_VERCEL_PREVIEWS && VERCEL_PREVIEW.test(origin)) return true;
  return false;
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Same-origin requests, curl and health checks send no Origin header.
    if (!origin) return callback(null, true);
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Client-Version'],
  exposedHeaders: ['X-Request-Id', 'X-Total-Count', 'RateLimit-Remaining'],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};
