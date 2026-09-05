import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wraps an async controller so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req as T, res, next).catch(next);
  };
}
