import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { clientInfo, limiter, requireAuth } from '../../http/middleware';
import { parseBody, validateParam } from '../../http/validate';
import { badRequest } from '../../lib/errors';
import type { AuthService } from '../auth/service';
import type { VerificationService } from '../auth/verification';
import type { DeviceService } from './service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = z.string().regex(UUID_RE, 'Invalid id.');
// A display name: NFC, trimmed, inner whitespace collapsed, 1..80 characters, no control characters. It is a label, never an identifier.
const displayName = z.string().max(400).transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim()).pipe(z.string().min(1, 'A name is required.').max(80, 'At most 80 characters.').refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Invalid characters.'));
const renameSchema = z.strictObject({ name: displayName, clientUpdatedAt: z.string().min(20).max(40).optional() });
const removeSchema = z.strictObject({ confirm: z.literal(true, { error: 'confirm must be true.' }), currentDeviceId: UUID.optional(), allowCurrent: z.boolean().optional(), deleteCloudHistory: z.boolean().optional() });

export function deviceRoutes(auth: AuthService, devices: DeviceService, config: Config, verification: VerificationService): Router {
  const r = Router();
  r.use(limiter(config.rateLimit.devices, 900_000));
  r.use(requireAuth(auth));
  r.use(verification.gate);
  const uid = (req: { auth?: { userId: string } }) => (req.auth as { userId: string }).userId;
  const sid = (req: { auth?: { sessionId: string } }) => (req.auth as { sessionId: string }).sessionId;
  const id = validateParam('id', UUID_RE);

  r.get('/', async (req, res, next) => {
    try {
      const q = z.object({ clientDeviceId: UUID.optional(), includeRemoved: z.enum(['true', 'false']).default('false') }).safeParse(req.query);
      if (!q.success) throw badRequest('validation_failed', 'The query is not valid.');
      res.json(await devices.list(uid(req), { clientDeviceId: q.data.clientDeviceId, includeRemoved: q.data.includeRemoved === 'true' }));
    } catch (e) { next(e); }
  });
  r.get('/:id', id, async (req, res, next) => {
    try {
      const q = z.object({ clientDeviceId: UUID.optional() }).safeParse(req.query);
      if (!q.success) throw badRequest('validation_failed', 'clientDeviceId is not valid.');
      res.json(await devices.detail(uid(req), req.params['id'] as string, q.data.clientDeviceId));
    } catch (e) { next(e); }
  });
  r.get('/:id/summary', id, async (req, res, next) => {
    try {
      const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).safeParse(req.query);
      if (!q.success) throw badRequest('validation_failed', 'days must be between 1 and 365.');
      res.json(await devices.summary(uid(req), req.params['id'] as string, q.data.days));
    } catch (e) { next(e); }
  });
  r.patch('/:id', id, async (req, res, next) => {
    try { const b = parseBody(renameSchema, req); res.json(await devices.rename(uid(req), req.params['id'] as string, b)); } catch (e) { next(e); }
  });
  // POST (not DELETE): the request carries an explicit confirmation and choices, and a body on DELETE is not reliably supported by proxies.
  r.post('/:id/remove', limiter(config.rateLimit.deviceRemove, 900_000), id, async (req, res, next) => {
    try { const b = parseBody(removeSchema, req); res.json(await devices.remove(uid(req), req.params['id'] as string, b, clientInfo(req), sid(req))); } catch (e) { next(e); }
  });
  return r;
}
