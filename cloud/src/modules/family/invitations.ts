import type { Pool, PoolClient } from 'pg';
import type { Config } from '../../config/env';
import { isUniqueViolation, withTransaction } from '../../db/pool';
import { newOpaqueToken, sha256Hex } from '../../lib/crypto';
import { normalizeEmail } from '../../lib/email';
import { familyInvitationEmail } from '../../lib/email-templates';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import { MailError, type Mailer } from '../../lib/mailer';
import { isValidPetaliId } from '../../lib/petali-id';
import { audit, gone, loadMembership, requireMembership, requirePermission, type Client } from './access';
import { isAdministratorRole, isRole } from './permissions';
import type { FamilyService } from './service';

// Invitations.
//
// An invitation is bound to an IDENTITY, not to whoever holds the code:
//   * "by Petali ID": only that account can answer it,
//   * "by email": only an account whose email address is VERIFIED and equals the invited address can answer it (so someone who merely registers with
//     another person's address, and never proves it, cannot take the invitation).
// The code (pfi_...) is 256 random bits, only its SHA-256 is stored, it is single-use (the status flips in one locked transaction) and it is useless
// to anybody who is not the invited identity. Every failure for a caller who is not the invited identity is the SAME 404 (no enumeration of codes or
// of other people's invitations); the specific reasons (expired, revoked, used) are only told to the invited account.
const CODE_RE = /^pfi_[A-Za-z0-9_-]{43}$/;
const RESEND_COOLDOWN_MS = 60_000;

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
type InviteRow = {
  id: string; family_id: string; invited_by: string | null; invitee_user_id: string | null; invitee_email_normalized: string | null; role: string; token_hash: string;
  status: InviteStatus; expires_at: Date; email_sent_at: Date | null; created_at: Date; responded_at: Date | null;
};
export type Delivery = 'sent' | 'not_configured' | 'delivery_failed' | 'not_applicable';

