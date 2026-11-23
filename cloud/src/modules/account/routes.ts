import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { clientInfo, limiter, requireAuth } from '../../http/middleware';
import { parseBody, validateParam } from '../../http/validate';
import { displayNameField, emailField } from '../auth/routes';
import { loginPasswordField, newPasswordField } from '../auth/passwords';
import type { AuthService } from '../auth/service';
import type { AccountService } from './service';
import type { VerificationService } from '../auth/verification';

const profileSchema = z.strictObject({ displayName: displayNameField.nullable().optional() });
const emailSchema = z.strictObject({ newEmail: emailField, currentPassword: loginPasswordField });
const passwordSchema = z.strictObject({ currentPassword: loginPasswordField, newPassword: newPasswordField });
const settingsSchema = z.strictObject({ language: z.enum(['cs', 'en']).nullable().optional(), securityAlerts: z.boolean().optional() });
const deletionSchema = z.strictObject({ password: loginPasswordField });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function accountRoutes(auth: AuthService, account: AccountService, config: Config, verification: VerificationService): Router {
  const r = Router();
  const sensitive = limiter(config.rateLimit.sensitive, 900_000);
  r.use(requireAuth(auth));
  const me = (req: { auth?: { userId: string; sessionId: string } }) => req.auth as { userId: string; sessionId: string };

  r.get('/', async (req, res, next) => { try { res.json({ user: await account.getProfile(me(req).userId) }); } catch (e) { next(e); } });

  r.patch('/profile', async (req, res, next) => {
    try {
      const body = parseBody(profileSchema, req, { moderate: ['displayName'] });
      res.json({ user: await account.updateProfile(me(req).userId, body.displayName === undefined ? {} : { displayName: body.displayName }) });
    } catch (e) { next(e); }
  });

  r.put('/email', sensitive, async (req, res, next) => {
    try {
      const a = me(req);
      const user = await account.changeEmail(a.userId, a.sessionId, parseBody(emailSchema, req), clientInfo(req));
      verification.forgetVerified(a.userId);                       // the new address is unverified until its own link is opened
      const row = await verification.userRow(a.userId);
      const status = row ? await verification.sendFor(row) : { sent: false, reason: 'delivery_failed' as const };
      res.json({ user, emailVerification: { sent: status.sent, ...(status.reason ? { reason: status.reason } : {}) } });
    } catch (e) { next(e); }
  });

  r.put('/password', sensitive, async (req, res, next) => {
    try {
      const a = me(req);
      res.json(await account.changePassword(a.userId, a.sessionId, parseBody(passwordSchema, req), clientInfo(req)));
    } catch (e) { next(e); }
  });

  r.get('/settings', async (req, res, next) => { try { res.json(await account.getSettings(me(req).userId)); } catch (e) { next(e); } });

  r.patch('/settings', async (req, res, next) => {
    try {
      const a = me(req);
      const body = parseBody(settingsSchema, req);
      const patch: { language?: 'cs' | 'en' | null; securityAlerts?: boolean } = {};
      if (body.language !== undefined) patch.language = body.language;
      if (body.securityAlerts !== undefined) patch.securityAlerts = body.securityAlerts;
      res.json(await account.updateSettings(a.userId, patch, clientInfo(req), a.sessionId));
    } catch (e) { next(e); }
  });

  r.get('/sessions', async (req, res, next) => { try { const a = me(req); res.json({ sessions: await account.listSessions(a.userId, a.sessionId) }); } catch (e) { next(e); } });

  r.delete('/sessions', async (req, res, next) => { try { const a = me(req); res.json(await account.revokeOtherSessions(a.userId, a.sessionId, clientInfo(req))); } catch (e) { next(e); } });

  r.delete('/sessions/:id', validateParam('id', UUID), async (req, res, next) => {
    try { const a = me(req); res.json(await account.revokeSession(a.userId, a.sessionId, req.params['id'] as string, clientInfo(req))); } catch (e) { next(e); }
  });

  r.get('/security-events', async (req, res, next) => {
    try {
      const raw = Number(req.query['limit'] ?? 20);
      const limit = Number.isInteger(raw) ? Math.min(50, Math.max(1, raw)) : 20;
      res.json({ events: await account.listSecurityEvents(me(req).userId, limit) });
    } catch (e) { next(e); }
  });

  // Account deletion is only PREPARED in this phase: the request is recorded and can be cancelled; nothing is erased yet.
  r.post('/deletion-request', sensitive, async (req, res, next) => {
    try { const a = me(req); res.json({ user: await account.requestDeletion(a.userId, a.sessionId, parseBody(deletionSchema, req).password, clientInfo(req)) }); } catch (e) { next(e); }
  });
  r.delete('/deletion-request', async (req, res, next) => {
    try { const a = me(req); res.json({ user: await account.cancelDeletion(a.userId, a.sessionId, clientInfo(req)) }); } catch (e) { next(e); }
  });

  return r;
}
