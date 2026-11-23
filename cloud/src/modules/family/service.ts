import type { Pool, PoolClient } from 'pg';
import type { Config } from '../../config/env';
import { isUniqueViolation, withTransaction } from '../../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit, cleanName, loadAllMembers, loadMember, loadMembership, loadSharing, requireMembership, requirePermission, type Client, type Membership } from './access';
import {
  ALWAYS_GRANTED, NON_DELEGABLE, PERMISSIONS, PRIVACY_CATEGORIES, canManageMember, canViewMemberData, effectivePermissions, isAdministratorRole, isPermission, isRole,
  normalizeSettings, normalizeSharing, roleDefaults, type FamilySettings, type Permission, type PrivacyCategory, type Sharing,
} from './permissions';

export const FAMILY_NAME_MAX = 60;
export const AUDIT_PAGE = 50;

// Families, membership, roles, permissions and individual sharing preferences.
//
// Rules every operation follows:
//   * the account comes from the verified access token; nothing the client sends (family id, member id, device id) is trusted until it has been looked up
//     again INSIDE the caller's own family (a foreign id is indistinguishable from an unknown one),
//   * everything that changes membership runs in one transaction under a per-family advisory lock, and authorization is decided inside that lock from fresh
//     rows, so two concurrent operations (remove + promote, leave + transfer) cannot both succeed on stale state,
//   * a sensitive change and its audit record commit together,
//   * the database refuses a family without an owner as a last line of defence (see migration 0005).
export function createFamilyService(deps: { pool: Pool; config: Config; now?: () => number }) {
  const { pool, config } = deps;
  const now = deps.now ?? Date.now;
  const lock = (tx: PoolClient, key: string) => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

  // Runs fn with the caller's membership, inside a transaction holding the family lock.
  async function withFamilyTx<T>(userId: string, fn: (tx: PoolClient, m: Membership) => Promise<T>): Promise<T> {
    return withTransaction(pool, async (tx) => {
      const first = (await tx.query<{ family_id: string }>('SELECT family_id FROM family_members WHERE user_id = $1', [userId])).rows[0];
      if (!first) throw notFound('family_not_found', 'You are not in a family.');
      await lock(tx, `family:${first.family_id}`);
      const m = await loadMembership(tx, userId);          // read again under the lock: the answer above may be stale
      if (!m || m.familyId !== first.family_id) throw notFound('family_not_found', 'You are not in a family.');
      return fn(tx, m);
    });
  }

  const meDto = (m: Membership) => ({
    memberId: m.memberId, petaliId: m.petaliId, displayName: m.displayName, role: m.role, isOwner: m.isOwner, joinedAt: m.joinedAt.toISOString(),
    permissions: [...m.permissions].sort(),
  });

  // ---- the family ---------------------------------------------------------------------------------------------------------------
  async function overview(userId: string) {
    const m = await loadMembership(pool, userId);
    if (!m) return { family: null, me: null };
    const f = (await pool.query<{ id: string; name: string; settings: unknown; created_at: Date; creator_name: string | null; creator_petali_id: string | null }>(
      `SELECT f.id, f.name, f.settings, f.created_at, cu.display_name AS creator_name, cu.petali_id AS creator_petali_id FROM families f LEFT JOIN users cu ON cu.id = f.created_by WHERE f.id = $1`, [m.familyId])).rows[0];
    if (!f) return { family: null, me: null };
    const counts = (await pool.query<{ members: number; parents: number }>(`SELECT count(*)::int AS members, count(*) FILTER (WHERE role = 'parent')::int AS parents FROM family_members WHERE family_id = $1`, [m.familyId])).rows[0];
    let pending: number | null = null;
    if (m.permissions.has('invitations.view')) pending = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM family_invitations WHERE family_id = $1 AND status = 'pending' AND expires_at > $2`, [m.familyId, new Date(now())])).rows[0]?.n ?? 0;
    return {
      family: {
        id: f.id, name: f.name, createdAt: f.created_at.toISOString(), createdBy: f.creator_petali_id ? { petaliId: f.creator_petali_id, displayName: f.creator_name } : null,
        memberCount: counts?.members ?? 0, parentCount: counts?.parents ?? 0, pendingInvitations: pending, settings: normalizeSettings(f.settings),
        limits: { maxMembers: config.family.maxMembers, maxPendingInvitations: config.family.maxPendingInvitations },
      },
      me: meDto(m),
    };
  }

  async function createFamily(userId: string, input: { name: string }, client: Client) {
    const name = cleanName(input.name, FAMILY_NAME_MAX);
    if (!name) throw badRequest('validation_failed', 'The request is not valid.', { fields: [{ field: 'name', message: `A family name of 1 to ${FAMILY_NAME_MAX} characters is required.` }] });
    try {
      await withTransaction(pool, async (tx) => {
        await lock(tx, `family-user:${userId}`);                 // two parallel "create" / "accept" requests of one account cannot both win
        const u = (await tx.query<{ deletion_requested_at: Date | null }>('SELECT deletion_requested_at FROM users WHERE id = $1 FOR SHARE', [userId])).rows[0];
        if (!u) throw forbidden('account_missing', 'This account no longer exists.');
        if (u.deletion_requested_at) throw forbidden('account_pending_deletion', 'An account with a pending deletion request cannot create a family. Cancel the deletion request first.');
        if ((await tx.query('SELECT 1 FROM family_members WHERE user_id = $1', [userId])).rowCount) throw conflict('already_in_family', 'You are already in a family. Leave it first to create another.');
        const f = (await tx.query<{ id: string }>('INSERT INTO families (name, settings, created_by) VALUES ($1, $2, $3) RETURNING id', [name, JSON.stringify(normalizeSettings(null)), userId])).rows[0] as { id: string };
        await tx.query(`INSERT INTO family_members (family_id, user_id, role, is_owner) VALUES ($1, $2, 'parent', true)`, [f.id, userId]);
        await audit(tx, f.id, 'family_created', userId, userId, { name }, client);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'family_members_user_key')) throw conflict('already_in_family', 'You are already in a family. Leave it first to create another.');
      throw err;
    }
    return overview(userId);
  }

  async function updateFamily(userId: string, input: { name?: string | undefined; settings?: { childrenCanLeave?: boolean | undefined } | undefined }, client: Client) {
    if (input.name === undefined && (input.settings === undefined || input.settings.childrenCanLeave === undefined)) throw badRequest('validation_failed', 'Nothing to change.');
    let name: string | null = null;
    if (input.name !== undefined) { name = cleanName(input.name, FAMILY_NAME_MAX); if (!name) throw badRequest('validation_failed', 'The request is not valid.', { fields: [{ field: 'name', message: `A family name of 1 to ${FAMILY_NAME_MAX} characters is required.` }] }); }
    await withFamilyTx(userId, async (tx, m) => {
      requirePermission(m, 'family.settings.update', 'You are not allowed to change the family settings.');
      const cur = (await tx.query<{ name: string; settings: unknown }>('SELECT name, settings FROM families WHERE id = $1 FOR UPDATE', [m.familyId])).rows[0];
      if (!cur) throw notFound('family_not_found', 'You are not in a family.');
      const settings: FamilySettings = normalizeSettings(cur.settings);
      const changed: string[] = [];
      if (name !== null && name !== cur.name) changed.push('name');
      if (input.settings?.childrenCanLeave !== undefined && input.settings.childrenCanLeave !== settings.childrenCanLeave) { settings.childrenCanLeave = input.settings.childrenCanLeave; changed.push('childrenCanLeave'); }
      if (changed.length === 0) return;                          // idempotent: nothing changed, nothing recorded
      await tx.query('UPDATE families SET name = $2, settings = $3 WHERE id = $1', [m.familyId, name ?? cur.name, JSON.stringify(settings)]);
      await audit(tx, m.familyId, 'family_updated', userId, null, { changed }, client);
    });
    return overview(userId);
  }

  // Only the owner. Deletes the family and everything that belongs to the family relationship (members, invitations, device links, sharing choices).
  // Accounts, devices, sessions and synchronised data of every member are untouched.
  async function dissolve(userId: string, client: Client) {
    return withFamilyTx(userId, async (tx, m) => {
      if (!m.isOwner) throw forbidden('owner_required', 'Only the family owner can delete the family.');
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM family_members WHERE family_id = $1', [m.familyId])).rows[0]?.n ?? 0;
      await audit(tx, m.familyId, 'family_dissolved', userId, null, { members: n }, client);
      await tx.query('DELETE FROM families WHERE id = $1', [m.familyId]);
      return { dissolved: true as const, members: n };
    });
  }

  // ---- members -------------------------------------------------------------------------------------------------------------------
  async function listMembers(userId: string) {
    const viewer = await requireMembership(pool, userId);
    requirePermission(viewer, 'members.view', 'You are not allowed to see the family members.');
    const rows = await loadAllMembers(pool, viewer.familyId);
    const ids = rows.map((r) => r.member_id);
    const sharing = await loadSharing(pool, ids);
    const canSeeDevices = viewer.permissions.has('devices.view');
    const deviceCounts = new Map<string, number>();
    for (const r of (await pool.query<{ member_id: string; n: number }>('SELECT fd.member_id, count(*)::int AS n FROM family_devices fd JOIN devices d ON d.id = fd.device_id WHERE fd.family_id = $1 AND d.revoked_at IS NULL GROUP BY fd.member_id', [viewer.familyId])).rows) deviceCounts.set(r.member_id, r.n);
    const members = rows.map((r) => {
      const isMe = r.member_id === viewer.memberId;
      const eff = effectivePermissions({ role: r.role, isOwner: r.is_owner, overrides: r.overrides });
      const decision = (c: PrivacyCategory) => canViewMemberData({ memberId: viewer.memberId, familyId: viewer.familyId, permissions: viewer.permissions }, { memberId: r.member_id, familyId: r.family_id, sharing: sharing.get(r.member_id) as Sharing }, c).allowed;
      return {
        memberId: r.member_id, petaliId: r.petali_id, displayName: r.display_name, role: r.role, isOwner: r.is_owner, isMe, joinedAt: r.joined_at.toISOString(),
        ...(isMe || viewer.permissions.has('members.permissions.manage') ? { permissions: [...eff].sort(), explicitPermissions: { grant: [...r.overrides.grant].sort(), deny: [...r.overrides.deny].sort() } } : {}),
        sharedWithYou: isMe ? [] : PRIVACY_CATEGORIES.filter(decision),
        deviceCount: isMe || canSeeDevices ? deviceCounts.get(r.member_id) ?? 0 : null,
      };
    });
    return { members };
  }

  async function removeMember(userId: string, memberId: string, client: Client) {
    return withFamilyTx(userId, async (tx, m) => {
      requirePermission(m, 'members.remove', 'You are not allowed to remove family members.');
      const target = await loadMember(tx, m.familyId, memberId);
      const can = canManageMember(m, { memberId: target.member_id, role: target.role, isOwner: target.is_owner });
      if (!can.ok) throw forbidden(can.code, can.code === 'cannot_manage_self' ? 'Use "Leave the family" to remove yourself.' : can.message);
      // Only rows of the family relationship go (membership, permissions, sharing choice, device links, hand-overs). The account, its devices and its
      // synchronised data are not touched, and the removed account loses every family capability with the commit of this transaction.
      await tx.query('DELETE FROM family_members WHERE id = $1 AND family_id = $2', [target.member_id, m.familyId]);
      await audit(tx, m.familyId, 'member_removed', userId, target.user_id, { role: target.role }, client);
      return { removed: true as const, memberId: target.member_id };
    });
  }

  async function leave(userId: string, client: Client) {
    return withFamilyTx(userId, async (tx, m) => {
      if (m.isOwner) {
        const others = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM family_members WHERE family_id = $1 AND id <> $2', [m.familyId, m.memberId])).rows[0]?.n ?? 0;
        if (others > 0) throw conflict('owner_must_transfer', 'You own this family. Transfer the ownership to another parent before you leave.');
        await audit(tx, m.familyId, 'family_dissolved', userId, null, { members: 1, reason: 'last_member_left' }, client);
        await tx.query('DELETE FROM families WHERE id = $1', [m.familyId]);       // the only member leaves: the family ends with it
        return { left: true as const, familyDissolved: true };
      }
      if (!isAdministratorRole(m.role)) {
        const f = (await tx.query<{ settings: unknown }>('SELECT settings FROM families WHERE id = $1', [m.familyId])).rows[0];
        if (!normalizeSettings(f?.settings).childrenCanLeave) throw forbidden('leave_not_permitted', 'This family does not allow children to leave on their own. Ask a parent to remove you.');
      }
      await tx.query('DELETE FROM family_members WHERE id = $1', [m.memberId]);
      await audit(tx, m.familyId, 'member_left', userId, userId, { role: m.role }, client);
      return { left: true as const, familyDissolved: false };
    });
  }

  async function changeRole(userId: string, memberId: string, role: string, client: Client) {
    if (!isRole(role)) throw badRequest('unknown_role', 'That role does not exist.');
    return withFamilyTx(userId, async (tx, m) => {
      requirePermission(m, 'members.roles.change', 'You are not allowed to change roles.');
      const target = await loadMember(tx, m.familyId, memberId);
      const can = canManageMember(m, { memberId: target.member_id, role: target.role, isOwner: target.is_owner });
      if (!can.ok) throw forbidden(can.code, can.code === 'cannot_manage_self' ? 'You cannot change your own role.' : can.message);
      if (target.role === role) return { memberId: target.member_id, role, changed: false };
      // Promoting to an administrator role also needs to be allowed to appoint one: only the owner appoints or demotes parents.
      if ((isAdministratorRole(role) || isAdministratorRole(target.role)) && !m.isOwner) throw forbidden('owner_required', 'Only the family owner can appoint or demote a parent.');
      await tx.query('UPDATE family_members SET role = $2 WHERE id = $1', [target.member_id, role]);
      await tx.query('DELETE FROM family_member_permissions WHERE member_id = $1', [target.member_id]);       // a new role starts from that role's defaults
      await audit(tx, m.familyId, 'role_changed', userId, target.user_id, { from: target.role, to: role }, client);
      return { memberId: target.member_id, role, changed: true };
    });
  }

  async function setPermissions(userId: string, memberId: string, input: { grant: string[]; deny: string[] }, client: Client) {
    const bad = [...input.grant, ...input.deny].filter((p) => !isPermission(p));
    if (bad.length > 0) throw badRequest('unknown_permission', 'Unknown permission.');
    const grant = [...new Set(input.grant)] as Permission[]; const deny = [...new Set(input.deny)] as Permission[];
    if (grant.some((p) => deny.includes(p))) throw badRequest('validation_failed', 'A permission cannot be granted and denied at once.');
    if (deny.some((p) => ALWAYS_GRANTED.includes(p))) throw badRequest('permission_not_revocable', 'That permission cannot be taken away.');
    return withFamilyTx(userId, async (tx, m) => {
      requirePermission(m, 'members.permissions.manage', 'You are not allowed to manage permissions.');
      const target = await loadMember(tx, m.familyId, memberId);
      const can = canManageMember(m, { memberId: target.member_id, role: target.role, isOwner: target.is_owner });
      if (!can.ok) throw forbidden(can.code, can.code === 'cannot_manage_self' ? 'You cannot change your own permissions.' : can.message);
      const admin = isAdministratorRole(target.role);
      if (!admin && grant.some((p) => NON_DELEGABLE.includes(p))) throw badRequest('permission_not_delegable', 'That permission can only be held by a parent.');
      const defaults = roleDefaults(target.role);
      const normalized = { grant: grant.filter((p) => !defaults.has(p)), deny: deny.filter((p) => defaults.has(p)) };      // only real differences from the role are stored
      const before = effectivePermissions({ role: target.role, isOwner: false, overrides: target.overrides });
      const after = effectivePermissions({ role: target.role, isOwner: false, overrides: normalized });
      // No privilege escalation: you can only hand out what you hold yourself.
      for (const p of after) if (!before.has(p) && !m.permissions.has(p)) throw forbidden('cannot_grant_unheld_permission', 'You cannot grant a permission you do not have yourself.');
      await tx.query('DELETE FROM family_member_permissions WHERE member_id = $1', [target.member_id]);
      for (const p of normalized.grant) await tx.query(`INSERT INTO family_member_permissions (member_id, permission, effect, set_by) VALUES ($1, $2, 'grant', $3)`, [target.member_id, p, userId]);
      for (const p of normalized.deny) await tx.query(`INSERT INTO family_member_permissions (member_id, permission, effect, set_by) VALUES ($1, $2, 'deny', $3)`, [target.member_id, p, userId]);
      await audit(tx, m.familyId, 'permissions_changed', userId, target.user_id, { grant: normalized.grant, deny: normalized.deny }, client);
      return { memberId: target.member_id, permissions: [...after].sort(), explicitPermissions: normalized };
    });
  }

  async function transferOwnership(userId: string, memberId: string, client: Client) {
    return withFamilyTx(userId, async (tx, m) => {
      if (!m.isOwner) throw forbidden('owner_required', 'Only the family owner can transfer the ownership.');
      const target = await loadMember(tx, m.familyId, memberId);
      if (target.member_id === m.memberId) throw badRequest('validation_failed', 'You already own this family.');
      if (!isAdministratorRole(target.role)) throw conflict('target_must_be_parent', 'Ownership can only be handed to a parent. Promote the member first.');
      await tx.query('UPDATE family_members SET is_owner = false WHERE id = $1', [m.memberId]);       // the previous owner stays a parent
      await tx.query('UPDATE family_members SET is_owner = true WHERE id = $1', [target.member_id]);  // the deferred trigger checks the end state at commit
      await tx.query('DELETE FROM family_member_permissions WHERE member_id = $1', [target.member_id]);
      await audit(tx, m.familyId, 'ownership_transferred', userId, target.user_id, {}, client);
      return { ownerMemberId: target.member_id, previousOwnerMemberId: m.memberId };
    });
  }

  // ---- individual sharing ----------------------------------------------------------------------------------------------------------
  // Only the member decides, for themselves. No role, not even the owner's, can change another member's choice.
  async function getMySharing(userId: string) {
    const m = await requireMembership(pool, userId);
    const s = (await loadSharing(pool, [m.memberId])).get(m.memberId) as Sharing;
    return { sharing: s, categories: [...PRIVACY_CATEGORIES] };
  }

  async function setMySharing(userId: string, patch: Partial<Record<PrivacyCategory, boolean>>, client: Client) {
    const keys = Object.keys(patch) as PrivacyCategory[];
    if (keys.length === 0) throw badRequest('validation_failed', 'Nothing to change.');
    return withFamilyTx(userId, async (tx, m) => {
      const cur = (await loadSharing(tx, [m.memberId])).get(m.memberId) as Sharing;
      const next: Sharing = { ...cur }; const changed: PrivacyCategory[] = [];
      for (const k of keys) { const v = patch[k]; if (typeof v === 'boolean' && next[k] !== v) { next[k] = v; changed.push(k); } }
      if (changed.length > 0) {
        await tx.query(`INSERT INTO family_member_privacy (member_id, sharing) VALUES ($1, $2) ON CONFLICT (member_id) DO UPDATE SET sharing = EXCLUDED.sharing, updated_at = now()`, [m.memberId, JSON.stringify(normalizeSharing(next))]);
        await audit(tx, m.familyId, 'sharing_updated', userId, userId, { categories: changed }, client, 'actor');     // which categories changed is the member's business, not the family's
      }
      return { sharing: next, categories: [...PRIVACY_CATEGORIES], changed };
    });
  }

  // What may THIS viewer read of that member, per category? This is the decision Stage 2 / 3 will use before returning any personal data.
  async function memberAccess(userId: string, memberId: string) {
    const viewer = await requireMembership(pool, userId);
    const target = await loadMember(pool, viewer.familyId, memberId);
    const sharing = (await loadSharing(pool, [target.member_id])).get(target.member_id) as Sharing;
    const categories = {} as Record<PrivacyCategory, { allowed: boolean; reason: string }>;
    for (const c of PRIVACY_CATEGORIES) { const d = canViewMemberData(viewer, { memberId: target.member_id, familyId: target.family_id, sharing }, c); categories[c] = { allowed: d.allowed, reason: d.reason }; }
    return { memberId: target.member_id, self: target.member_id === viewer.memberId, categories };
  }

  // ---- audit -----------------------------------------------------------------------------------------------------------------------
  async function listAudit(userId: string, limit: number, before?: number) {
    const m = await requireMembership(pool, userId);
    requirePermission(m, 'audit.view', 'You are not allowed to read the family history.');
    const r = await pool.query<{ id: string; action: string; detail: Record<string, unknown>; created_at: Date; actor_petali_id: string | null; actor_name: string | null; target_petali_id: string | null; target_name: string | null }>(
      `SELECT a.id::text, a.action, a.detail, a.created_at, au.petali_id AS actor_petali_id, au.display_name AS actor_name, tu.petali_id AS target_petali_id, tu.display_name AS target_name
       FROM family_audit_log a LEFT JOIN users au ON au.id = a.actor_user_id LEFT JOIN users tu ON tu.id = a.target_user_id
       WHERE a.family_id = $1 AND (a.audience = 'family' OR a.actor_user_id = $2) AND ($3::bigint IS NULL OR a.id < $3) ORDER BY a.id DESC LIMIT $4`, [m.familyId, userId, before ?? null, limit]);
    return {
      events: r.rows.map((e) => ({
        id: e.id, action: e.action, detail: e.detail, createdAt: e.created_at.toISOString(),
        actor: e.actor_petali_id ? { petaliId: e.actor_petali_id, displayName: e.actor_name } : null, target: e.target_petali_id ? { petaliId: e.target_petali_id, displayName: e.target_name } : null,
      })),
      nextBefore: r.rows.length === limit ? r.rows[r.rows.length - 1]?.id ?? null : null,
    };
  }

  return { overview, createFamily, updateFamily, dissolve, listMembers, removeMember, leave, changeRole, setPermissions, transferOwnership, getMySharing, setMySharing, memberAccess, listAudit, withFamilyTx };
}
export type FamilyService = ReturnType<typeof createFamilyService>;
export { PERMISSIONS };
