import type { Pool } from 'pg';
import { isUniqueViolation, withTransaction } from '../../db/pool';
import { normalizeEmail } from '../../lib/email';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { passwordProblem, type PasswordHasher } from '../auth/passwords';
import type { AuthService, ClientInfo } from '../auth/service';
import { toSessionDto, toUserDto, type SessionRow, type UserRow } from './dto';

// Cloud account preferences (schema version 1). Only keys listed here are ever stored; they are preferences of the
// ACCOUNT and are kept in Petali Cloud, separate from the local settings of the desktop app.
export const SETTINGS_SCHEMA_VERSION = 1;
export type AccountSettings = { language: 'cs' | 'en' | null; securityAlerts: boolean };
export const DEFAULT_SETTINGS: AccountSettings = { language: null, securityAlerts: true };

function normalizeSettings(raw: unknown): AccountSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    language: o['language'] === 'cs' || o['language'] === 'en' ? o['language'] : DEFAULT_SETTINGS.language,
    securityAlerts: typeof o['securityAlerts'] === 'boolean' ? o['securityAlerts'] : DEFAULT_SETTINGS.securityAlerts,
  };
}

export function createAccountService(deps: { pool: Pool; auth: AuthService; hasher: PasswordHasher }) {
  const { pool, auth, hasher } = deps;

  // Every query below is scoped by the user id taken from the VERIFIED access token. No identifier supplied by the
  // client in a body, path or query is ever used to decide whose data is read or changed.
  async function getUserRow(userId: string): Promise<UserRow> {
    const r = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    if (!u) throw notFound('account_not_found', 'Account not found.');
    return u;
  }

  const getProfile = async (userId: string) => toUserDto(await getUserRow(userId));

  async function updateProfile(userId: string, patch: { displayName?: string | null }) {
    if (patch.displayName === undefined) return getProfile(userId);
    const r = await pool.query<UserRow>('UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *', [userId, patch.displayName]);
    if (!r.rows[0]) throw notFound('account_not_found', 'Account not found.');
    return toUserDto(r.rows[0]);
  }

  async function changeEmail(userId: string, sessionId: string, input: { newEmail: string; currentPassword: string }, client: ClientInfo) {
    const user = await getUserRow(userId);
    await auth.verifyCurrentPassword(user, input.currentPassword);
    const email = input.newEmail.trim();
    const normalized = normalizeEmail(email);
    if (normalized === user.email_normalized) throw badRequest('email_unchanged', 'That is already your email address.');
    try {
      const updated = await withTransaction(pool, async (tx) => {
        const r = await tx.query<UserRow>('UPDATE users SET email = $2, email_normalized = $3, email_verified_at = NULL, email_changed_at = now() WHERE id = $1 RETURNING *', [userId, email, normalized]);
        // Other signed-in places are signed out: if someone else was using the account, they lose access to it.
        await tx.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'email_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [userId, sessionId]);
        await auth.recordEvent(tx, userId, 'email_changed', client, sessionId);
        return r.rows[0] as UserRow;
      });
      return toUserDto(updated);
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_normalized_key')) throw conflict('email_taken', 'An account with this email already exists.');
      throw err;
    }
  }

  async function changePassword(userId: string, sessionId: string, input: { currentPassword: string; newPassword: string }, client: ClientInfo) {
    const user = await getUserRow(userId);
    await auth.verifyCurrentPassword(user, input.currentPassword);
    if (input.newPassword === input.currentPassword) throw badRequest('password_unchanged', 'Choose a password you are not already using.');
    const problem = passwordProblem(input.newPassword, user.email);
    if (problem) throw badRequest('weak_password', problem);
    const hash = await hasher.hash(input.newPassword);
    let revoked = 0;
    await withTransaction(pool, async (tx) => {
      await tx.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [userId, hash]);
      const r = await tx.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [userId, sessionId]);
      revoked = r.rowCount ?? 0;
      await auth.recordEvent(tx, userId, 'password_changed', client, sessionId);
    });
    return { otherSessionsSignedOut: revoked };
  }

  async function getSettings(userId: string) {
    const r = await pool.query<{ settings: unknown; updated_at: Date }>('SELECT settings, updated_at FROM account_settings WHERE user_id = $1', [userId]);
    const row = r.rows[0];
    return { schemaVersion: SETTINGS_SCHEMA_VERSION, settings: normalizeSettings(row?.settings), updatedAt: row ? row.updated_at.toISOString() : null };
  }

  async function updateSettings(userId: string, patch: Partial<AccountSettings>, client: ClientInfo, sessionId: string) {
    const merged = await withTransaction(pool, async (tx) => {
      await tx.query('INSERT INTO account_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
      const cur = await tx.query<{ settings: unknown }>('SELECT settings FROM account_settings WHERE user_id = $1 FOR UPDATE', [userId]);
      const next = { ...normalizeSettings(cur.rows[0]?.settings), ...patch };
      await tx.query('UPDATE account_settings SET settings = $2::jsonb, schema_version = $3 WHERE user_id = $1', [userId, JSON.stringify(next), SETTINGS_SCHEMA_VERSION]);
      await auth.recordEvent(tx, userId, 'settings_changed', client, sessionId);
      return next;
    });
    const fresh = await getSettings(userId);
    return { ...fresh, settings: merged };
  }

  async function listSessions(userId: string, currentSessionId: string) {
    const r = await pool.query<SessionRow>(
      `SELECT id, user_id, device_label, user_agent, ip_address, created_at, last_used_at, expires_at, max_expires_at, revoked_at
         FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND max_expires_at > now() ORDER BY last_used_at DESC LIMIT 100`, [userId]);
    return r.rows.map((s) => toSessionDto(s, currentSessionId));
  }

  async function revokeSession(userId: string, currentSessionId: string, targetId: string, client: ClientInfo) {
    // "AND user_id = $2": someone else's session id behaves exactly like one that does not exist.
    const r = await pool.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_user' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [targetId, userId]);
    if (!r.rowCount) throw notFound('session_not_found', 'Session not found.');
    await auth.recordEvent(pool, userId, 'session_revoked', client, currentSessionId, targetId === currentSessionId ? 'own session' : null);
    return { signedOutCurrent: targetId === currentSessionId };
  }

  async function revokeOtherSessions(userId: string, currentSessionId: string, client: ClientInfo) {
    const r = await pool.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_user' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [userId, currentSessionId]);
    if (r.rowCount) await auth.recordEvent(pool, userId, 'sessions_revoked', client, currentSessionId, `${r.rowCount} session(s)`);
    return { revoked: r.rowCount ?? 0 };
  }

  async function requestDeletion(userId: string, sessionId: string, password: string, client: ClientInfo) {
    const user = await getUserRow(userId);
    await auth.verifyCurrentPassword(user, password);
    const r = await pool.query<UserRow>('UPDATE users SET deletion_requested_at = COALESCE(deletion_requested_at, now()) WHERE id = $1 RETURNING *', [userId]);
    if (!user.deletion_requested_at) await auth.recordEvent(pool, userId, 'deletion_requested', client, sessionId);
    return toUserDto(r.rows[0] as UserRow);
  }

  async function cancelDeletion(userId: string, sessionId: string, client: ClientInfo) {
    const before = await getUserRow(userId);
    const r = await pool.query<UserRow>('UPDATE users SET deletion_requested_at = NULL WHERE id = $1 RETURNING *', [userId]);
    if (before.deletion_requested_at) await auth.recordEvent(pool, userId, 'deletion_cancelled', client, sessionId);
    return toUserDto(r.rows[0] as UserRow);
  }

  async function listSecurityEvents(userId: string, limit: number) {
    const r = await pool.query<{ type: string; ip_address: string | null; user_agent: string | null; detail: string | null; created_at: Date }>(
      'SELECT type, ip_address, user_agent, detail, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, limit]);
    return r.rows.map((e) => ({ type: e.type, ipAddress: e.ip_address, detail: e.detail, createdAt: e.created_at.toISOString() }));
  }

  return { getProfile, updateProfile, changeEmail, changePassword, getSettings, updateSettings, listSessions, revokeSession, revokeOtherSessions, requestDeletion, cancelDeletion, listSecurityEvents };
}

export type AccountService = ReturnType<typeof createAccountService>;
