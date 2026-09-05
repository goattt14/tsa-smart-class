import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { checkDatabase, disconnectPrisma } from './lib/prisma';
import { syncPermissionCatalog } from './modules/auth/permission.service';
import { startScheduler, stopScheduler } from './jobs/scheduler';

process.env.TZ = env.TZ;

async function bootstrap(): Promise<void> {
  const app = createApp();

  // Render assigns PORT at runtime; binding 0.0.0.0 is required there.
  const server: Server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, tz: env.TZ, aiProvider: env.AI_PROVIDER },
      'TSA API listening',
    );
  });

  const db = await checkDatabase();
  if (db.ok) logger.info({ latencyMs: db.latencyMs }, 'database connected');
  else logger.error({ error: db.error }, 'database unreachable — API is up but degraded');

  // Reconcile the permission catalogue with the code. A deploy that introduces
  // a new permission key must not leave the database a version behind, or the
  // guard referencing that key would refuse everyone.
  if (db.ok) {
    try {
      const synced = await syncPermissionCatalog();
      logger.info(synced, 'permission catalogue synchronised');
    } catch (error) {
      logger.error({ err: error }, 'permission sync failed — run the seed manually');
    }
  }

  // Background jobs need the database, so they only start once it answers.
  if (db.ok) startScheduler();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('forced exit after 15s');
      process.exit(1);
    }, 15_000);
    force.unref();

    server.close(async (err) => {
      if (err) logger.error({ err }, 'error while closing server');
      stopScheduler();
      await disconnectPrisma();
      clearTimeout(force);
      process.exit(err ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

void bootstrap();
