import type { Pool, PoolClient } from 'pg';
import type { Config } from '../../config/env';
import { isUniqueViolation, withTransaction } from '../../db/pool';
import { newOpaqueToken, sha256Hex } from '../../lib/crypto';
import { normalizeEmail } from '../../lib/email';
import { badRequest, conflict, forbidden, tooMany, unauthorized } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import { generatePetaliId } from '../../lib/petali-id';
import { toUserDto, type UserDto, type UserRow } from '../account/dto';
import { passwordProblem, type PasswordHasher } from './passwords';
import type { TokenService } from './tokens';

export type ClientInfo = { ip: string | null; userAgent: string | null };
export type SecurityEventType =
  | 'register' | 'login' | 'login_failed' | 'logout' | 'refresh_reuse_detected' | 'password_changed' | 'email_changed'
  | 'session_revoked' | 'sessions_revoked' | 'deletion_requested' | 'deletion_cancelled' | 'settings_changed';

export type TokenBundle = {
  tokenType: 'Bearer';
  accessToken: string; accessTokenExpiresAt: string;
  refreshToken: string; refreshTokenExpiresAt: string;
  sessionId: string;
};
export type AuthResult = { user: UserDto; tokens: TokenBundle };

type Db = Pool | PoolClient;
const DAY_MS = 86_400_000;
const LOCK_BASE_SECONDS = 30;
const LOCK_MAX_SECONDS = 900;
const FAILURE_WINDOW_SECONDS = 900;

export type AuthDeps = {
  pool: Pool; config: Config; hasher: PasswordHasher; tokens: TokenService; log: Logger;
  now?: () => number; generateId?: () => string;
};

