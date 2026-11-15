import express, { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { limiter, requireAuth } from '../../http/middleware';
import { parseBody } from '../../http/validate';
import { badRequest } from '../../lib/errors';
import type { AuthService } from '../auth/service';
import type { VerificationService } from '../auth/verification';
import type { SyncService } from './service';

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid id.');
const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Invalid characters.');
const hardware = z.record(z.string().max(40), z.union([z.string().max(120), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 20, 'Too many fields.');

const deviceBody = { name: text(80), platform: text(30).optional(), appVersion: text(30).optional(), hardware: hardware.optional() };
const registerSchema = z.strictObject({ clientDeviceId: UUID, ...deviceBody, reactivate: z.boolean().optional() });
const claimSchema = z.strictObject({ deviceId: UUID, clientDeviceId: UUID, ...deviceBody });
const opSchema = z.strictObject({
  kind: z.string().min(1).max(32), key: z.string().min(1).max(120), scope: z.enum(['account', 'device']),
  clientUpdatedAt: z.string().min(20).max(40), data: z.unknown().optional(), deleted: z.boolean().optional(),
});
const pushSchema = z.strictObject({ deviceId: UUID, epoch: z.number().int().min(1).max(1_000_000), ops: z.array(opSchema).min(0).max(500) });

export function syncRoutes(auth: AuthService, sync: SyncService, config: Config, verification: VerificationService): Router {
  const r = Router();
  r.use(limiter(config.rateLimit.sync, 900_000));
  r.use(express.json({ limit: '4mb', strict: true, type: 'application/json' }));   // documents are larger than the 16 KB default of the other endpoints
  r.use(requireAuth(auth));
  r.use(verification.gate);
  const uid = (req: { auth?: { userId: string } }) => (req.auth as { userId: string }).userId;
  const sid = (req: { auth?: { sessionId: string } }) => (req.auth as { sessionId: string }).sessionId;

  r.post('/devices/register', async (req, res, next) => { try { const b = parseBody(registerSchema, req); res.json(await sync.registerDevice(uid(req), sid(req), b)); } catch (e) { next(e); } });
  r.post('/devices/claim', async (req, res, next) => { try { const b = parseBody(claimSchema, req); res.json(await sync.claimDevice(uid(req), sid(req), b)); } catch (e) { next(e); } });
  r.get('/devices', async (req, res, next) => {
    try {
      const q = z.object({ clientDeviceId: UUID.optional(), includeRemoved: z.enum(['true', 'false']).default('false') }).safeParse(req.query);
      if (!q.success) throw badRequest('validation_failed', 'clientDeviceId is not valid.');
      res.json({ devices: await sync.listDevices(uid(req), q.data.clientDeviceId, q.data.includeRemoved === 'true') });
    } catch (e) { next(e); }
  });

  r.post('/push', async (req, res, next) => { try { const b = parseBody(pushSchema, req); res.json(await sync.push(uid(req), { deviceId: b.deviceId, epoch: b.epoch, ops: b.ops as never })); } catch (e) { next(e); } });

  r.get('/changes', async (req, res, next) => {
    try {
      const q = z.object({
        deviceId: UUID, epoch: z.coerce.number().int().min(1).optional(), scope: z.enum(['account', 'plant', 'device']), target: UUID.optional(),
        since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.coerce.number().int().min(1).max(200).default(100), skipOwn: z.enum(['true', 'false']).default('false'),
      }).safeParse(req.query);
      if (!q.success) throw badRequest('validation_failed', 'The request is not valid.', { fields: q.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
      const v = q.data;
      res.json(await sync.changes(uid(req), { deviceId: v.deviceId, epoch: v.epoch, scope: v.scope, target: v.target, since: v.since, limit: v.limit, skipOwn: v.skipOwn === 'true' }));
    } catch (e) { next(e); }
  });

  r.get('/manifest', async (req, res, next) => {
    try {
      const q = z.object({ deviceId: UUID, epoch: z.coerce.number().int().min(1).optional(), since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) }).safeParse(req.query);
      if (!q.success) throw badRequest('validation_failed', 'The request is not valid.');
      res.json(await sync.manifest(uid(req), { deviceId: q.data.deviceId, epoch: q.data.epoch, since: q.data.since, limit: q.data.limit }));
    } catch (e) { next(e); }
  });

  r.get('/status', async (req, res, next) => {
    try { const q = z.object({ deviceId: UUID }).safeParse(req.query); if (!q.success) throw badRequest('validation_failed', 'deviceId is required.'); res.json(await sync.status(uid(req), q.data.deviceId)); } catch (e) { next(e); }
  });
  return r;
}
