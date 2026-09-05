import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env';
import { logger } from './logger';

/**
 * The log array is passed inline so Prisma infers the literal event types and
 * `$on('query' | 'warn' | 'error')` stays fully typed. The connection URL comes
 * from the schema's env("DATABASE_URL") binding.
 */
const createPrismaClient = () =>
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

// tsx watch reloads the module on every save; caching on globalThis in
// development prevents a new connection pool per reload.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

prisma.$on('error', (e) => logger.error({ target: e.target, message: e.message }, 'prisma error'));
prisma.$on('warn', (e) => logger.warn({ target: e.target, message: e.message }, 'prisma warning'));

if (!isProduction) {
  globalForPrisma.prisma = prisma;
  prisma.$on('query', (e) => {
    if (e.duration > 300) logger.debug({ ms: e.duration, query: e.query }, 'slow query');
  });
}

/** Cheap liveness probe used by /health/db. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  }
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
