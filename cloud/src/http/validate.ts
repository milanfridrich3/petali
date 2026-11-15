import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { badRequest } from '../lib/errors';

// Request bodies are parsed with STRICT schemas: unknown keys are an error, not silently ignored, so a client can
// never smuggle in fields such as "userId", "petaliId" or "emailVerified" hoping the server will accept them.
export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  const r = schema.safeParse(req.body === undefined ? {} : req.body);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message }));
    throw badRequest('validation_failed', 'The request is not valid.', { fields });
  }
  return r.data;
}

export function validateParam(name: string, pattern: RegExp): RequestHandler {
  return (req, _res, next) => {
    const v = req.params[name];
    if (typeof v !== 'string' || !pattern.test(v)) return next(badRequest('validation_failed', `Invalid ${name}.`, { fields: [{ field: name, message: 'Invalid format.' }] }));
    next();
  };
}
