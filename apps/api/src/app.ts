import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { corsOptions } from './config/cors';
import { env, isTest } from './config/env';
import { logger } from './lib/logger';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { globalLimiter } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import v1Routes from './routes';

export function createApp(): Express {
  const app = express();

  // Render terminates TLS at its proxy; trust it so req.ip and secure cookies work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: false, // the SPA is served by Vercel, not this API
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cors(corsOptions));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(requestId);

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as { requestId?: string }).requestId ?? 'unknown',
        autoLogging: {
          ignore: (req) => req.url === '/api/v1/health' || req.url === '/',
        },
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      }),
    );
  }

  app.get('/', (_req, res) => {
    res.status(200).json({
      success: true,
      data: { name: env.APP_NAME, api: 'v1', docs: '/api/v1/health' },
    });
  });

  app.use('/api/v1', globalLimiter, v1Routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
