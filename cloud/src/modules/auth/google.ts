import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import type { Config } from '../../config/env';
import { isUniqueViolation, withTransaction } from '../../db/pool';
import { normalizeEmail } from '../../lib/email';
import { AppError, badRequest, conflict } from '../../lib/errors';
import { generatePetaliId } from '../../lib/petali-id';
import type { Logger } from '../../lib/logger';
import { toUserDto, type UserRow } from '../account/dto';
import type { PasswordHasher } from './passwords';
import type { AuthResult, AuthService, ClientInfo } from './service';

// Continue with Google (1.5.0 Phase 7).
//
// The standard OAuth 2.0 authorization-code flow with PKCE (S256), state and nonce, OpenID Connect for the identity. The BACKEND is the relying party:
//   * the browser (or the Windows app) only ever sees the Google authorization URL and the one-time code Google returns;
//   * the code is exchanged here, with the client secret that never leaves the server;
//   * the ID token is verified here: signature (Google's published keys), issuer, audience, expiry, age, nonce, azp, and email_verified;
//   * the email address is taken from the VERIFIED token, never from anything the client says.
// Accounts are identified by Google's "sub", never by email. See resolveAccount() for the linking rules.
export type GoogleKind = 'web' | 'desktop';
export type GoogleIdentity = { subject: string; email: string; name: string | null };
export type GoogleSignIn = AuthResult & { isNewAccount: boolean; linkedExisting: boolean };

const B64URL = (n: number) => randomBytes(n).toString('base64url');
export const newOauthValue = () => B64URL(32);
export const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export const DESKTOP_REDIRECT_RE = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})\/callback$/;
export const STATE_RE = /^[A-Za-z0-9_-]{22,128}$/;
export const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9._~/+-]{10,2048}$/;
export const safeEqual = (a: string, b: string): boolean => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

const notConfigured = () => new AppError(503, 'google_not_configured', 'Google sign-in is not set up on this server yet.');
const invalidToken = () => new AppError(401, 'google_token_invalid', 'Google sign-in could not be verified. Please try again.');

export type GoogleOidc = ReturnType<typeof createGoogleOidc>;

export function createGoogleOidc(config: Config, deps: { fetchImpl?: typeof fetch; jwks?: JWTVerifyGetKey; now?: () => number; log?: Logger } = {}) {
  const g = config.google;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let jwks: JWTVerifyGetKey | null = deps.jwks ?? null;
  const keys = (): JWTVerifyGetKey => { if (!jwks) jwks = createRemoteJWKSet(new URL(g.jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30_000 }); return jwks; };
  const client = (kind: GoogleKind) => { const c = kind === 'web' ? g.web : g.desktop; if (!c) throw notConfigured(); return c; };

  const available = () => ({ web: !!g.web, desktop: !!g.desktop });

  function authorizationUrl(kind: GoogleKind, p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): string {
    const c = client(kind);
    const u = new URL(g.authUrl);
    for (const [k, v] of Object.entries({ client_id: c.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope: 'openid email profile', state: p.state, nonce: p.nonce, code_challenge: p.codeChallenge, code_challenge_method: 'S256', prompt: 'select_account' })) u.searchParams.set(k, v);
    return u.toString();
  }

  // Exchanges the one-time code and returns the verified identity. Every failure is an AppError with a stable code and a message safe to show.
  async function identityFromCode(kind: GoogleKind, p: { code: string; codeVerifier: string; redirectUri: string; nonce: string }): Promise<GoogleIdentity> {
    const c = client(kind);
    if (!CODE_RE.test(p.code) || !VERIFIER_RE.test(p.codeVerifier)) throw badRequest('google_response_invalid', 'The Google response was not valid. Please try again.');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
    let status = 0; let body: unknown = null;
    try {
      const res = await fetchImpl(g.tokenUrl, {
        method: 'POST', redirect: 'error', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }).toString(),
      });
      status = res.status;
      const text = (await res.text()).slice(0, 100_000);
      try { body = JSON.parse(text); } catch { body = null; }
    } catch {
      throw new AppError(502, 'google_unreachable', 'Google could not be reached. Please try again in a moment.');
    } finally { clearTimeout(timer); }
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (status !== 200) {
      deps.log?.warn({ status, googleError: typeof o['error'] === 'string' ? o['error'] : null }, 'google token exchange refused');
      if (status >= 500) throw new AppError(502, 'google_unreachable', 'Google could not be reached. Please try again in a moment.');
      throw new AppError(400, 'google_code_invalid', 'The Google sign-in expired or was already used. Please start again.');
    }
    const idToken = o['id_token'];
    if (typeof idToken !== 'string' || idToken.length > 8192) throw invalidToken();
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, keys(), { issuer: g.issuers, audience: c.clientId, algorithms: ['RS256'], currentDate: new Date(now()), clockTolerance: 60, maxTokenAge: '10 minutes' }));
    } catch (err) {
      if (err instanceof joseErrors.JWKSTimeout) throw new AppError(502, 'google_unreachable', 'Google could not be reached. Please try again in a moment.');
      deps.log?.warn({ reason: err instanceof Error ? err.name : 'unknown' }, 'google id token rejected');
      throw invalidToken();
    }
    if (typeof payload['nonce'] !== 'string' || !safeEqual(payload['nonce'], p.nonce)) throw invalidToken();
    if (payload['azp'] !== undefined && payload['azp'] !== c.clientId) throw invalidToken();
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length < 1 || sub.length > 255) throw invalidToken();
    const email = payload['email'];
    if (typeof email !== 'string' || email.length < 3 || email.length > 254) throw new AppError(403, 'google_email_missing', 'Your Google account did not share an email address, which Petali ID needs.');
    const verified = payload['email_verified'];
    if (verified !== true && verified !== 'true') throw new AppError(403, 'google_email_not_verified', 'Google says this email address is not verified, so it cannot be used to sign in.');
    const rawName = typeof payload['name'] === 'string' ? payload['name'].replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    return { subject: sub, email: email.trim(), name: rawName ? Array.from(rawName).slice(0, 50).join('') : null };
  }

  return { available, authorizationUrl, identityFromCode, kinds: ['web', 'desktop'] as GoogleKind[] };
}

