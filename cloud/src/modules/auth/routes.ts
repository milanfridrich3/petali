import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { clientInfo, limiter, requireAuth } from '../../http/middleware';
import { parseBody } from '../../http/validate';
import { badRequest } from '../../lib/errors';
import { loginPasswordField, newPasswordField } from './passwords';
import type { AuthService } from './service';
import type { VerificationService } from './verification';
import { CHALLENGE_RE, DESKTOP_REDIRECT_RE, STATE_RE, VERIFIER_RE, type GoogleAuth, type GoogleOidc } from './google';

// Every schema is strict(): unknown properties are rejected.
const emailField = z.string().trim().min(3).max(254).pipe(z.email('Enter a valid email address.'));
const noControlChars = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const deviceLabel = z.string().trim().min(1).max(80).refine(noControlChars, 'Invalid characters.');
export const displayNameField = z.string().trim().min(1, 'Required').max(50).refine(noControlChars, 'Invalid characters.');

const registerSchema = z.strictObject({ email: emailField, password: newPasswordField, displayName: displayNameField.optional(), deviceLabel: deviceLabel.optional() });
const loginSchema = z.strictObject({ email: emailField, password: loginPasswordField, deviceLabel: deviceLabel.optional() });
const refreshSchema = z.strictObject({ refreshToken: z.string().min(10).max(200), nextRefreshToken: z.string().min(10).max(200).optional() });
const logoutSchema = z.strictObject({ refreshToken: z.string().min(1).max(200).optional() });

const verifySchema = z.strictObject({ token: z.string().min(20).max(2000) });

// What the register response tells the client about the verification email: only ever what really happened.
export async function registrationVerification(verification: VerificationService, petaliId: string): Promise<{ sent: boolean; required: boolean; reason?: string }> {
  const u = await verification.userRowByPetaliId(petaliId);
  if (!u) return { sent: false, required: false, reason: 'delivery_failed' };
  const s = await verification.sendFor(u);
  return { sent: s.sent, required: verification.enforced(u.created_at), ...(s.reason ? { reason: s.reason } : {}) };
}

export { emailField };

const googleStartSchema = z.strictObject({ redirectUri: z.string().regex(DESKTOP_REDIRECT_RE), state: z.string().regex(STATE_RE), nonce: z.string().regex(STATE_RE), codeChallenge: z.string().regex(CHALLENGE_RE) });
const googleExchangeSchema = z.strictObject({ code: z.string().min(10).max(2048), codeVerifier: z.string().regex(VERIFIER_RE), redirectUri: z.string().regex(DESKTOP_REDIRECT_RE), nonce: z.string().regex(STATE_RE), deviceLabel: deviceLabel.optional() });

export function authRoutes(auth: AuthService, config: Config, verification: VerificationService, google?: { oidc: GoogleOidc; auth: GoogleAuth }): Router {
  const r = Router();
  const HOUR = 3_600_000; const QUARTER = 900_000;

  r.post('/register', limiter(config.rateLimit.register, HOUR), async (req, res, next) => {
    try {
      const body = parseBody(registerSchema, req, { moderate: ['displayName'] });
      const result = await auth.register(body, clientInfo(req));
      res.status(201).json({ ...result, emailVerification: await registrationVerification(verification, result.user.petaliId) });
    } catch (err) { next(err); }
  });

  // Opens the link from the verification email. The token is the credential, so no sign-in is needed (the link is opened in a browser).
  r.post('/verify-email', limiter(config.rateLimit.sensitive, QUARTER), async (req, res, next) => {
    try { const body = parseBody(verifySchema, req); res.json(await verification.verify(body.token)); } catch (err) { next(err); }
  });
  // Sends a fresh verification email to the signed-in account (at most one per minute). Answers 200 only when the provider accepted the message.
  r.post('/resend-verification', limiter(config.rateLimit.sensitive, QUARTER), requireAuth(auth), async (req, res, next) => {
    try { parseBody(z.strictObject({}), req); await verification.resend((req.auth as { userId: string }).userId); res.json({ sent: true }); } catch (err) { next(err); }
  });

  r.post('/login', limiter(config.rateLimit.login, QUARTER), async (req, res, next) => {
    try {
      const body = parseBody(loginSchema, req);
      res.json(await auth.login(body, clientInfo(req)));
    } catch (err) { next(err); }
  });

  r.post('/refresh', limiter(config.rateLimit.refresh, QUARTER), async (req, res, next) => {
    try {
      const body = parseBody(refreshSchema, req);
      res.json(await auth.refresh(body.refreshToken, clientInfo(req), body.nextRefreshToken));
    } catch (err) { next(err); }
  });

  // Signs the caller out. With a valid access token the session named in it is ended; without one (it may have
  // expired) the refresh token identifies the session. Either way the answer is the same: 204.
  r.post('/logout', limiter(config.rateLimit.refresh, QUARTER), async (req, res, next) => {
    try {
      const body = parseBody(logoutSchema, req);
      const header = req.headers.authorization;
      let ended = false;
      if (typeof header === 'string' && header.startsWith('Bearer ')) {
        try {
          await new Promise<void>((resolve, reject) => requireAuth(auth)(req, res, (e?: unknown) => (e ? reject(e) : resolve())));
          const a = req.auth;
          if (a) { await auth.logoutSession(a.sessionId, a.userId, clientInfo(req)); ended = true; }
        } catch (err) {
          if (!body.refreshToken) throw err;      // an expired access token is fine when the refresh token says which session to end
        }
      }
      if (!ended) {
        if (body.refreshToken) await auth.logoutByRefreshToken(body.refreshToken, clientInfo(req));
        else if (!header) throw badRequest('validation_failed', 'Send an access token or a refresh token.');
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ---- Continue with Google (Phase 7) ----------------------------------------------------------------------------------------------------------
  // Which providers this server can actually use. Public, no secrets: lets a client say "not set up yet" instead of failing at Google.
  r.get('/providers', (_req, res) => { res.json({ google: google ? google.oidc.available() : { web: false, desktop: false } }); });
  // The Windows app generates state, nonce and the PKCE pair itself (they never leave it except as the challenge), asks for the authorization URL here, opens it
  // in the SYSTEM browser and receives the code on a loopback address. Then it sends the code + verifier to /exchange. Nothing here trusts the client's email.
  r.post('/google/desktop/start', limiter(config.rateLimit.login, QUARTER), (req, res, next) => {
    try {
      if (!google) throw badRequest('google_not_configured', 'Google sign-in is not set up on this server yet.');
      const b = parseBody(googleStartSchema, req);
      res.json({ authUrl: google.oidc.authorizationUrl('desktop', { redirectUri: b.redirectUri, state: b.state, nonce: b.nonce, codeChallenge: b.codeChallenge }) });
    } catch (err) { next(err); }
  });
  r.post('/google/desktop/exchange', limiter(config.rateLimit.login, QUARTER), async (req, res, next) => {
    try {
      if (!google) throw badRequest('google_not_configured', 'Google sign-in is not set up on this server yet.');
      const b = parseBody(googleExchangeSchema, req);
      const identity = await google.oidc.identityFromCode('desktop', { code: b.code, codeVerifier: b.codeVerifier, redirectUri: b.redirectUri, nonce: b.nonce });
      res.json(await google.auth.signIn(identity, clientInfo(req), b.deviceLabel ?? null));
    } catch (err) { next(err); }
  });

  return r;
}