export function createAuthService(deps: AuthDeps) {
  const { pool, config, hasher, tokens, log } = deps;
  const now = deps.now ?? Date.now;
  const generateId = deps.generateId ?? generatePetaliId;

  async function recordEvent(db: Db, userId: string, type: SecurityEventType, client: ClientInfo, sessionId: string | null = null, detail: string | null = null): Promise<void> {
    try {
      await db.query('INSERT INTO security_events (user_id, type, session_id, ip_address, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6)',
        [userId, type, sessionId, client.ip, client.userAgent?.slice(0, 300) ?? null, detail]);
    } catch (err) {
      log.warn({ err: (err as Error).message, type }, 'could not record security event');   // an audit-log problem must not fail the request
    }
  }

  // --- brute-force throttle (per normalized email, or per user id for re-authentication) -------------------------
  const throttleKey = (scope: string) => sha256Hex(`throttle:${scope}`);

  async function assertNotThrottled(scope: string): Promise<void> {
    const r = await pool.query<{ left: number }>('SELECT extract(epoch FROM (locked_until - now())) AS left FROM login_throttle WHERE key_hash = $1 AND locked_until > now()', [throttleKey(scope)]);
    const left = r.rows[0]?.left;
    if (left !== undefined && left > 0) throw tooMany(left);
  }

  async function recordFailure(scope: string): Promise<void> {
    const next = `CASE WHEN login_throttle.updated_at < now() - make_interval(secs => $2) THEN 1 ELSE login_throttle.failures + 1 END`;
    await pool.query(
      `INSERT INTO login_throttle (key_hash, failures, locked_until, updated_at) VALUES ($1, 1, CASE WHEN 1 >= $3 THEN now() + make_interval(secs => $4) ELSE NULL END, now())
       ON CONFLICT (key_hash) DO UPDATE SET
         failures = ${next},
         locked_until = CASE WHEN (${next}) >= $3 THEN now() + make_interval(secs => LEAST($5::double precision, $4::double precision * power(2, (${next}) - $3))) ELSE NULL END,
         updated_at = now()`,
      [throttleKey(scope), FAILURE_WINDOW_SECONDS, config.loginLockThreshold, LOCK_BASE_SECONDS, LOCK_MAX_SECONDS]);
  }

  const clearFailures = (scope: string) => pool.query('DELETE FROM login_throttle WHERE key_hash = $1', [throttleKey(scope)]);

  // --- sessions -----------------------------------------------------------------------------------------------------
  async function createSession(db: Db, user: UserRow, client: ClientInfo, deviceLabel: string | null): Promise<TokenBundle> {
    const refresh = newOpaqueToken('ptr');
    const t = now();
    const idleExpiry = new Date(t + config.refreshIdleDays * DAY_MS);
    const maxExpiry = new Date(t + config.sessionMaxDays * DAY_MS);
    const expires = idleExpiry < maxExpiry ? idleExpiry : maxExpiry;
    const r = await db.query<{ id: string }>(
      `INSERT INTO sessions (user_id, refresh_hash, device_label, user_agent, ip_address, created_at, last_used_at, expires_at, max_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8) RETURNING id`,
      [user.id, sha256Hex(refresh), deviceLabel, client.userAgent?.slice(0, 300) ?? null, client.ip, new Date(t), expires, maxExpiry]);
    const sessionId = (r.rows[0] as { id: string }).id;
    const access = await tokens.issue({ userId: user.id, sessionId });
    return { tokenType: 'Bearer', accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), refreshToken: refresh, refreshTokenExpiresAt: expires.toISOString(), sessionId };
  }

  // --- register -----------------------------------------------------------------------------------------------------
  async function register(input: { email: string; password: string; displayName?: string | undefined; deviceLabel?: string | undefined }, client: ClientInfo): Promise<AuthResult> {
    const email = input.email.trim();
    const normalized = normalizeEmail(email);
    const problem = passwordProblem(input.password, email);
    if (problem) throw badRequest('weak_password', problem);
    const passwordHash = await hasher.hash(input.password);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await withTransaction(pool, async (tx) => {
          const ins = await tx.query<UserRow>(
            `INSERT INTO users (petali_id, email, email_normalized, password_hash, display_name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [generateId(), email, normalized, passwordHash, input.displayName ?? null]);
          const user = ins.rows[0] as UserRow;
          await tx.query('INSERT INTO account_settings (user_id) VALUES ($1)', [user.id]);
          const bundle = await createSession(tx, user, client, input.deviceLabel ?? null);
          await recordEvent(tx, user.id, 'register', client, bundle.sessionId);
          return { user: toUserDto(user), tokens: bundle };
        });
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_normalized_key')) throw conflict('email_taken', 'An account with this email already exists.');
        if (isUniqueViolation(err, 'users_petali_id_key')) { log.warn('petali id collision, generating another'); continue; }
        throw err;
      }
    }
    throw new Error('could not allocate a unique Petali ID');
  }

  // --- login --------------------------------------------------------------------------------------------------------
  async function login(input: { email: string; password: string; deviceLabel?: string | undefined }, client: ClientInfo): Promise<AuthResult> {
    const normalized = normalizeEmail(input.email);
    const scope = `login:${normalized}`;
    await assertNotThrottled(scope);

    const found = await pool.query<UserRow>('SELECT * FROM users WHERE email_normalized = $1', [normalized]);
    const user = found.rows[0];
    let ok = false;
    if (user) ok = await hasher.verify(user.password_hash, input.password);
    else await hasher.verifyDummy(input.password);          // same cost whether or not the account exists

    if (!user || !ok) {
      await recordFailure(scope);
      if (user) await recordEvent(pool, user.id, 'login_failed', client);
      throw unauthorized('invalid_credentials', 'Email or password is incorrect.');
    }
    await clearFailures(scope);

    if (hasher.needsRehash(user.password_hash)) {
      // The cost settings were raised since this hash was made: upgrade it now that we know the password.
      try { await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hasher.hash(input.password)]); } catch (err) { log.warn({ err: (err as Error).message }, 'password rehash failed'); }
    }
    const bundle = await withTransaction(pool, async (tx) => {
      const b = await createSession(tx, user, client, input.deviceLabel ?? null);
      await recordEvent(tx, user.id, 'login', client, b.sessionId);
      return b;
    });
    return { user: toUserDto(user), tokens: bundle };
  }

  // --- refresh (rotation + reuse detection) -------------------------------------------------------------------------
  // nextRefreshToken (optional, Phase 4): the token the client wants to receive next, generated by the client and saved by it BEFORE asking. It makes the
  // refresh idempotent: if the answer was lost (connection dropped, app closed, power cut) the client asks again with the same pair and gets the same
  // session back instead of tripping theft detection. It weakens nothing: a replay of an old token WITHOUT the matching current token still ends the session.
  async function refresh(refreshToken: string, client: ClientInfo, nextRefreshToken?: string): Promise<AuthResult> {
    if (!/^ptr_[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw unauthorized('invalid_refresh_token', 'The refresh token is not valid.');
    if (nextRefreshToken !== undefined && (!/^ptr_[A-Za-z0-9_-]{43}$/.test(nextRefreshToken) || nextRefreshToken === refreshToken)) throw badRequest('invalid_next_refresh_token', 'The proposed refresh token is not valid.');
    const hash = sha256Hex(refreshToken);
    const nextHash = nextRefreshToken ? sha256Hex(nextRefreshToken) : null;
    type Outcome = { kind: 'ok'; result: AuthResult } | { kind: 'fail'; error: ReturnType<typeof unauthorized> };
    const outcome = await withTransaction<Outcome>(pool, async (tx) => {
      const found = await tx.query<{ id: string; user_id: string; refresh_hash: string; previous_refresh_hash: string | null; expires_at: Date; max_expires_at: Date; revoked_at: Date | null; device_label: string | null }>(
        'SELECT id, user_id, refresh_hash, previous_refresh_hash, expires_at, max_expires_at, revoked_at, device_label FROM sessions WHERE refresh_hash = $1 OR previous_refresh_hash = $1 FOR UPDATE', [hash]);
      const s = found.rows[0];
      const bad = (code = 'invalid_refresh_token', msg = 'The refresh token is not valid.'): Outcome => ({ kind: 'fail', error: unauthorized(code, msg) });
      if (!s) return bad();
      if (s.revoked_at) return bad('session_revoked', 'This session has ended. Sign in again.');
      if (s.refresh_hash !== hash && nextHash && s.previous_refresh_hash === hash && s.refresh_hash === nextHash) {
        // The same refresh asked again (the first answer never arrived): hand out the session that this very request created, rotate nothing.
        const t0 = now();
        if (s.expires_at.getTime() <= t0 || s.max_expires_at.getTime() <= t0) return bad('session_expired', 'This session has expired. Sign in again.');
        const u0 = await tx.query<UserRow>('SELECT * FROM users WHERE id = $1', [s.user_id]);
        if (!u0.rows[0]) return bad();
        const access0 = await tokens.issue({ userId: s.user_id, sessionId: s.id });
        return { kind: 'ok', result: { user: toUserDto(u0.rows[0]), tokens: { tokenType: 'Bearer', accessToken: access0.token, accessTokenExpiresAt: access0.expiresAt.toISOString(), refreshToken: nextRefreshToken as string, refreshTokenExpiresAt: s.expires_at.toISOString(), sessionId: s.id } } };
      }
      if (s.refresh_hash !== hash) {
        // An OLD token of this session came back: either a client bug or a stolen copy. Either way the whole
        // session is ended, so whoever holds the newer token is cut off too.
        await tx.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_reuse' WHERE id = $1`, [s.id]);
        await recordEvent(tx, s.user_id, 'refresh_reuse_detected', client, s.id);
        log.warn({ sessionId: s.id }, 'refresh token reuse detected; session revoked');
        return bad('refresh_token_reused', 'This session was ended for your safety. Sign in again.');
      }
      const t = now();
      if (s.expires_at.getTime() <= t || s.max_expires_at.getTime() <= t) {
        await tx.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'expired' WHERE id = $1`, [s.id]);
        return bad('session_expired', 'This session has expired. Sign in again.');
      }
      const u = await tx.query<UserRow>('SELECT * FROM users WHERE id = $1', [s.user_id]);
      const user = u.rows[0];
      if (!user) return bad();
      if (nextHash) {
        const taken = await tx.query('SELECT 1 FROM sessions WHERE refresh_hash = $1 OR previous_refresh_hash = $1', [nextHash]);
        if (taken.rowCount) return { kind: 'fail', error: badRequest('invalid_next_refresh_token', 'The proposed refresh token is not valid.') };
      }
      const next = nextRefreshToken ?? newOpaqueToken('ptr');
      const idleExpiry = new Date(t + config.refreshIdleDays * DAY_MS);
      const expires = idleExpiry < s.max_expires_at ? idleExpiry : s.max_expires_at;
      await tx.query('UPDATE sessions SET previous_refresh_hash = refresh_hash, refresh_hash = $2, last_used_at = $3, expires_at = $4, ip_address = COALESCE($5, ip_address) WHERE id = $1',
        [s.id, sha256Hex(next), new Date(t), expires, client.ip]);
      const access = await tokens.issue({ userId: user.id, sessionId: s.id });
      return { kind: 'ok', result: { user: toUserDto(user), tokens: { tokenType: 'Bearer', accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), refreshToken: next, refreshTokenExpiresAt: expires.toISOString(), sessionId: s.id } } };
    });
    if (outcome.kind === 'fail') throw outcome.error;
    return outcome.result;
  }

  // --- logout -------------------------------------------------------------------------------------------------------
  // Idempotent: ending a session that is already gone is not an error (the client wants to be signed out, and is).
  async function logoutSession(sessionId: string, userId: string, client: ClientInfo): Promise<void> {
    const r = await pool.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId]);
    if (r.rowCount) await recordEvent(pool, userId, 'logout', client, sessionId);
  }

  async function logoutByRefreshToken(refreshToken: string, client: ClientInfo): Promise<void> {
    if (!/^ptr_[A-Za-z0-9_-]{43}$/.test(refreshToken)) return;
    const hash = sha256Hex(refreshToken);
    const r = await pool.query<{ id: string; user_id: string }>(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE (refresh_hash = $1 OR previous_refresh_hash = $1) AND revoked_at IS NULL RETURNING id, user_id`, [hash]);
    const row = r.rows[0];
    if (row) await recordEvent(pool, row.user_id, 'logout', client, row.id);
  }

  // --- the check every authenticated request goes through ---------------------------------------------------------
  async function authenticate(accessToken: string): Promise<{ userId: string; sessionId: string }> {
    const claims = await tokens.verify(accessToken);
    // The session must belong to the user named in the token and still be active: this is what makes logout instant.
    const r = await pool.query('SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3 AND max_expires_at > $3', [claims.sessionId, claims.userId, new Date(now())]);
    if (!r.rowCount) throw unauthorized('session_revoked', 'This session has ended. Sign in again.');
    return claims;
  }

  // Password check for sensitive actions (email, password, deletion): throttled per account, so a stolen access
  // token cannot be used to guess the password.
  async function verifyCurrentPassword(user: UserRow, password: string): Promise<void> {
    // An account created through Google has no password (its stored hash is of random bytes nobody knows). Say so instead of "incorrect password".
    if (user.password_usable === false) throw forbidden('password_not_set', 'This account signs in with Google and has no Petali password, so this action needs one. Password-protected actions are not available for it yet.');
    const scope = `reauth:${user.id}`;
    await assertNotThrottled(scope);
    if (!(await hasher.verify(user.password_hash, password))) {
      await recordFailure(scope);
      throw forbidden('invalid_password', 'The current password is incorrect.');
    }
    await clearFailures(scope);
  }

  return { register, login, refresh, logoutSession, logoutByRefreshToken, authenticate, verifyCurrentPassword, recordEvent, createSession };
}

export type AuthService = ReturnType<typeof createAuthService>;
