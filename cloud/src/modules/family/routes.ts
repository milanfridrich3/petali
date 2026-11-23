import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { clientInfo, limiter, requireAuth } from '../../http/middleware';
import { parseBody, validateParam } from '../../http/validate';
import { badRequest } from '../../lib/errors';
import type { AuthService } from '../auth/service';
import type { VerificationService } from '../auth/verification';
import type { DashboardService } from './dashboard';
import type { FamilyDeviceService } from './devices';
import type { InvitationService } from './invitations';
import type { WellbeingService } from './wellbeing';
import { PRIVACY_CATEGORIES } from './permissions';
import type { FamilyService } from './service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = z.string().regex(UUID_RE, 'Invalid id.');
const confirm = z.strictObject({ confirm: z.literal(true, { error: 'confirm must be true.' }) });
const createSchema = z.strictObject({ name: z.string().min(1).max(480) });
const updateSchema = z.strictObject({ name: z.string().min(1).max(480).optional(), settings: z.strictObject({ childrenCanLeave: z.boolean().optional() }).optional() });
const ownershipSchema = z.strictObject({ memberId: UUID, confirm: z.literal(true, { error: 'confirm must be true.' }) });
const roleSchema = z.strictObject({ role: z.string().regex(/^[a-z][a-z_]{1,31}$/, 'Invalid role.') });
const permissionsSchema = z.strictObject({ grant: z.array(z.string().max(64)).max(32).default([]), deny: z.array(z.string().max(64)).max(32).default([]) });
const sharingShape: Record<string, z.ZodOptional<z.ZodBoolean>> = {}; for (const c of PRIVACY_CATEGORIES) sharingShape[c] = z.boolean().optional();
const sharingSchema = z.strictObject(sharingShape);
const inviteSchema = z.strictObject({ petaliId: z.string().min(10).max(20).optional(), email: z.string().min(3).max(254).optional(), role: z.string().regex(/^[a-z][a-z_]{1,31}$/, 'Invalid role.').default('child') });
const codeSchema = z.strictObject({ code: z.string().min(10).max(80) });
const ruleBody = z.strictObject({ kind: z.string().max(16), config: z.record(z.string(), z.unknown()) });
const ruleUpdate = z.strictObject({ config: z.record(z.string(), z.unknown()) });
const answerSchema = z.strictObject({ accept: z.boolean() });
const transferSchema = z.strictObject({ toMemberId: UUID });