export function createInvitationService(deps: { pool: Pool; config: Config; family: FamilyService; mailer: Mailer; log: Logger; now?: () => number }) {
  const { pool, config, family, mailer, log } = deps;
  const now = deps.now ?? Date.now;
  const lock = (tx: PoolClient, key: string) => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  const effective = (i: InviteRow): InviteStatus => (i.status === 'pending' && i.expires_at.getTime() <= now() ? 'expired' : i.status);

  type Joined = InviteRow & { inviter_name: string | null; inviter_petali_id: string | null; invitee_petali_id: string | null; invitee_name: string | null; family_name: string };
  const JOINED = `SELECT i.*, iu.display_name AS inviter_name, iu.petali_id AS inviter_petali_id, tu.petali_id AS invitee_petali_id, tu.display_name AS invitee_name, f.name AS family_name
    FROM family_invitations i JOIN families f ON f.id = i.family_id LEFT JOIN users iu ON iu.id = i.invited_by LEFT JOIN users tu ON tu.id = i.invitee_user_id`;

  // For the family side: who was invited (the address the inviter typed is kept only as its normalized form) and what became of it.
  const familyDto = (i: Joined) => ({
    id: i.id, role: i.role, status: effective(i), via: i.invitee_user_id ? ('petaliId' as const) : ('email' as const),
    invitee: { petaliId: i.invitee_petali_id, displayName: i.invitee_name, email: i.invitee_user_id ? null : i.invitee_email_normalized },
    invitedBy: i.inviter_petali_id ? { petaliId: i.inviter_petali_id, displayName: i.inviter_name } : null,
    createdAt: i.created_at.toISOString(), expiresAt: i.expires_at.toISOString(), respondedAt: i.responded_at ? i.responded_at.toISOString() : null,
  });
  // For the invited account: no member list, no emails, nothing but what is needed to decide.
  const receivedDto = (i: Joined) => ({
    id: i.id, familyName: i.family_name, role: i.role, status: effective(i), via: i.invitee_user_id ? ('petaliId' as const) : ('email' as const),
    invitedBy: i.inviter_petali_id ? { petaliId: i.inviter_petali_id, displayName: i.inviter_name } : null, createdAt: i.created_at.toISOString(), expiresAt: i.expires_at.toISOString(),
  });

  async function deliver(to: string, inviterName: string, familyName: string, role: string, code: string): Promise<Delivery> {
    if (!mailer.configured) return 'not_configured';
    try {
      await mailer.send({ to, ...familyInvitationEmail({ inviterName, familyName, role, code, ttlDays: Math.round(config.family.inviteTtlMs / 86_400_000) }) });
      return 'sent';
    } catch (err) {
      if (err instanceof MailError && err.code === 'not_configured') return 'not_configured';
      if (!(err instanceof MailError)) log.error({ err: (err as Error).message }, 'family invitation email failed unexpectedly');
      return 'delivery_failed';
    }
  }

  // ---- the family side -----------------------------------------------------------------------------------------------------------
  async function create(userId: string, input: { petaliId?: string | undefined; email?: string | undefined; role: string }, client: Client) {
    if ((input.petaliId === undefined) === (input.email === undefined)) throw badRequest('validation_failed', 'Give either a Petali ID or an email address.');
    if (!isRole(input.role)) throw badRequest('unknown_role', 'That role does not exist.');
    if (input.petaliId !== undefined && !isValidPetaliId(input.petaliId)) throw badRequest('validation_failed', 'The request is not valid.', { fields: [{ field: 'petaliId', message: 'That is not a valid Petali ID.' }] });
    const email = input.email !== undefined ? normalizeEmail(input.email) : null;
    const code = newOpaqueToken('pfi');
    const made = await family.withFamilyTx(userId, async (tx, m) => {
      requirePermission(m, 'members.invite', 'You are not allowed to invite members.');
      if (isAdministratorRole(input.role) && !m.isOwner) throw forbidden('owner_required', 'Only the family owner can invite a parent.');
      const t = new Date(now());
      await tx.query(`UPDATE family_invitations SET status = 'expired', responded_at = $2 WHERE family_id = $1 AND status = 'pending' AND expires_at <= $2`, [m.familyId, t]);
      const members = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM family_members WHERE family_id = $1', [m.familyId])).rows[0]?.n ?? 0;
      if (members >= config.family.maxMembers) throw conflict('family_full', `A family can have at most ${config.family.maxMembers} members.`);
      const open = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM family_invitations WHERE family_id = $1 AND status = 'pending'`, [m.familyId])).rows[0]?.n ?? 0;
      if (open >= config.family.maxPendingInvitations) throw conflict('too_many_invitations', `At most ${config.family.maxPendingInvitations} invitations can be open at once. Revoke some first.`);

      let inviteeUserId: string | null = null; let inviteeEmail: string | null = null; let mailTo: string | null = null;
      if (input.petaliId !== undefined) {
        const u = (await tx.query<{ id: string; email: string; email_verified_at: Date | null }>('SELECT id, email, email_verified_at FROM users WHERE petali_id = $1', [input.petaliId])).rows[0];
        if (!u) throw notFound('invitee_not_found', 'No Petali account has that Petali ID.');
        if (u.id === userId) throw badRequest('cannot_invite_self', 'You cannot invite yourself.');
        inviteeUserId = u.id; mailTo = u.email_verified_at ? u.email : null;      // a notice goes only to an address its owner has confirmed
      } else {
        const e = email as string;
        const existing = (await tx.query<{ id: string }>('SELECT id FROM users WHERE email_normalized = $1', [e])).rows[0];
        if (existing?.id === userId) throw badRequest('cannot_invite_self', 'You cannot invite yourself.');
        inviteeEmail = e; mailTo = e;
      }
      if (inviteeUserId && (await tx.query('SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2', [m.familyId, inviteeUserId])).rowCount) throw conflict('already_member', 'That person is already a member of this family.');
      if (inviteeEmail && (await tx.query('SELECT 1 FROM family_members fm JOIN users u ON u.id = fm.user_id WHERE fm.family_id = $1 AND u.email_normalized = $2', [m.familyId, inviteeEmail])).rowCount) throw conflict('already_member', 'That person is already a member of this family.');
      const dup = await tx.query('SELECT 1 FROM family_invitations WHERE family_id = $1 AND status = \'pending\' AND (($2::uuid IS NOT NULL AND invitee_user_id = $2) OR ($3::text IS NOT NULL AND invitee_email_normalized = $3))', [m.familyId, inviteeUserId, inviteeEmail]);
      if (dup.rowCount) throw conflict('invitation_exists', 'There is already an open invitation for that person. Revoke it to send a new one.');
      const row = (await tx.query<InviteRow>(
        `INSERT INTO family_invitations (family_id, invited_by, invitee_user_id, invitee_email_normalized, role, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [m.familyId, userId, inviteeUserId, inviteeEmail, input.role, sha256Hex(code), new Date(now() + config.family.inviteTtlMs)])).rows[0] as InviteRow;
      await audit(tx, m.familyId, 'invitation_created', userId, inviteeUserId, { invitationId: row.id, role: input.role, via: inviteeUserId ? 'petaliId' : 'email' }, client);
      const fam = (await tx.query<{ name: string }>('SELECT name FROM families WHERE id = $1', [m.familyId])).rows[0];
      return { row, mailTo, inviterName: m.displayName ?? m.petaliId, familyName: fam?.name ?? '' };
    }).catch((err) => { if (isUniqueViolation(err)) throw conflict('invitation_exists', 'There is already an open invitation for that person. Revoke it to send a new one.'); throw err; });

    // The email goes out AFTER the invitation is committed (a slow mail provider never holds a database transaction open).
    let delivery: Delivery = 'not_applicable';
    if (made.mailTo) {
      delivery = await deliver(made.mailTo, made.inviterName, made.familyName, input.role, code);
      if (delivery === 'sent') await pool.query('UPDATE family_invitations SET email_sent_at = $2 WHERE id = $1', [made.row.id, new Date(now())]);
    }
    const dto = await oneForFamily(made.row.id);
    // An email invitation that could not be mailed: hand the code to the inviter so they can pass it on themselves. It is bound to the invited address, so it
    // is of no use to the inviter or to anybody else.
    const share = made.row.invitee_user_id === null && delivery !== 'sent' ? { code } : {};
    return { invitation: dto, delivery, ...share };
  }

  async function oneForFamily(id: string) { const r = await pool.query<Joined>(`${JOINED} WHERE i.id = $1`, [id]); return familyDto(r.rows[0] as Joined); }

  async function list(userId: string, status: 'pending' | 'all') {
    const m = await requireMembership(pool, userId);
    requirePermission(m, 'invitations.view', 'You are not allowed to see the invitations.');
    const r = await pool.query<Joined>(`${JOINED} WHERE i.family_id = $1 ORDER BY i.created_at DESC, i.id LIMIT 200`, [m.familyId]);
    const all = r.rows.map(familyDto);
    return { invitations: status === 'all' ? all : all.filter((i) => i.status === 'pending') };
  }

  async function loadOwn(tx: PoolClient, familyId: string, id: string): Promise<InviteRow> {
    const r = await tx.query<InviteRow>('SELECT * FROM family_invitations WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, familyId]);
    if (!r.rows[0]) throw notFound('invitation_not_found', 'Invitation not found.');
    return r.rows[0];
  }

  async function revoke(userId: string, id: string, client: Client) {
    return family.withFamilyTx(userId, async (tx, m) => {
      requirePermission(m, 'invitations.manage', 'You are not allowed to manage invitations.');
      const inv = await loadOwn(tx, m.familyId, id);
      if (inv.status === 'revoked') return { id, status: 'revoked' as const, changed: false };
      if (effective(inv) !== 'pending') throw conflict('invitation_not_pending', `This invitation is already ${effective(inv)}.`);
      await tx.query(`UPDATE family_invitations SET status = 'revoked', responded_at = $2, responded_by = $3 WHERE id = $1`, [id, new Date(now()), userId]);
      await audit(tx, m.familyId, 'invitation_revoked', userId, inv.invitee_user_id, { invitationId: id }, client);
      return { id, status: 'revoked' as const, changed: true };
    });
  }

  // A lost email: a NEW code replaces the old one (the old one stops working at once) and the expiry restarts.
  async function resend(userId: string, id: string, client: Client) {
    const code = newOpaqueToken('pfi');
    const done = await family.withFamilyTx(userId, async (tx, m) => {
      requirePermission(m, 'invitations.manage', 'You are not allowed to manage invitations.');
      const inv = await loadOwn(tx, m.familyId, id);
      if (effective(inv) !== 'pending') throw conflict('invitation_not_pending', `This invitation is already ${effective(inv)}.`);
      if (inv.email_sent_at && now() - inv.email_sent_at.getTime() < RESEND_COOLDOWN_MS) throw tooMany(Math.ceil((RESEND_COOLDOWN_MS - (now() - inv.email_sent_at.getTime())) / 1000), 'resend_too_soon', 'An email was just sent. Wait a minute before sending another.');
      let mailTo: string | null = inv.invitee_email_normalized;
      if (inv.invitee_user_id) { const u = (await tx.query<{ email: string; email_verified_at: Date | null }>('SELECT email, email_verified_at FROM users WHERE id = $1', [inv.invitee_user_id])).rows[0]; mailTo = u && u.email_verified_at ? u.email : null; }
      await tx.query('UPDATE family_invitations SET token_hash = $2, expires_at = $3 WHERE id = $1', [id, sha256Hex(code), new Date(now() + config.family.inviteTtlMs)]);
      await audit(tx, m.familyId, 'invitation_resent', userId, inv.invitee_user_id, { invitationId: id }, client);
      const fam = (await tx.query<{ name: string }>('SELECT name FROM families WHERE id = $1', [m.familyId])).rows[0];
      return { mailTo, role: inv.role, byUser: inv.invitee_user_id !== null, inviterName: m.displayName ?? m.petaliId, familyName: fam?.name ?? '' };
    });
    let delivery: Delivery = 'not_applicable';
    if (done.mailTo) { delivery = await deliver(done.mailTo, done.inviterName, done.familyName, done.role, code); if (delivery === 'sent') await pool.query('UPDATE family_invitations SET email_sent_at = $2 WHERE id = $1', [id, new Date(now())]); }
    return { invitation: await oneForFamily(id), delivery, ...(!done.byUser && delivery !== 'sent' ? { code } : {}) };
  }

  // ---- the invited side ----------------------------------------------------------------------------------------------------------
  async function received(userId: string, status: 'pending' | 'all') {
    const u = (await pool.query<{ email_normalized: string; email_verified_at: Date | null }>('SELECT email_normalized, email_verified_at FROM users WHERE id = $1', [userId])).rows[0];
    if (!u) throw forbidden('account_missing', 'This account no longer exists.');
    const verifiedEmail = u.email_verified_at ? u.email_normalized : null;
    const r = await pool.query<Joined>(`${JOINED} WHERE (i.invitee_user_id = $1 OR ($2::text IS NOT NULL AND i.invitee_email_normalized = $2)) AND ($3 OR i.status = 'pending') ORDER BY i.created_at DESC LIMIT 100`, [userId, verifiedEmail, status === 'all']);
    const list = r.rows.map(receivedDto);
    return { invitations: status === 'all' ? list : list.filter((i) => i.status === 'pending') };
  }

  type Ref = { id: string } | { code: string };
  // Accepting or declining. Locks the account and the family (an account cannot join two families at once; the family cannot overfill), re-reads the
  // invitation under the lock (single use: only one of two parallel answers can win) and only then decides.
  async function respond(userId: string, ref: Ref, action: 'accept' | 'decline', client: Client) {
    let found: InviteRow | undefined;
    if ('code' in ref) { if (!CODE_RE.test(ref.code)) throw notFound('invitation_not_found', 'Invitation not found.'); found = (await pool.query<InviteRow>('SELECT * FROM family_invitations WHERE token_hash = $1', [sha256Hex(ref.code)])).rows[0]; }
    else found = (await pool.query<InviteRow>('SELECT * FROM family_invitations WHERE id = $1', [ref.id])).rows[0];
    if (!found) throw notFound('invitation_not_found', 'Invitation not found.');
    const famId = found.family_id; const invId = found.id;

    const outcome = await withTransaction(pool, async (tx) => {
      await lock(tx, `family-user:${userId}`);
      await lock(tx, `family:${famId}`);
      const inv = (await tx.query<InviteRow>('SELECT * FROM family_invitations WHERE id = $1 FOR UPDATE', [invId])).rows[0];
      if (!inv) throw notFound('invitation_not_found', 'Invitation not found.');
      // A code that was replaced by a resend no longer matches: it is not the current code of this invitation.
      if ('code' in ref && inv.token_hash !== sha256Hex(ref.code)) throw notFound('invitation_not_found', 'Invitation not found.');
      const user = (await tx.query<{ email_normalized: string; email_verified_at: Date | null; deletion_requested_at: Date | null }>('SELECT email_normalized, email_verified_at, deletion_requested_at FROM users WHERE id = $1 FOR SHARE', [userId])).rows[0];
      if (!user) throw forbidden('account_missing', 'This account no longer exists.');
      const byId = inv.invitee_user_id === userId;
      const byEmail = inv.invitee_email_normalized !== null && inv.invitee_email_normalized === user.email_normalized;
      if (!byId && !byEmail) throw notFound('invitation_not_found', 'Invitation not found.');             // not yours: indistinguishable from "does not exist"
      if (!byId && byEmail && !user.email_verified_at) throw forbidden('email_not_verified', 'Confirm your email address first. This invitation was sent to it.');

      const st = effective(inv);
      if (st === 'expired' && inv.status === 'pending') {                                                    // record the expiry, then report it (after the commit)
        await tx.query(`UPDATE family_invitations SET status = 'expired', responded_at = $2 WHERE id = $1 AND status = 'pending'`, [inv.id, new Date(now())]);
        return { kind: 'expired' as const };
      }
      if (st === 'accepted') return { kind: 'used' as const };
      if (st !== 'pending') return { kind: st };
      const t = new Date(now());
      if (action === 'decline') {
        await tx.query(`UPDATE family_invitations SET status = 'declined', responded_at = $2, responded_by = $3 WHERE id = $1`, [inv.id, t, userId]);
        await audit(tx, inv.family_id, 'invitation_declined', userId, userId, { invitationId: inv.id }, client);
        return { kind: 'declined' as const };
      }
      if (user.deletion_requested_at) throw forbidden('account_pending_deletion', 'An account with a pending deletion request cannot join a family. Cancel the deletion request first.');
      if ((await tx.query('SELECT 1 FROM family_members WHERE user_id = $1', [userId])).rowCount) throw conflict('already_in_family', 'You are already in a family. Leave it first to join another.');
      if (!isRole(inv.role)) throw conflict('invitation_invalid', 'This invitation is no longer valid.');
      const members = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM family_members WHERE family_id = $1', [inv.family_id])).rows[0]?.n ?? 0;
      if (members >= config.family.maxMembers) throw conflict('family_full', 'This family is full.');
      await tx.query('INSERT INTO family_members (family_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4)', [inv.family_id, userId, inv.role, inv.invited_by]);
      await tx.query(`UPDATE family_invitations SET status = 'accepted', responded_at = $2, responded_by = $3 WHERE id = $1`, [inv.id, t, userId]);
      await audit(tx, inv.family_id, 'member_joined', userId, userId, { invitationId: inv.id, role: inv.role }, client);
      return { kind: 'accepted' as const };
    }).catch((err) => { if (isUniqueViolation(err, 'family_members_user_key')) throw conflict('already_in_family', 'You are already in a family. Leave it first to join another.'); throw err; });

    switch (outcome.kind) {
      case 'expired': throw gone('invitation_expired', 'This invitation has expired. Ask for a new one.');
      case 'revoked': throw gone('invitation_revoked', 'This invitation was withdrawn.');
      case 'declined': if (action === 'decline') return { status: 'declined' as const }; throw gone('invitation_declined', 'This invitation was declined.');
      case 'used': throw conflict('invitation_already_used', 'This invitation was already used.');
      case 'accepted': return { status: 'accepted' as const, ...(await family.overview(userId)) };
      default: return { status: 'declined' as const };
    }
  }

  return {
    create, list, revoke, resend, received,
    accept: (userId: string, id: string, client: Client) => respond(userId, { id }, 'accept', client),
    decline: (userId: string, id: string, client: Client) => respond(userId, { id }, 'decline', client),
    acceptCode: (userId: string, code: string, client: Client) => respond(userId, { code }, 'accept', client),
    declineCode: (userId: string, code: string, client: Client) => respond(userId, { code }, 'decline', client),
    loadMembership: (userId: string) => loadMembership(pool, userId),
  };
}
export type InvitationService = ReturnType<typeof createInvitationService>;
