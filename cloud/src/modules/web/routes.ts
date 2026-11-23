import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { clientInfo, limiter, requireAuth } from '../../http/middleware';
import { parseBody, validateParam } from '../../http/validate';
import { AppError, badRequest, forbidden, unauthorized } from '../../lib/errors';
import { loginPasswordField, newPasswordField } from '../auth/passwords';
import { displayNameField, emailField, registrationVerification } from '../auth/routes';
import type { VerificationService } from '../auth/verification';
import type { AuthResult, AuthService } from '../auth/service';
import type { WebService } from './service';
import { SignJWT, jwtVerify } from 'jose';
import { CHALLENGE_RE, STATE_RE, challengeFor, newOauthValue, safeEqual, type GoogleAuth, type GoogleOidc } from '../auth/google';

// Petali ID web app (1.5.0 Phase 5).
//
// SESSION. The browser never sees the refresh token: it lives in a first-party HttpOnly cookie (SameSite=Strict, Secure in production, Path scoped to
// the session endpoints) and is only ever sent to /v1/web/session/*. The browser gets the short-lived ACCESS token in the response body and keeps it in
// memory (never in storage). Everything else is the existing Bearer API (/v1/account, /v1/devices) plus the read-only /v1/web views below.
// This is additive: the desktop endpoints (/v1/auth/*) and their behaviour are untouched; these routes call the very same auth service
// (same sessions table, same rotation + reuse detection, same revocation).
//
// CSRF. Cookie endpoints require (1) the custom header X-Petali-Web: 1 (a cross-site form cannot send it) and (2) an Origin header that is on the
// WEB_ALLOWED_ORIGINS list, on top of SameSite=Strict. The read views use the Bearer token, which a cross-site request cannot attach.
// There is deliberately NO CORS: the site reaches this API through its own same-origin proxy (see PETALI-WEB.md).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEB_LABEL = 'Petali Web';
const registerSchema = z.strictObject({ email: emailField, password: newPasswordField, displayName: displayNameField.optional() });
const loginSchema = z.strictObject({ email: emailField, password: loginPasswordField });

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { const v = part.slice(i + 1).trim(); return v || null; }
  }
  return null;
}

