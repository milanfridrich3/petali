
import { z } from 'zod';

// All configuration comes from environment variables and is validated once, at start-up. A bad or missing
// value stops the process with a clear message instead of running half-configured. Nothing secret has a default.
const PLACEHOLDER_SECRETS = ['change-me', 'changeme', 'secret', 'replace-me', 'your-secret', 'example', 'password'];

const bool = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'boolean') return v;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
  ctx.addIssue({ code: 'custom', message: 'must be true or false' });
  return z.NEVER;
});

const int = (min: number, max: number, def: number) => z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).optional(),
  PORT: int(0, 65535, 8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Behind a reverse proxy: the number of proxies to trust for X-Forwarded-For (0 = none, the default).
  TRUST_PROXY: int(0, 10, 0),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool.default(false),
  DB_POOL_MAX: int(1, 100, 10),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (use: openssl rand -base64 48)'),
  JWT_ISSUER: z.string().min(1).default('petali-cloud'),
  JWT_AUDIENCE: z.string().min(1).default('petali-desktop'),
  ACCESS_TOKEN_TTL_SECONDS: int(60, 3600, 900),
  REFRESH_IDLE_DAYS: int(1, 365, 30),      // a session that is not used for this long expires
  SESSION_MAX_DAYS: int(1, 730, 180),      // a session can never live longer than this, however often it is used

  ARGON2_MEMORY_KIB: int(1024, 1048576, 19456),
  ARGON2_TIME_COST: int(1, 20, 2),
  ARGON2_PARALLELISM: int(1, 16, 1),

  RATE_LIMIT_REGISTER_MAX: int(1, 100000, 10),     // per IP per hour
  RATE_LIMIT_LOGIN_MAX: int(1, 100000, 20),        // per IP per 15 minutes
  RATE_LIMIT_REFRESH_MAX: int(1, 100000, 60),      // per IP per 15 minutes
  RATE_LIMIT_SENSITIVE_MAX: int(1, 100000, 10),    // password / email / deletion, per IP per 15 minutes
  RATE_LIMIT_GENERAL_MAX: int(1, 1000000, 600),    // everything else, per IP per minute
  LOGIN_LOCK_THRESHOLD: int(1, 100, 5),
  RATE_LIMIT_SYNC_MAX: int(1, 1000000, 300),       // sync requests, per IP per 15 minutes
  RATE_LIMIT_DEVICES_MAX: int(1, 1000000, 120),    // device management requests (list, detail, rename, summary), per IP per 15 minutes
  RATE_LIMIT_DEVICE_REMOVE_MAX: int(1, 100000, 20), // device removal, per IP per 15 minutes
  SYNC_USER_QUOTA_MB: int(1, 10000, 100),          // cloud storage one account may use for synchronised documents
  SYNC_MAX_OPS_PER_PUSH: int(1, 500, 50),            // failures in a row before the account/email is paused

  // Petali ID web app / PWA (1.5.0 Phase 5). The browser talks to this API through the same-origin proxy of the website (see PETALI-WEB.md),
  // so the refresh token can live in a first-party HttpOnly cookie. All values are optional; the defaults match the production site.
  WEB_ALLOWED_ORIGINS: z.string().default('https://petali.netlify.app'),   // comma-separated origins allowed to use the cookie session endpoints
  WEB_COOKIE_PATH: z.string().regex(/^\/[A-Za-z0-9/_.-]*$/, 'must be an absolute URL path').default('/id/api/v1/web/session'),   // the path the BROWSER sees (behind the proxy)
  WEB_COOKIE_SECURE: bool.optional(),                                       // default: true in production, false otherwise
  RATE_LIMIT_WEB_MAX: int(1, 1000000, 300),                                 // web read endpoints (overview, health, performance, reports), per IP per 15 minutes

  // Email (1.5.0 Phase 6): verification emails. NOTHING here has a default that sends mail: with EMAIL_PROVIDER unset ("none") no email is sent and the
  // API says so honestly (it never reports a delivery that did not happen). The API key lives only in the server environment, never in the browser.
  EMAIL_PROVIDER: z.enum(['none', 'resend']).default('none'),
  EMAIL_API_KEY: z.string().min(8).max(500).optional(),
  EMAIL_API_URL: z.string().default('https://api.resend.com'),              // overridable so integration tests can point at a local stand-in
  EMAIL_FROM: z.string().min(3).max(200).optional(),                        // sender identity, e.g. "Petali <no-reply@your-verified-domain>"
  EMAIL_REPLY_TO: z.string().min(3).max(200).optional(),
  EMAIL_TIMEOUT_MS: int(1000, 30000, 8000),
  EMAIL_VERIFY_BASE_URL: z.string().optional(),                             // origin of the Petali ID site used in links; default: the first WEB_ALLOWED_ORIGINS entry
  EMAIL_VERIFY_TTL_HOURS: int(1, 168, 24),
  // Accounts created at or after this instant must verify their email before using sync, computers and the web views. Accounts created BEFORE it
  // are never locked out. Unset = nothing is enforced yet (emails are still sent and verification works). Set it at deploy time, with approval.
  EMAIL_VERIFICATION_ENFORCE_FROM: z.string().optional(),

  // Continue with Google (1.5.0 Phase 7). Everything is optional: with no client id the feature reports itself as "not configured" and nothing else changes.
  // Two OAuth clients exist at Google: a "Web application" client (the website's Petali ID, the backend is the confidential client) and a "Desktop app"
  // client (the Windows app, loopback redirect). The secrets live ONLY in the server environment; no secret is ever sent to a browser or to the app.
  GOOGLE_WEB_CLIENT_ID: z.string().min(10).max(300).optional(),
  GOOGLE_WEB_CLIENT_SECRET: z.string().min(8).max(300).optional(),
  GOOGLE_WEB_REDIRECT_URI: z.string().optional(),                              // e.g. https://petali.netlify.app/id/api/v1/web/google/callback (must be registered at Google)
  GOOGLE_DESKTOP_CLIENT_ID: z.string().min(10).max(300).optional(),
  GOOGLE_DESKTOP_CLIENT_SECRET: z.string().min(8).max(300).optional(),
  GOOGLE_COOKIE_PATH: z.string().regex(/^\/[A-Za-z0-9/_.-]*$/, 'must be an absolute URL path').optional(),   // path of the short-lived sign-in cookie as the BROWSER sees it; default: next to the session path
  // Google endpoints. Overridable ONLY outside production so integration tests can point at a local stand-in; production always uses Google's own.
  GOOGLE_AUTH_URL: z.string().optional(),
  GOOGLE_TOKEN_URL: z.string().optional(),
  GOOGLE_JWKS_URL: z.string().optional(),
  GOOGLE_ISSUERS: z.string().optional(),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  trustProxy: number;
  databaseUrl: string;
  databaseSsl: boolean;
  dbPoolMax: number;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSeconds: number;
  refreshIdleDays: number;
  sessionMaxDays: number;
  argon2: { memoryCost: number; timeCost: number; parallelism: number };
  rateLimit: { register: number; login: number; refresh: number; sensitive: number; general: number; sync: number; devices: number; deviceRemove: number };
  sync: { userQuotaBytes: number; maxOpsPerPush: number };
  loginLockThreshold: number;
  web: { allowedOrigins: string[]; cookiePath: string; cookieSecure: boolean; cookieName: string; rateLimit: number };
  google: { web: { clientId: string; clientSecret: string; redirectUri: string } | null; desktop: { clientId: string; clientSecret: string } | null; cookiePath: string; authUrl: string; tokenUrl: string; jwksUrl: string; issuers: string[] };
  email: { provider: 'none' | 'resend'; apiKey: string | null; apiUrl: string; from: string | null; replyTo: string | null; timeoutMs: number; verifyBaseUrl: string; verifyTtlMs: number; enforceFrom: number | null };
};

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }

  const e = parsed.data;

  if (PLACEHOLDER_SECRETS.some((p) => e.JWT_ACCESS_SECRET.toLowerCase().includes(p))) {
    throw new ConfigError('Invalid configuration:\n  - JWT_ACCESS_SECRET: looks like a placeholder; generate a real random secret');
  }

  if (e.NODE_ENV === 'production') {
    // The password hashing cost may only be lowered outside production (the tests do, to stay fast).
    if (e.ARGON2_MEMORY_KIB < 19456 || e.ARGON2_TIME_COST < 2) {
      throw new ConfigError('Invalid configuration:\n  - ARGON2_*: production requires at least 19456 KiB memory and time cost 2 (OWASP minimum for argon2id)');
    }

    if (new Set(e.JWT_ACCESS_SECRET).size < 10) {
      throw new ConfigError('Invalid configuration:\n  - JWT_ACCESS_SECRET: too little variety; generate a real random secret');
    }
  }

  const origins = e.WEB_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  for (const o of origins) {
    let u: URL | null = null;
    try { u = new URL(o); } catch { /* reported below */ }
    if (!u || !/^https?:$/.test(u.protocol) || u.origin !== o) throw new ConfigError(`Invalid configuration:\n  - WEB_ALLOWED_ORIGINS: "${o}" is not an origin (expected e.g. https://petali.netlify.app, no path and no trailing slash)`);
  }
  const cookieSecure = e.WEB_COOKIE_SECURE ?? e.NODE_ENV === 'production';
  if (e.NODE_ENV === 'production' && !cookieSecure) throw new ConfigError('Invalid configuration:\n  - WEB_COOKIE_SECURE: production requires Secure cookies');

  if (e.EMAIL_PROVIDER !== 'none') {
    if (!e.EMAIL_API_KEY) throw new ConfigError('Invalid configuration:\n  - EMAIL_API_KEY: required when EMAIL_PROVIDER is set');
    if (!e.EMAIL_FROM) throw new ConfigError('Invalid configuration:\n  - EMAIL_FROM: required when EMAIL_PROVIDER is set (a sender on a domain verified with the provider)');
  }
  let enforceFrom: number | null = null;
  if (e.EMAIL_VERIFICATION_ENFORCE_FROM) {
    enforceFrom = Date.parse(e.EMAIL_VERIFICATION_ENFORCE_FROM);
    if (!Number.isFinite(enforceFrom)) throw new ConfigError('Invalid configuration:\n  - EMAIL_VERIFICATION_ENFORCE_FROM: must be an ISO date-time, e.g. 2026-12-01T00:00:00Z');
  }
  const verifyBase = (e.EMAIL_VERIFY_BASE_URL ?? origins[0] ?? '').trim();
  if (e.EMAIL_VERIFY_BASE_URL) {
    let u: URL | null = null;
    try { u = new URL(verifyBase); } catch { /* reported below */ }
    if (!u || !/^https?:$/.test(u.protocol) || u.origin !== verifyBase) throw new ConfigError('Invalid configuration:\n  - EMAIL_VERIFY_BASE_URL: must be an origin (no path, no trailing slash)');
  }
  if (e.NODE_ENV === 'production' && e.EMAIL_PROVIDER !== 'none' && !/^https:\/\//.test(verifyBase)) throw new ConfigError('Invalid configuration:\n  - EMAIL_VERIFY_BASE_URL: production links must be https');

  const GOOGLE_DEFAULTS = { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'] };
  const overridden = !!(e.GOOGLE_AUTH_URL || e.GOOGLE_TOKEN_URL || e.GOOGLE_JWKS_URL || e.GOOGLE_ISSUERS);
  if (overridden && e.NODE_ENV === 'production') throw new ConfigError('Invalid configuration:\n  - GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_JWKS_URL / GOOGLE_ISSUERS: may only be set outside production (production always uses Google\'s own endpoints)');
  if ((e.GOOGLE_WEB_CLIENT_ID !== undefined) !== (e.GOOGLE_WEB_CLIENT_SECRET !== undefined)) throw new ConfigError('Invalid configuration:\n  - GOOGLE_WEB_CLIENT_ID and GOOGLE_WEB_CLIENT_SECRET must be set together');
  if ((e.GOOGLE_DESKTOP_CLIENT_ID !== undefined) !== (e.GOOGLE_DESKTOP_CLIENT_SECRET !== undefined)) throw new ConfigError('Invalid configuration:\n  - GOOGLE_DESKTOP_CLIENT_ID and GOOGLE_DESKTOP_CLIENT_SECRET must be set together');
  let webGoogle: Config['google']['web'] = null;
  if (e.GOOGLE_WEB_CLIENT_ID && e.GOOGLE_WEB_CLIENT_SECRET) {
    let ru: URL | null = null;
    try { ru = e.GOOGLE_WEB_REDIRECT_URI ? new URL(e.GOOGLE_WEB_REDIRECT_URI) : null; } catch { /* reported below */ }
    if (!ru || ru.search || ru.hash || ru.username || ru.password) throw new ConfigError('Invalid configuration:\n  - GOOGLE_WEB_REDIRECT_URI: required with the web client; an absolute URL without query or fragment (the exact "Authorized redirect URI" registered at Google)');
    if (e.NODE_ENV === 'production' && ru.protocol !== 'https:') throw new ConfigError('Invalid configuration:\n  - GOOGLE_WEB_REDIRECT_URI: production requires https');
    if (ru.protocol !== 'https:' && !(ru.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(ru.hostname))) throw new ConfigError('Invalid configuration:\n  - GOOGLE_WEB_REDIRECT_URI: must be https (http is allowed for localhost only)');
    webGoogle = { clientId: e.GOOGLE_WEB_CLIENT_ID, clientSecret: e.GOOGLE_WEB_CLIENT_SECRET, redirectUri: ru.toString() };
  }
  const google: Config['google'] = {
    web: webGoogle,
    desktop: e.GOOGLE_DESKTOP_CLIENT_ID && e.GOOGLE_DESKTOP_CLIENT_SECRET ? { clientId: e.GOOGLE_DESKTOP_CLIENT_ID, clientSecret: e.GOOGLE_DESKTOP_CLIENT_SECRET } : null,
    cookiePath: e.GOOGLE_COOKIE_PATH ?? e.WEB_COOKIE_PATH.replace(/\/session\/?$/, '') + '/google',
    authUrl: e.GOOGLE_AUTH_URL ?? GOOGLE_DEFAULTS.authUrl,
    tokenUrl: e.GOOGLE_TOKEN_URL ?? GOOGLE_DEFAULTS.tokenUrl,
    jwksUrl: e.GOOGLE_JWKS_URL ?? GOOGLE_DEFAULTS.jwksUrl,
    issuers: e.GOOGLE_ISSUERS ? e.GOOGLE_ISSUERS.split(',').map((x) => x.trim()).filter(Boolean) : GOOGLE_DEFAULTS.issuers,
  };

  return {
    env: e.NODE_ENV,
    host: e.HOST ?? (e.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    dbPoolMax: e.DB_POOL_MAX,
    jwtSecret: e.JWT_ACCESS_SECRET,
    jwtIssuer: e.JWT_ISSUER,
    jwtAudience: e.JWT_AUDIENCE,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshIdleDays: e.REFRESH_IDLE_DAYS,
    sessionMaxDays: e.SESSION_MAX_DAYS,
    argon2: {
      memoryCost: e.ARGON2_MEMORY_KIB,
      timeCost: e.ARGON2_TIME_COST,
      parallelism: e.ARGON2_PARALLELISM,
    },
    rateLimit: {
      register: e.RATE_LIMIT_REGISTER_MAX,
      login: e.RATE_LIMIT_LOGIN_MAX,
      refresh: e.RATE_LIMIT_REFRESH_MAX,
      sensitive: e.RATE_LIMIT_SENSITIVE_MAX,
      general: e.RATE_LIMIT_GENERAL_MAX,
      sync: e.RATE_LIMIT_SYNC_MAX,
      devices: e.RATE_LIMIT_DEVICES_MAX,
      deviceRemove: e.RATE_LIMIT_DEVICE_REMOVE_MAX,
    },
    sync: {
      userQuotaBytes: e.SYNC_USER_QUOTA_MB * 1024 * 1024,
      maxOpsPerPush: e.SYNC_MAX_OPS_PER_PUSH,
    },
    loginLockThreshold: e.LOGIN_LOCK_THRESHOLD,
    web: { allowedOrigins: origins, cookiePath: e.WEB_COOKIE_PATH, cookieSecure, cookieName: cookieSecure ? '__Secure-petali_rt' : 'petali_rt', rateLimit: e.RATE_LIMIT_WEB_MAX },
    google,
    email: { provider: e.EMAIL_PROVIDER, apiKey: e.EMAIL_API_KEY ?? null, apiUrl: e.EMAIL_API_URL.replace(/\/+$/, ''), from: e.EMAIL_FROM ?? null, replyTo: e.EMAIL_REPLY_TO ?? null, timeoutMs: e.EMAIL_TIMEOUT_MS, verifyBaseUrl: verifyBase, verifyTtlMs: e.EMAIL_VERIFY_TTL_HOURS * 3_600_000, enforceFrom },
  };
}
