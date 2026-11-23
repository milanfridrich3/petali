import type { Pool, PoolClient } from 'pg';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { effectivePermissions, isPermission, normalizeSharing, type Overrides, type Permission, type Sharing } from './permissions';

// Shared by every family operation, so that "who is this caller in which family, and what may they do?" is decided in exactly ONE place and is
// always read from the database at the moment of the request: a member that was removed a millisecond ago has no membership here any more
// (access is revoked immediately; nothing about a family is cached in the process or in the token).
export type Db = Pool | PoolClient;
export type Client = { ip: string | null; userAgent: string | null };

export type Membership = {
  memberId: string; familyId: string; userId: string; role: string; isOwner: boolean; joinedAt: Date;
  overrides: Overrides; permissions: Set<Permission>;
  petaliId: string; displayName: string | null;
};

type MemberJoin = { member_id: string; family_id: string; user_id: string; role: string; is_owner: boolean; joined_at: Date; petali_id: string; display_name: string | null };

export function overridesFrom(rows: { permission: string; effect: string }[]): Overrides {
  const grant: Permission[] = []; const deny: Permission[] = [];
  for (const r of rows) { if (!isPermission(r.permission)) continue; (r.effect === 'grant' ? grant : deny).push(r.permission); }   // unknown stored names are ignored, never trusted
  return { grant, deny };
}

export async function loadOverrides(db: Db, memberIds: string[]): Promise<Map<string, Overrides>> {
  const out = new Map<string, Overrides>();
  if (memberIds.length === 0) return out;
  const r = await db.query<{ member_id: string; permission: string; effect: string }>('SELECT member_id, permission, effect FROM family_member_permissions WHERE member_id = ANY($1::uuid[])', [memberIds]);
  const by = new Map<string, { permission: string; effect: string }[]>();
  for (const row of r.rows) { const l = by.get(row.member_id) ?? []; l.push(row); by.set(row.member_id, l); }
  for (const id of memberIds) out.set(id, overridesFrom(by.get(id) ?? []));
  return out;
}

export function toMembership(row: MemberJoin, overrides: Overrides): Membership {
  return {
    memberId: row.member_id, familyId: row.family_id, userId: row.user_id, role: row.role, isOwner: row.is_owner, joinedAt: row.joined_at, overrides,
    permissions: effectivePermissions({ role: row.role, isOwner: row.is_owner, overrides }), petaliId: row.petali_id, displayName: row.display_name,
  };
}

const MEMBER_SELECT = `SELECT m.id AS member_id, m.family_id, m.user_id, m.role, m.is_owner, m.joined_at, u.petali_id, u.display_name
  FROM family_members m JOIN users u ON u.id = m.user_id`;

// The membership of the signed-in account (null = not in a family). The user id comes from the verified access token, never from the request.
export async function loadMembership(db: Db, userId: string): Promise<Membership | null> {
  const r = await db.query<MemberJoin>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [userId]);
  const row = r.rows[0]; if (!row) return null;
  return toMembership(row, (await loadOverrides(db, [row.member_id])).get(row.member_id) as Overrides);
}

export async function requireMembership(db: Db, userId: string): Promise<Membership> {
  const m = await loadMembership(db, userId);
  if (!m) throw notFound('family_not_found', 'You are not in a family.');
  return m;
}

export function requirePermission(m: Membership, permission: Permission, message = 'You do not have permission to do this.'): void {
  if (!m.permissions.has(permission)) throw forbidden('permission_denied', message);
}

export type MemberRow = MemberJoin & { overrides: Overrides };
// The ONLY way a request turns a member id into a member. Scoped by the caller's family id: the id of a member of another family behaves exactly like
// an unknown one (404, nothing leaks, no cross-family access by guessing ids).
export async function loadMember(db: Db, familyId: string, memberId: string): Promise<MemberRow> {
  const r = await db.query<MemberJoin>(`${MEMBER_SELECT} WHERE m.id = $1 AND m.family_id = $2`, [memberId, familyId]);
  const row = r.rows[0];
  if (!row) throw notFound('member_not_found', 'Family member not found.');
  return { ...row, overrides: (await loadOverrides(db, [row.member_id])).get(row.member_id) as Overrides };
}

export async function loadAllMembers(db: Db, familyId: string): Promise<MemberRow[]> {
  const r = await db.query<MemberJoin>(`${MEMBER_SELECT} WHERE m.family_id = $1 ORDER BY m.is_owner DESC, m.joined_at, m.id`, [familyId]);
  const ov = await loadOverrides(db, r.rows.map((x) => x.member_id));
  return r.rows.map((row) => ({ ...row, overrides: ov.get(row.member_id) as Overrides }));
}

export async function loadSharing(db: Db, memberIds: string[]): Promise<Map<string, Sharing>> {
  const out = new Map<string, Sharing>();
  if (memberIds.length > 0) {
    const r = await db.query<{ member_id: string; sharing: unknown }>('SELECT member_id, sharing FROM family_member_privacy WHERE member_id = ANY($1::uuid[])', [memberIds]);
    for (const row of r.rows) out.set(row.member_id, normalizeSharing(row.sharing));
  }
  for (const id of memberIds) if (!out.has(id)) out.set(id, normalizeSharing(null));   // no row = nothing shared
  return out;
}

// Audit trail. Runs inside the caller's transaction on purpose: a sensitive change and its audit record commit or roll back together.
export async function audit(db: Db, familyId: string, action: string, actorUserId: string | null, targetUserId: string | null, detail: Record<string, unknown>, client: Client, audience: 'family' | 'actor' = 'family'): Promise<void> {
  await db.query('INSERT INTO family_audit_log (family_id, actor_user_id, target_user_id, action, audience, detail, ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [familyId, actorUserId, targetUserId, action, audience, JSON.stringify(detail), client.ip]);
}

export const gone = (code: string, message: string) => new AppError(410, code, message);

// Family and member names: NFC, trimmed, inner whitespace collapsed, no control characters. A label, never an identifier.
export function cleanName(raw: string, max: number): string | null {
  if (typeof raw !== 'string' || raw.length > max * 8) return null;
  const n = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  return n.length >= 1 && n.length <= max && !/[\u0000-\u001f\u007f]/.test(n) ? n : null;
}
