import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError, notFound, tooMany, unauthorized } from '../lib/errors';
import type { Logger } from '../lib/logger';
import type { AuthService } from '../modules/auth/service';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    auth?: { userId: string; sessionId: string };
  }
}

export const clientInfo = (req: Request) => ({ ip: req.ip ?? null, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null });

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

// One line per request: method, route pattern, status, duration, ids. No query string, no headers, no body.
export const requestLogger = (log: Logger): RequestHandler => (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.route && typeof req.route.path === 'string' ? `${req.baseUrl}${req.route.path}` : '(unmatched)';
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level]({ requestId: req.id, method: req.method, route, status: res.statusCode, ms: Math.round(ms * 10) / 10, userId: req.auth?.userId, sessionId: req.auth?.sessionId }, 'request');
  });
  next();
};

export const noStore: RequestHandler = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); };

export const apiVersion = (v: string): RequestHandler => (_req, res, next) => { res.setHeader('X-Petali-API-Version', v); next(); };

export const requireAuth = (auth: AuthService): RequestHandler => async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    const m = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header) : null;
    if (!m) throw unauthorized('missing_token', 'Authentication is required.');
    req.auth = await auth.authenticate(m[1] as string);
    next();
  } catch (err) { next(err); }
};

export function limiter(max: number, windowMs: number): RequestHandler {
  return rateLimit({
    windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req: Request, _res: Response, next: NextFunction, options) => next(tooMany(Math.ceil(options.windowMs / 1000), 'rate_limited', 'Too many requests. Try again later.')),
  });
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('route_not_found', 'No such endpoint.'));

export const errorHandler = (log: Logger): ErrorRequestHandler => (err, req, res, _next) => {
  if (res.headersSent) return;
  let status = 500; let code = 'internal_error'; let message = 'Something went wrong on our side.'; let details: unknown;
  if (err instanceof AppError) {
    status = err.status; code = err.code; message = err.message; details = err.details;
    for (const [k, v] of Object.entries(err.headers ?? {})) res.setHeader(k, v);
  } else if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    status = 400; code = 'invalid_json'; message = 'The request body is not valid JSON.';
  } else if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
    status = 413; code = 'payload_too_large'; message = 'The request body is too large.';
  } else {
    log.error({ requestId: req.id, err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err) }, 'unhandled error');   // the client only ever gets the generic message
  }
  res.status(status).json({ error: { code, message, requestId: req.id, ...(details !== undefined ? { details } : {}) } });
};
