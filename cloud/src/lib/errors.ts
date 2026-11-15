// One error type for everything the API deliberately rejects. Anything else that reaches the
// error handler is treated as an unexpected failure (logged in full, answered with a generic 500).
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, opts: { details?: unknown; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = opts.details;
    this.headers = opts.headers;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, { details });
export const unauthorized = (code = 'unauthorized', message = 'Authentication is required.') =>
  new AppError(401, code, message, { headers: { 'WWW-Authenticate': 'Bearer' } });
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (code = 'not_found', message = 'Not found.') => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooMany = (retryAfterSeconds: number, code = 'too_many_attempts', message = 'Too many attempts. Try again later.') =>
  new AppError(429, code, message, { headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) } });
