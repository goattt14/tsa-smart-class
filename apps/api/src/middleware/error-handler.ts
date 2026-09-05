import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/http-error';
import { logger } from '../lib/logger';
import { isProduction } from '../config/env';
import { describeMulterError, isMulterError } from './upload';

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
    stack?: string;
  };
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  const target = (error.meta?.target as string[] | string | undefined) ?? undefined;
  switch (error.code) {
    case 'P2002':
      return {
        status: 409,
        code: 'DUPLICATE_VALUE',
        message: 'A record with these details already exists.',
        details: { fields: target },
      };
    case 'P2003':
      return {
        status: 409,
        code: 'FOREIGN_KEY_VIOLATION',
        message: 'This record is linked to other data and cannot be changed.',
        details: { field: error.meta?.field_name },
      };
    case 'P2025':
      return { status: 404, code: 'NOT_FOUND', message: 'The requested record no longer exists.' };
    case 'P2014':
      return {
        status: 409,
        code: 'RELATION_VIOLATION',
        message: 'This change would break a required relationship.',
      };
    default:
      return { status: 500, code: 'DATABASE_ERROR', message: 'A database error occurred.' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Multer rejects oversized or wrong-typed uploads before any controller runs,
  // so without this its errors would escape as a bare 500.
  if (isMulterError(err)) {
    res.status(413).json({
      success: false,
      error: { code: 'UPLOAD_REJECTED', message: describeMulterError(err) },
    });
    return;
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side. Try again in a moment.';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_FAILED';
    message = 'Check the highlighted fields and try again.';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = mapPrismaError(err);
    status = mapped.status;
    code = mapped.code;
    message = mapped.message;
    details = mapped.details;
  } else if (err instanceof Prisma.PrismaClientInitializationError) {
    status = 503;
    code = 'DATABASE_UNAVAILABLE';
    message = 'The database is not reachable right now.';
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    status = 400;
    code = 'INVALID_QUERY';
    message = 'The request could not be processed.';
  } else if (err instanceof Error && err.message.startsWith('Origin ')) {
    status = 403;
    code = 'CORS_REJECTED';
    message = err.message;
  }

  const logPayload = {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    code,
    err,
  };
  if (status >= 500) logger.error(logPayload, message);
  else logger.warn(logPayload, message);

  const body: ErrorBody = {
    success: false,
    error: { code, message, requestId: req.requestId },
  };
  if (details !== undefined) body.error.details = details;
  if (!isProduction && err instanceof Error) body.error.stack = err.stack;

  res.status(status).json(body);
}