export function webRoutes(auth: AuthService, web: WebService, config: Config, verification: VerificationService, now: () => number = Date.now, google?: { oidc: GoogleOidc; auth: GoogleAuth }): Router {
  const r = Router();
  const c = config.web;
  const cookieAttrs = `Path=${c.cookiePath}; HttpOnly; SameSite=Strict${c.cookieSecure ? '; Secure' : ''}`;
  const setSession = (res: Response, refreshToken: string, expiresAt: string) => {
    const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - now()) / 1000));
    res.append('Set-Cookie', `${c.cookieName}=${refreshToken}; Max-Age=${maxAge}; ${cookieAttrs}`);
  };
  const clearSession = (res: Response) => { res.append('Set-Cookie', `${c.cookieName}=; Max-Age=0; ${cookieAttrs}`); };
  // What the browser may see of a sign-in: the user and the ACCESS token. Never the refresh token.
  const publicResult = (a: AuthResult) => ({ user: a.user, accessToken: a.tokens.accessToken, accessTokenExpiresAt: a.tokens.accessTokenExpiresAt, sessionExpiresAt: a.tokens.refreshTokenExpiresAt, sessionId: a.tokens.sessionId });

  const guard: RequestHandler = (req, _res, next) => {
    if (req.headers['x-petali-web'] !== '1') return next(forbidden('web_header_required', 'This request is only available to the Petali web app.'));
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !c.allowedOrigins.includes(origin)) return next(forbidden('origin_not_allowed', 'This origin may not use the Petali web session.'));
    next();
  };

  const s = Router();
  const HOUR = 3_600_000; const QUARTER = 900_000;
  s.use(guard);
  s.post('/register', limiter(config.rateLimit.register, HOUR), async (req, res, next) => {
    try { const b = parseBody(registerSchema, req, { moderate: ['displayName'] }); const a = await auth.register({ ...b, deviceLabel: WEB_LABEL }, clientInfo(req)); setSession(res, a.tokens.refreshToken, a.tokens.refreshTokenExpiresAt); res.status(201).json({ ...publicResult(a), emailVerification: await registrationVerification(verification, a.user.petaliId) }); } catch (e) { next(e); }
  });
  s.post('/login', limiter(config.rateLimit.login, QUARTER), async (req, res, next) => {
    try { const b = parseBody(loginSchema, req); const a = await auth.login({ ...b, deviceLabel: WEB_LABEL }, clientInfo(req)); setSession(res, a.tokens.refreshToken, a.tokens.refreshTokenExpiresAt); res.json(publicResult(a)); } catch (e) { next(e); }
  });
  // Restores the session on every visit and renews the access token. The cookie rotates on every call (the existing rotation + reuse detection).
  // A failure that means "this session is over" (401) clears the cookie; a server error leaves it alone so a cold start never signs anyone out.
  s.post('/refresh', limiter(config.rateLimit.refresh, QUARTER), async (req, res, next) => {
    try {
      parseBody(z.strictObject({}), req);
      const token = readCookie(req.headers.cookie, c.cookieName);
      if (!token) throw unauthorized('no_session', 'Not signed in.');
      try {
        const a = await auth.refresh(token, clientInfo(req));
        setSession(res, a.tokens.refreshToken, a.tokens.refreshTokenExpiresAt);
        res.json(publicResult(a));
      } catch (err) { if (err instanceof AppError && err.status === 401) clearSession(res); throw err; }
    } catch (e) { next(e); }
  });
  s.post('/logout', limiter(config.rateLimit.refresh, QUARTER), async (req, res, next) => {
    try {
      parseBody(z.strictObject({}), req);
      const token = readCookie(req.headers.cookie, c.cookieName);
      if (token) await auth.logoutByRefreshToken(token, clientInfo(req));
      clearSession(res);
      res.status(204).end();
    } catch (e) { next(e); }
  });
  r.use('/session', s);

  // ---- Continue with Google (Phase 7) ----------------------------------------------------------------------------------------------------------
  // start (POST, same guard as the session): makes state + nonce + a PKCE verifier, keeps them in a short-lived signed HttpOnly cookie that only THIS browser
  // holds (SameSite=Lax: Google sends the browser back with a top-level navigation, which a Strict cookie would not survive), and returns the Google URL.
  // callback (GET, from Google): checks the cookie and the state, exchanges the code on the server, signs the account in with the very same session
  // cookie the password login sets, and sends the browser back to the app. Failures go back to the login page with ?google=<reason>.
  const gKey = new TextEncoder().encode(config.jwtSecret);
  const gCookie = config.web.cookieSecure ? '__Secure-petali_gtx' : 'petali_gtx';
  const gAttrs = `Path=${config.google.cookiePath}; HttpOnly; SameSite=Lax${c.cookieSecure ? '; Secure' : ''}`;
  const safeNext = (n: unknown): string => (typeof n === 'string' && /^\/id\/[A-Za-z0-9\-._~/?=&%]{0,200}$/.test(n) && !n.includes('//') && !n.includes('..') ? n : '/id/');
  const g = Router();
  g.post('/start', guard, limiter(config.rateLimit.login, QUARTER), async (req, res, next) => {
    try {
      if (!google || !config.google.web) throw new AppError(503, 'google_not_configured', 'Google sign-in is not set up on this server yet.');
      const b = parseBody(z.strictObject({ next: z.string().max(240).optional() }), req);
      const state = newOauthValue(); const nonce = newOauthValue(); const verifier = newOauthValue();
      const tx = await new SignJWT({ s: state, n: nonce, v: verifier, r: safeNext(b.next) }).setProtectedHeader({ alg: 'HS256' }).setAudience('petali-google-tx').setIssuedAt(Math.floor(now() / 1000)).setExpirationTime(Math.floor(now() / 1000) + 600).sign(gKey);
      res.append('Set-Cookie', `${gCookie}=${tx}; Max-Age=600; ${gAttrs}`);
      res.json({ authUrl: google.oidc.authorizationUrl('web', { redirectUri: config.google.web.redirectUri, state, nonce, codeChallenge: challengeFor(verifier) }) });
    } catch (e) { next(e); }
  });
  g.get('/callback', limiter(config.rateLimit.login, QUARTER), async (req, res) => {
    const clearTx = () => res.append('Set-Cookie', `${gCookie}=; Max-Age=0; ${gAttrs}`);
    const back = (reason: string) => { clearTx(); res.setHeader('Cache-Control', 'no-store'); res.redirect(302, `/id/login?google=${reason}`); };
    try {
      if (!google || !config.google.web) return back('not_configured');
      const raw = readCookie(req.headers.cookie, gCookie);
      if (!raw) return back('expired');
      let tx: { s: string; n: string; v: string; r: string };
      try { const { payload } = await jwtVerify(raw, gKey, { audience: 'petali-google-tx', algorithms: ['HS256'], currentDate: new Date(now()) }); tx = payload as unknown as typeof tx; } catch { return back('expired'); }
      const q = req.query; const state = typeof q['state'] === 'string' ? q['state'] : '';
      if (!STATE_RE.test(state) || !safeEqual(state, tx.s)) return back('invalid');
      if (typeof q['error'] === 'string') return back(q['error'] === 'access_denied' ? 'cancelled' : 'failed');
      const code = typeof q['code'] === 'string' ? q['code'] : '';
      if (!code) return back('invalid');
      const identity = await google.oidc.identityFromCode('web', { code, codeVerifier: tx.v, redirectUri: config.google.web.redirectUri, nonce: tx.n });
      const a = await google.auth.signIn(identity, clientInfo(req), WEB_LABEL);
      clearTx(); setSession(res, a.tokens.refreshToken, a.tokens.refreshTokenExpiresAt);
      res.setHeader('Cache-Control', 'no-store'); res.redirect(302, tx.r);
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'failed';
      back(({ account_needs_verification: 'needs_verification', google_account_mismatch: 'mismatch', google_unreachable: 'unavailable', google_email_not_verified: 'email_unverified', google_code_invalid: 'invalid', google_response_invalid: 'invalid', google_token_invalid: 'invalid' } as Record<string, string>)[code] ?? 'failed');
    }
  });
  r.use('/google', g);

  // ---- read-only views (Bearer) ----------------------------------------------------------------------------------
  const reads = Router();
  reads.use(limiter(c.rateLimit, QUARTER));
  reads.use(requireAuth(auth));
  // The theme schedule is not account data that needs a verified email: it is read before the gate so even a brand-new account gets the right look.
  reads.get('/appearance', async (req, res, next) => { try { res.json(await web.appearance((req.auth as { userId: string }).userId)); } catch (e) { next(e); } });
  reads.use(verification.gate);
  const uid = (req: { auth?: { userId: string } }) => (req.auth as { userId: string }).userId;
  const idParam = validateParam('id', UUID_RE);
  const days = z.coerce.number().int().min(1).max(365).default(30);
  const q = <T extends z.ZodType>(schema: T, query: unknown): z.output<T> => { const p = schema.safeParse(query); if (!p.success) throw badRequest('validation_failed', 'The query is not valid.', { fields: p.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }); return p.data; };

  reads.get('/overview', async (req, res, next) => { try { res.json(await web.overview(uid(req))); } catch (e) { next(e); } });
  reads.get('/plant', async (req, res, next) => { try { res.json(await web.plant(uid(req))); } catch (e) { next(e); } });
  reads.get('/devices/:id/health', idParam, async (req, res, next) => { try { res.json(await web.health(uid(req), req.params['id'] as string, q(z.object({ days }), req.query).days)); } catch (e) { next(e); } });
  reads.get('/devices/:id/performance', idParam, async (req, res, next) => { try { res.json(await web.performance(uid(req), req.params['id'] as string, q(z.object({ days }), req.query).days)); } catch (e) { next(e); } });
  reads.get('/devices/:id/report', idParam, async (req, res, next) => {
    try { const v = q(z.object({ kind: z.enum(['daily', 'weekly', 'monthly']), key: z.string().max(10).optional() }), req.query); res.json(await web.report(uid(req), req.params['id'] as string, v.kind, v.key)); } catch (e) { next(e); }
  });
  r.use(reads);
  return r;
}
