import { Router } from 'express';
import { checkDatabase } from '../lib/prisma';
import { env } from '../config/env';
import { asyncHandler } from '../middleware/async-handler';

const router = Router();
const bootedAt = Date.now();

/** Liveness. Must stay dependency-free so Render's health check never flaps. */
router.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      service: 'tsa-api',
      environment: env.NODE_ENV,
      uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
      timestamp: new Date().toISOString(),
    },
  });
});

/** Readiness. Reports the database round-trip so the UI can explain outages. */
router.get(
  '/db',
  asyncHandler(async (_req, res) => {
    const result = await checkDatabase();
    res.status(result.ok ? 200 : 503).json({
      success: result.ok,
      data: {
        database: result.ok ? 'connected' : 'unreachable',
        latencyMs: result.latencyMs,
        aiProvider: env.AI_PROVIDER,
        storageDriver: env.STORAGE_DRIVER,
        timestamp: new Date().toISOString(),
      },
      ...(result.error ? { error: { code: 'DATABASE_UNAVAILABLE', message: result.error } } : {}),
    });
  }),
);

export default router;
