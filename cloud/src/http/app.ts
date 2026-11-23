import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Pool } from 'pg';
import type { Config } from '../config/env';
import { currentSchemaVersion } from '../db/migrate';
import type { Logger } from '../lib/logger';
import { accountRoutes } from '../modules/account/routes';
import { createAccountService } from '../modules/account/service';
import { createPasswordHasher, type PasswordHasher } from '../modules/auth/passwords';
import { authRoutes } from '../modules/auth/routes';
import { createAuthService } from '../modules/auth/service';
import { createTokenService } from '../modules/auth/tokens';
import { createGoogleAuth, createGoogleOidc } from '../modules/auth/google';
import { createVerificationService } from '../modules/auth/verification';
import { createMailer, type Mailer } from '../lib/mailer';
import { deviceRoutes } from '../modules/devices/routes';
import { createDeviceService } from '../modules/devices/service';
import { syncRoutes } from '../modules/sync/routes';
import { createDashboardService } from '../modules/family/dashboard';
import { createWellbeingService } from '../modules/family/wellbeing';
import { createFamilyDeviceService } from '../modules/family/devices';
import { createInvitationService } from '../modules/family/invitations';
import { familyRoutes } from '../modules/family/routes';
import { createFamilyService } from '../modules/family/service';
import { webRoutes } from '../modules/web/routes';
import { createWebService } from '../modules/web/service';
import { createSyncService } from '../modules/sync/service';
import { apiVersion, errorHandler, limiter, noStore, notFoundHandler, requestId, requestLogger } from './middleware';
import { cors } from './cors';

export const API_VERSION = '1';
export const SERVICE_VERSION = '1.6.0';   // the Petali 1.6.0 backend

export type AppDeps = { fetchImpl?: typeof fetch; config: Config; pool: Pool; log: Logger; hasher?: PasswordHasher; mailer?: Mailer; now?: () => number; generateId?: () => string };

export async function createApp(deps: AppDeps): Promise<Express> {
  const { config, pool, log } = deps;
  const hasher = deps.hasher ?? (await createPasswordHasher(config.argon2));
  const tokens = createTokenService(config, deps.now);
  const auth = createAuthService({ pool, config, hasher, tokens, log, ...(deps.now ? { now: deps.now } : {}), ...(deps.generateId ? { generateId: deps.generateId } : {}) });
  const googleOidc = createGoogleOidc(config, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.now ? { now: deps.now } : {}), log });
  const googleAuth = createGoogleAuth({ pool, auth, hasher, log, ...(deps.now ? { now: deps.now } : {}) });
  const google = { oidc: googleOidc, auth: googleAuth };
  const mailer = deps.mailer ?? createMailer(config.email, log);
  const verification = createVerificationService({ pool, config, mailer, log, ...(deps.now ? { now: deps.now } : {}) });
  const account = createAccountService({ pool, auth, hasher });
  const sync = createSyncService({ pool, config, ...(deps.now ? { now: deps.now } : {}) });
  const devices = createDeviceService({ pool, auth, ...(deps.now ? { now: deps.now } : {}) });
  const web = createWebService({ pool, ...(deps.now ? { now: deps.now } : {}) });
  const family = createFamilyService({ pool, config, ...(deps.now ? { now: deps.now } : {}) });                                   // Petali Family (Stage 1)
  const familyInvitations = createInvitationService({ pool, config, family, mailer, log, ...(deps.now ? { now: deps.now } : {}) });
  const familyDevices = createFamilyDeviceService({ pool, config, family, ...(deps.now ? { now: deps.now } : {}) });
  const familyWellbeing = createWellbeingService({ pool, ...(deps.now ? { now: deps.now } : {}) });                                         // Petali Family (Stage 3): Digital Wellbeing
  const familyDashboard = createDashboardService({ pool, devices: familyDevices, ...(deps.now ? { now: deps.now } : {}) });          // Petali Family (Stage 2): read-only dashboard

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);   // 0 unless the operator says how many proxies sit in front

  app.use(requestId);
  app.use(helmet());
  app.use(cors(config.corsOrigins));
  app.use(requestLogger(log));

  // Liveness: the process is up. Not versioned, no database, nothing about the environment. /health is the public path (Render's health check); /healthz is kept for older monitors.
  const healthLimit = limiter(config.rateLimit.general, 60_000);
  app.get('/health', healthLimit, noStore, (_req, res) => { res.json({ status: 'ok', service: 'petali-cloud', serviceVersion: SERVICE_VERSION }); });
  app.get('/healthz', healthLimit, (_req, res) => { res.json({ status: 'ok' }); });

  const v1 = express.Router();
  v1.use(noStore, apiVersion(API_VERSION), limiter(config.rateLimit.general, 60_000));
  // Sync has its own, larger body limit (documents), so it is mounted before the small default parser of everything else.
  v1.use('/sync', syncRoutes(auth, sync, config, verification));
  v1.use(express.json({ limit: '16kb', strict: true, type: 'application/json' }));
  v1.use('/devices', deviceRoutes(auth, devices, config, verification));
  v1.use('/family', familyRoutes(auth, family, familyInvitations, familyDevices, config, verification, familyDashboard, familyWellbeing));   // Petali Family (Stage 1): families, members, invitations, family devices   // device management (Phase 3): list, detail, rename, remove, per-device summary

  v1.get('/health', (_req, res) => { res.json({ status: 'ok', service: 'petali-cloud', apiVersion: API_VERSION, serviceVersion: SERVICE_VERSION }); });
  // Readiness: the database answers and the schema is migrated.
  v1.get('/ready', async (_req, res, next) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ready', schemaVersion: await currentSchemaVersion(pool) }); } catch (e) { next(e); }
  });
  v1.use('/auth', authRoutes(auth, config, verification, google));
  v1.use('/account', accountRoutes(auth, account, config, verification));
  v1.use('/web', webRoutes(auth, web, config, verification, deps.now, google));   // Petali ID web app / PWA (Phase 5): cookie session + read-only views
  app.use('/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler(log));
  return app;
}