// ---- Accounts ------------------------------------------------------------------------------------------------------------------------------------
// resolveAccount() is the ONLY place that decides which Petali account a Google identity belongs to:
//   1. the Google "sub" is already linked           -> that account (the email on either side may have changed since; the sub is what counts);
//   2. else an account with the same email exists:
//        - its email is VERIFIED at Petali           -> link the Google identity to it (both sides proved ownership of the address: no duplicate);
//        - its email is NOT verified                 -> REFUSE (409 account_needs_verification). Linking here would let someone who pre-registered a
//                                                       victim's address (with a password they know) take over the victim's Google sign-in. The owner
//                                                       signs in with the password; once email confirmation exists (a later release) they can confirm and then use Google.
//   3. else                                          -> a new account (email verified by Google, no password).
export function createGoogleAuth(deps: { pool: Pool; auth: AuthService; hasher: PasswordHasher; log: Logger; now?: () => number }) {
  const { pool, auth, hasher, log } = deps;
  const now = deps.now ?? Date.now;

  async function signIn(identity: GoogleIdentity, client: ClientInfo, deviceLabel: string | null): Promise<GoogleSignIn> {
    const normalized = normalizeEmail(identity.email);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await withTransaction(pool, async (tx) => {
          // 1. already linked
          const linked = await tx.query<UserRow>('SELECT u.* FROM external_identities e JOIN users u ON u.id = e.user_id WHERE e.provider = $1 AND e.subject = $2 FOR UPDATE OF e', ['google', identity.subject]);
          let user = linked.rows[0];
          let isNew = false; let linkedExisting = false;
          if (user) {
            await tx.query('UPDATE external_identities SET last_login_at = $3 WHERE provider = $1 AND subject = $2', ['google', identity.subject, new Date(now())]);
          } else {
            const same = await tx.query<UserRow>('SELECT * FROM users WHERE email_normalized = $1 FOR UPDATE', [normalized]);
            const existing = same.rows[0];
            if (existing) {
              if (!existing.email_verified_at) throw conflict('account_needs_verification', 'An account with this email already exists, but its email address is not confirmed yet, and email confirmation is not available at the moment. Sign in with that account\'s password instead.');
              const other = await tx.query('SELECT 1 FROM external_identities WHERE user_id = $1 AND provider = $2', [existing.id, 'google']);
              if (other.rowCount) throw conflict('google_account_mismatch', 'This Petali account is already connected to a different Google account.');
              await tx.query('INSERT INTO external_identities (user_id, provider, subject, email_at_link) VALUES ($1,$2,$3,$4)', [existing.id, 'google', identity.subject, identity.email]);
              user = existing; linkedExisting = true;
            } else {
              const randomPassword = randomBytes(32).toString('base64url');
              const hash = await hasher.hash(randomPassword);
              const ins = await tx.query<UserRow>(
                `INSERT INTO users (petali_id, email, email_normalized, password_hash, password_usable, display_name, email_verified_at) VALUES ($1,$2,$3,$4,false,$5,$6) RETURNING *`,
                [generatePetaliId(), identity.email, normalized, hash, identity.name, new Date(now())]);
              user = ins.rows[0] as UserRow;
              await tx.query('INSERT INTO account_settings (user_id) VALUES ($1)', [user.id]);
              await tx.query('INSERT INTO external_identities (user_id, provider, subject, email_at_link) VALUES ($1,$2,$3,$4)', [user.id, 'google', identity.subject, identity.email]);
              isNew = true;
            }
          }
          const bundle = await auth.createSession(tx, user, client, deviceLabel);
          await auth.recordEvent(tx, user.id, isNew ? 'register' : 'login', client, bundle.sessionId, isNew ? 'google' : linkedExisting ? 'google (linked)' : 'google');
          return { user: toUserDto(user), tokens: bundle, isNewAccount: isNew, linkedExisting };
        });
      } catch (err) {
        // A concurrent first sign-in with the same Google identity or the same email: run the decision again, it now finds the row.
        if (isUniqueViolation(err, 'external_identities_provider_subject_key') || isUniqueViolation(err, 'users_email_normalized_key') || isUniqueViolation(err, 'users_petali_id_key')) { log.warn('google sign-in raced, retrying'); continue; }
        throw err;
      }
    }
    throw new AppError(503, 'google_busy', 'Please try again in a moment.');
  }
  return { signIn };
}
export type GoogleAuth = ReturnType<typeof createGoogleAuth>;
