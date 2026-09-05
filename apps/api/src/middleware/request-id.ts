import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

/** Accepts a client-supplied X-Request-Id (for tracing) or mints one. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('X-Request-Id');
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
