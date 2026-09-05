/** Application error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational = true;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, AppError);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Sign in to continue.') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (resource = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${resource} was not found.`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE_ENTITY', message, details);

export const tooManyRequests = (message = 'Too many requests. Try again shortly.') =>
  new AppError(429, 'RATE_LIMITED', message);

export const serviceUnavailable = (message: string, details?: unknown) =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message, details);
