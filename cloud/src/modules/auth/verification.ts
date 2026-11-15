import type { RequestHandler } from 'express';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Pool } from 'pg';
import type { Config } from '../../config/env';
import { verificationEmail } from '../../lib/email-templates';
import { sha256Hex } from '../../lib/crypto';
import { AppError, badRequest, conflict, forbidden, tooMany } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import { MailError, type Mailer } from '../../lib/mailer';

// Email verification (1.5.0 Phase 6).
//
// The link carries a signed, expiring token (HS256, its own key derived from the server secret, its own audience), not a database row: no migration,
// and nothing to leak from a dump. The token names the user AND the normalized email it was issued for, so changing the email invalidates every older
// link. Verifying twice is harmless (idempotent). "Verified" is only ever written by verify() below, after the token checked out against the database.
const AUDIENCE = 'petali-email-verification';
const RESEND_COOLDOWN_MS = 60_000;

export type VerificationStatus = { sent: boolean; reason?: 'not_configured' | 'delivery_failed' };
type UserForMail = { id: string; email: string; email_normalized: string; display_name: string | null };

export function createVerificationService(deps: { pool: Pool; config: Config; mailer: Mailer; log: Logger; now?: () => number }) {
  const { pool, config, mailer, log } = deps; const now = deps.now ?? Date.now; const cfg = config.email;
  const key = new TextEncoder().encode(sha256Hex(`petali-email-verification:${config.jwtSecret}`));
  const lastSent = new Map<string, number>();
  const verifiedCache = new Set<string>();      // verification never goes away on its own, so a positive answer can be remembered (changeEmail clears it)

  async function issue(u: UserForMail): Promise<string> {
    const iat = Math.floor(now() / 1000);
    return new SignJWT({ purpose: 'verify-email', em: u.email_normalized }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer(config.jwtIssuer).setAudience(AUDIENCE)
      .setIssuedAt(iat).setExpirationTime(iat + Math.floor(cfg.verifyTtlMs / 1000)).sign(key);
  }

  // Sends the verification email. Resolves with what REALLY happened; never throws for a delivery problem (registration must not fail because of it).
  async function sendFor(u: UserForMail): Promise<VerificationStatus> {
    if (!mailer.configured) return { sent: false, reason: 'not_configured' };
    try {
      const token = await issue(u);
      const link = `${cfg.verifyBaseUrl}/id/verify?token=${encodeURIComponent(token)}`;
      await mailer.send({ to: u.email, ...verificationEmail({ displayName: u.display_name, link, ttlHours: Math.round(cfg.verifyTtlMs / 3_600_000) }) });
      lastSent.set(u.id, now());
      return { sent: true };
    } catch (err) {
      if (err instanceof MailError && err.code === 'not_configured') return { sent: false, reason: 'not_configured' };
      if (!(err instanceof MailError)) log.error({ err: (err as Error).message }, 'verification email failed unexpectedly');
      return { sent: false, reason: 'delivery_failed' };
    }
  }

  async function userRow(userId: string) {
    const r = await pool.query<UserForMail & { email_verified_at: Date | null; created_at: Date }>('SELECT id, email, email_normalized, display_name, email_verified_at, created_at FROM users WHERE id = $1', [userId]);
    return r.rows[0] ?? null;
  }

  async function verify(token: string): Promise<{ status: 'verified' | 'already_verified'; email: string }> {
    let claims;
    try {
      claims = (await jwtVerify(token, key, { audience: AUDIENCE, issuer: config.jwtIssuer, algorithms: ['HS256'], currentDate: new Date(now()) })).payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw badRequest('verification_expired', 'This verification link has expired. Request a new one.');
      throw badRequest('verification_invalid', 'This verification link is not valid.');
    }
    if (claims['purpose'] !== 'verify-email' || typeof claims.sub !== 'string' || typeof claims['em'] !== 'string') throw badRequest('verification_invalid', 'This verification link is not valid.');
    const u = await userRow(claims.sub);
    // Account gone, or the email was changed after this link was sent: the link is for an address that is no longer the account's.
    if (!u || u.email_normalized !== claims['em']) throw badRequest('verification_invalid', 'This verification link is no longer valid.');
    if (u.email_verified_at) { verifiedCache.add(u.id); return { status: 'already_verified', email: u.email }; }
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_normalized = $2 AND email_verified_at IS NULL', [u.id, claims['em']]);
    verifiedCache.add(u.id);
    return { status: 'verified', email: u.email };
  }

  async function resend(userId: string): Promise<void> {
    const u = await userRow(userId);
    if (!u) throw forbidden('account_missing', 'This account no longer exists.');
    if (u.email_verified_at) throw conflict('already_verified', 'This email address is already verified.');
    const prev = lastSent.get(userId);
    if (prev !== undefined && now() - prev < RESEND_COOLDOWN_MS) throw tooMany(Math.ceil((RESEND_COOLDOWN_MS - (now() - prev)) / 1000), 'resend_too_soon', 'A verification email was just sent. Wait a minute before asking for another.');
    const r = await sendFor(u);
    if (!r.sent) {
      if (r.reason === 'not_configured') throw new AppError(503, 'email_not_configured', 'Email delivery is not set up on this server yet, so no verification email could be sent.');
      throw new AppError(502, 'email_delivery_failed', 'The verification email could not be sent. Try again in a few minutes.');
    }
  }

  async function userRowByPetaliId(petaliId: string) {
    const r = await pool.query<UserForMail & { email_verified_at: Date | null; created_at: Date }>('SELECT id, email, email_normalized, display_name, email_verified_at, created_at FROM users WHERE petali_id = $1', [petaliId]);
    return r.rows[0] ?? null;
  }
  const enforced = (createdAt: Date) => cfg.enforceFrom !== null && createdAt.getTime() >= cfg.enforceFrom;

  // Gate for the endpoints that need a verified account. Accounts created before EMAIL_VERIFICATION_ENFORCE_FROM (every existing account) pass untouched.
  const gate: RequestHandler = async (req, _res, next) => {
    try {
      if (cfg.enforceFrom === null) return next();
      const userId = (req.auth as { userId: string } | undefined)?.userId; if (!userId) return next();
      if (verifiedCache.has(userId)) return next();
      const u = await userRow(userId);
      if (!u) return next();
      if (u.email_verified_at) { verifiedCache.add(userId); return next(); }
      if (!enforced(u.created_at)) return next();
      next(forbidden('email_not_verified', 'Confirm your email address first. Check your inbox for the verification link.'));
    } catch (err) { next(err); }
  };

  return { sendFor, verify, resend, gate, forgetVerified: (id: string) => { verifiedCache.delete(id); lastSent.delete(id); }, userRow, userRowByPetaliId, enforced };
}
export type VerificationService = ReturnType<typeof createVerificationService>;