// Petali Family API (/v1/family). Everything needs a signed-in account; the account is the one of the verified access token. Ids in URLs and bodies are
// only ever looked up INSIDE the caller's own family by the services (a foreign id answers exactly like an unknown one).
export function familyRoutes(auth: AuthService, family: FamilyService, invitations: InvitationService, devices: FamilyDeviceService, config: Config, verification: VerificationService, dashboard: DashboardService, wellbeing: WellbeingService): Router {
  const r = Router();
  r.use(limiter(config.rateLimit.family, 900_000));
  r.use(requireAuth(auth));
  r.use(verification.gate);
  const invite = limiter(config.rateLimit.familyInvite, 900_000);
  const uid = (req: Request) => (req.auth as { userId: string }).userId;
  const idParam = (name: string) => validateParam(name, UUID_RE);
  const wrap = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
    try { res.status(status).json(await fn(req)); } catch (e) { next(e); }
  };
  const statusQuery = (req: Request): 'pending' | 'all' => {
    const q = z.object({ status: z.enum(['pending', 'all']).default('pending') }).safeParse(req.query);
    if (!q.success) throw badRequest('validation_failed', 'status must be pending or all.');
    return q.data.status;
  };

  // the family
  r.get('/', wrap((req) => family.overview(uid(req))));
  r.post('/', wrap((req) => family.createFamily(uid(req), parseBody(createSchema, req, { moderate: ['name'] }), clientInfo(req)), 201));
  r.patch('/', wrap((req) => family.updateFamily(uid(req), parseBody(updateSchema, req, { moderate: ['name'] }), clientInfo(req))));
  r.post('/dissolve', wrap((req) => { parseBody(confirm, req); return family.dissolve(uid(req), clientInfo(req)); }));
  r.post('/leave', wrap((req) => { parseBody(confirm, req); return family.leave(uid(req), clientInfo(req)); }));
  r.post('/ownership', wrap((req) => family.transferOwnership(uid(req), parseBody(ownershipSchema, req).memberId, clientInfo(req))));

  // members
  r.get('/members', wrap((req) => family.listMembers(uid(req))));
  r.get('/members/:memberId/access', idParam('memberId'), wrap((req) => family.memberAccess(uid(req), req.params['memberId'] as string)));
  r.get('/members/:memberId/devices', idParam('memberId'), wrap((req) => devices.listFamily(uid(req), req.params['memberId'] as string)));
  r.patch('/members/:memberId', idParam('memberId'), wrap((req) => family.changeRole(uid(req), req.params['memberId'] as string, parseBody(roleSchema, req).role, clientInfo(req))));
  r.put('/members/:memberId/permissions', idParam('memberId'), wrap((req) => family.setPermissions(uid(req), req.params['memberId'] as string, parseBody(permissionsSchema, req), clientInfo(req))));
  r.delete('/members/:memberId', idParam('memberId'), wrap((req) => family.removeMember(uid(req), req.params['memberId'] as string, clientInfo(req))));

  // Family Dashboard (Stage 2): READ-ONLY statistics computed from synchronised data, each section gated by the member's sharing choices
  r.get('/dashboard', wrap((req) => dashboard.overview(uid(req), req.query)));
  r.get('/members/:memberId/dashboard', idParam('memberId'), wrap((req) => dashboard.member(uid(req), req.params['memberId'] as string, req.query)));
  r.get('/members/:memberId/history', idParam('memberId'), wrap((req) => dashboard.history(uid(req), req.params['memberId'] as string, req.query)));
  r.get('/members/:memberId/reports/:kind', idParam('memberId'), validateParam('kind', /^(daily|weekly|monthly)$/), wrap((req) => dashboard.report(uid(req), req.params['memberId'] as string, req.params['kind'] as string, req.query)));

  // Digital Wellbeing (Stage 3): rules are the member's own; others can only propose (the member answers); computers fetch only the caller's ACTIVE rules
  r.get('/wellbeing/my-rules', wrap((req) => wellbeing.myRules(uid(req))));
  r.get('/wellbeing/rules', wrap((req) => wellbeing.list(uid(req))));
  r.post('/wellbeing/rules', wrap((req) => wellbeing.create(uid(req), null, parseBody(ruleBody, req), clientInfo(req)), 201));
  r.get('/members/:memberId/wellbeing/rules', idParam('memberId'), wrap((req) => wellbeing.list(uid(req), req.params['memberId'] as string)));
  r.post('/members/:memberId/wellbeing/rules', idParam('memberId'), wrap((req) => wellbeing.create(uid(req), req.params['memberId'] as string, parseBody(ruleBody, req), clientInfo(req)), 201));
  r.get('/members/:memberId/wellbeing/report', idParam('memberId'), wrap((req) => wellbeing.report(uid(req), req.params['memberId'] as string, req.query)));
  r.put('/wellbeing/rules/:ruleId', idParam('ruleId'), wrap((req) => wellbeing.update(uid(req), req.params['ruleId'] as string, parseBody(ruleUpdate, req).config, clientInfo(req))));
  r.post('/wellbeing/rules/:ruleId/answer', idParam('ruleId'), wrap((req) => wellbeing.respond(uid(req), req.params['ruleId'] as string, parseBody(answerSchema, req).accept, clientInfo(req))));
  r.delete('/wellbeing/rules/:ruleId', idParam('ruleId'), wrap((req) => wellbeing.remove(uid(req), req.params['ruleId'] as string, clientInfo(req))));

  // my own sharing choices and my own devices
  r.get('/me/sharing', wrap((req) => family.getMySharing(uid(req))));
  r.put('/me/sharing', wrap((req) => family.setMySharing(uid(req), parseBody(sharingSchema, req) as Record<string, boolean>, clientInfo(req))));
  r.get('/me/devices', wrap((req) => devices.listMine(uid(req))));

  // invitations (static paths first)
  r.get('/invitations', wrap((req) => invitations.list(uid(req), statusQuery(req))));
  r.post('/invitations', invite, wrap((req) => invitations.create(uid(req), parseBody(inviteSchema, req), clientInfo(req)), 201));
  r.get('/invitations/received', wrap((req) => invitations.received(uid(req), statusQuery(req))));
  r.post('/invitations/accept-code', invite, wrap((req) => invitations.acceptCode(uid(req), parseBody(codeSchema, req).code, clientInfo(req))));
  r.post('/invitations/decline-code', invite, wrap((req) => invitations.declineCode(uid(req), parseBody(codeSchema, req).code, clientInfo(req))));
  r.post('/invitations/:id/accept', idParam('id'), wrap((req) => invitations.accept(uid(req), req.params['id'] as string, clientInfo(req))));
  r.post('/invitations/:id/decline', idParam('id'), wrap((req) => invitations.decline(uid(req), req.params['id'] as string, clientInfo(req))));
  r.post('/invitations/:id/revoke', idParam('id'), wrap((req) => invitations.revoke(uid(req), req.params['id'] as string, clientInfo(req))));
  r.post('/invitations/:id/resend', invite, idParam('id'), wrap((req) => invitations.resend(uid(req), req.params['id'] as string, clientInfo(req))));

  // family devices and hand-overs
  r.get('/devices', wrap((req) => devices.listFamily(uid(req))));
  r.put('/devices/:deviceId/link', idParam('deviceId'), wrap((req) => devices.link(uid(req), req.params['deviceId'] as string, clientInfo(req))));
  r.delete('/devices/:deviceId/link', idParam('deviceId'), wrap((req) => devices.unlink(uid(req), req.params['deviceId'] as string, clientInfo(req))));
  r.post('/devices/:deviceId/transfers', idParam('deviceId'), wrap((req) => devices.createTransfer(uid(req), req.params['deviceId'] as string, parseBody(transferSchema, req).toMemberId, clientInfo(req)), 201));
  r.get('/transfers', wrap((req) => devices.listTransfers(uid(req))));
  r.post('/transfers/:id/accept', idParam('id'), wrap((req) => devices.acceptTransfer(uid(req), req.params['id'] as string, clientInfo(req))));
  r.post('/transfers/:id/decline', idParam('id'), wrap((req) => devices.declineTransfer(uid(req), req.params['id'] as string, clientInfo(req))));
  r.post('/transfers/:id/cancel', idParam('id'), wrap((req) => devices.cancelTransfer(uid(req), req.params['id'] as string, clientInfo(req))));

  // history of sensitive operations
  r.get('/audit', wrap((req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.coerce.number().int().min(1).optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('validation_failed', 'The query is not valid.');
    return family.listAudit(uid(req), q.data.limit, q.data.before);
  }));
  return r;
}
