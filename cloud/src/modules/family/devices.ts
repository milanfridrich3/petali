import type { Pool, PoolClient } from 'pg';
import type { Config } from '../../config/env';
import { withTransaction } from '../../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { deviceDto, loadDevice, MAX_DEVICES, type DeviceRow } from '../devices/access';
import { audit, gone, loadMember, loadMembership, loadSharing, requireMembership, requirePermission, type Client, type Membership } from './access';
import { canManageMember, canViewMemberData, type Sharing } from './permissions';
import type { FamilyService } from './service';

// Family devices.
//
// A device always stays a row of "devices" that belongs to ONE Petali ID account (its real owner). The family only holds a LINK that the owner creates
// to show the device to the family. Consequences, enforced here and by the database:
//   * only the owner of a device can link it; a parent cannot link, take or "adopt" a child's device,
//   * what a viewer sees about a linked device depends on the owner's consent (deviceInfo): without it the viewer sees which member owns a device and its
//     name, not its status, last synchronisation or hardware,
//   * removing a member, leaving or deleting the family only deletes links; the devices, their sessions and their synchronised data stay with their owner,
//   * changing who owns a device is a two-sided hand-over (transfer): the owner offers, the receiving member accepts, nothing else can do it.
export function createFamilyDeviceService(deps: { pool: Pool; config: Config; family: FamilyService; now?: () => number }) {
  const { pool, config, family } = deps;
  const now = deps.now ?? Date.now;
  const lockKey = (tx: PoolClient, key: string) => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

  type Row = DeviceRow & { fd_member_id: string | null; linked_at: Date | null };

  // ---- my own devices (to choose what to link) -----------------------------------------------------------------------------------------
  async function listMine(userId: string) {
    const m = await requireMembership(pool, userId);
    const r = await pool.query<Row>(`SELECT d.*, fd.member_id AS fd_member_id, fd.linked_at FROM devices d LEFT JOIN family_devices fd ON fd.device_id = d.id AND fd.family_id = $2
      WHERE d.user_id = $1 AND d.revoked_at IS NULL ORDER BY d.created_at`, [userId, m.familyId]);
    const pend = await pool.query<{ device_id: string; id: string; to_member_id: string }>(`SELECT id, device_id, to_member_id FROM family_device_transfers WHERE from_member_id = $1 AND status = 'pending' AND expires_at > $2`, [m.memberId, new Date(now())]);
    return {
      devices: r.rows.map((d) => ({
        ...deviceDto(d, now()), linked: d.fd_member_id !== null, linkedAt: d.linked_at ? d.linked_at.toISOString() : null,
        pendingTransfer: pend.rows.find((p) => p.device_id === d.id) ? { id: (pend.rows.find((p) => p.device_id === d.id) as { id: string }).id, toMemberId: (pend.rows.find((p) => p.device_id === d.id) as { to_member_id: string }).to_member_id } : null,
      })),
    };
  }

  async function link(userId: string, deviceId: string, client: Client) {
    return family.withFamilyTx(userId, async (tx, m) => {
      const d = await loadDevice(tx, userId, deviceId, { forUpdate: true });                       // owner-scoped: a device of somebody else is "not found"
      const existing = (await tx.query<{ member_id: string }>('SELECT member_id FROM family_devices WHERE device_id = $1', [d.id])).rows[0];
      if (existing) return { linked: true as const, changed: false };
      await tx.query('INSERT INTO family_devices (device_id, family_id, member_id, linked_by) VALUES ($1,$2,$3,$4)', [d.id, m.familyId, m.memberId, userId]);
      await audit(tx, m.familyId, 'device_linked', userId, userId, { deviceId: d.id }, client);
      return { linked: true as const, changed: true };
    });
  }

  // The owner can always take their own device out of the family view. A parent with devices.unlink can do it for a member too (it only hides the device
  // from the family: nothing is deleted, nothing changes owner), but only the family owner for another parent's device.
  async function unlink(userId: string, deviceId: string, client: Client) {
    return family.withFamilyTx(userId, async (tx, m) => {
      const row = (await tx.query<{ member_id: string; user_id: string; role: string; is_owner: boolean }>(
        `SELECT fd.member_id, fm.user_id, fm.role, fm.is_owner FROM family_devices fd JOIN family_members fm ON fm.id = fd.member_id WHERE fd.device_id = $1 AND fd.family_id = $2 FOR UPDATE OF fd`, [deviceId, m.familyId])).rows[0];
      if (!row) throw notFound('device_not_found', 'Device not found.');
      if (row.member_id !== m.memberId) {
        requirePermission(m, 'devices.unlink', 'You are not allowed to take other members\' devices out of the family.');
        const can = canManageMember(m, { memberId: row.member_id, role: row.role, isOwner: row.is_owner });
        if (!can.ok) throw forbidden(can.code, can.message);
      }
      await tx.query('DELETE FROM family_devices WHERE device_id = $1', [deviceId]);
      await tx.query(`UPDATE family_device_transfers SET status = 'cancelled', responded_at = $2 WHERE device_id = $1 AND status = 'pending'`, [deviceId, new Date(now())]);
      await audit(tx, m.familyId, 'device_unlinked', userId, row.user_id, { deviceId }, client);
      return { linked: false as const, changed: true };
    });
  }

  // ---- what the family sees ------------------------------------------------------------------------------------------------------------
  async function listFamily(userId: string, onlyMemberId?: string) {
    const m = await requireMembership(pool, userId);
    if (onlyMemberId) {
      const t = await loadMember(pool, m.familyId, onlyMemberId);                                   // a member of another family is "not found"
      if (t.member_id !== m.memberId) requirePermission(m, 'devices.view', 'You are not allowed to see other members\' devices.');
    }
    const canAll = m.permissions.has('devices.view');
    const r = await pool.query<Row & { member_id: string; petali_id: string; display_name: string | null; role: string; family_id: string }>(
      `SELECT d.*, fd.member_id AS fd_member_id, fd.linked_at, fm.id AS member_id, fm.role, fm.family_id, u.petali_id, u.display_name
       FROM family_devices fd JOIN devices d ON d.id = fd.device_id AND d.revoked_at IS NULL JOIN family_members fm ON fm.id = fd.member_id JOIN users u ON u.id = fm.user_id
       WHERE fd.family_id = $1 AND ($2::uuid IS NULL OR fd.member_id = $2) ORDER BY u.display_name NULLS LAST, fd.linked_at, d.id`, [m.familyId, onlyMemberId ?? null]);
    const sharing = await loadSharing(pool, [...new Set(r.rows.map((x) => x.member_id))]);
    const pend = await pool.query<{ device_id: string; id: string; to_member_id: string }>(`SELECT id, device_id, to_member_id FROM family_device_transfers WHERE family_id = $1 AND status = 'pending' AND expires_at > $2`, [m.familyId, new Date(now())]);
    const devices = r.rows.filter((d) => canAll || d.member_id === m.memberId).map((d) => {
      const isMine = d.member_id === m.memberId;
      const visible = canViewMemberData(m, { memberId: d.member_id, familyId: d.family_id, sharing: sharing.get(d.member_id) as Sharing }, 'deviceInfo');
      const base = deviceDto(d, now());
      const involved = isMine || pend.rows.some((p) => p.device_id === d.id && p.to_member_id === m.memberId);
      const p = involved ? pend.rows.find((x) => x.device_id === d.id) : undefined;
      return {
        id: d.id, name: d.name, isMine, linkedAt: d.linked_at ? d.linked_at.toISOString() : null,
        owner: { memberId: d.member_id, petaliId: d.petali_id, displayName: d.display_name, role: d.role },
        // The owner's consent decides this block; the reason tells the interface what to say instead (never a guess about the device).
        detail: visible.allowed ? { status: base.status, lastSeenAt: base.lastSeenAt, lastSyncAt: base.lastSyncAt, platform: base.platform, appVersion: base.appVersion, hardware: base.hardware, addedAt: base.createdAt } : null,
        detailHidden: !visible.allowed, detailReason: visible.reason,
        pendingTransfer: p ? { id: p.id, toMemberId: p.to_member_id } : null,
      };
    });
    return { devices };
  }

  // ---- ownership transfer --------------------------------------------------------------------------------------------------------------
  type TRow = { id: string; family_id: string; device_id: string; from_member_id: string; to_member_id: string; status: string; expires_at: Date; created_at: Date; responded_at: Date | null };
  const tEffective = (t: TRow) => (t.status === 'pending' && t.expires_at.getTime() <= now() ? 'expired' : t.status);

  async function createTransfer(userId: string, deviceId: string, toMemberId: string, client: Client) {
    return family.withFamilyTx(userId, async (tx, m) => {
      // Only the OWNER can offer a device. The lookup is by (device AND owner AND this family's link): a parent cannot start a hand-over of a child's device.
      const d = (await tx.query<DeviceRow>(`SELECT d.* FROM devices d JOIN family_devices fd ON fd.device_id = d.id WHERE d.id = $1 AND d.user_id = $2 AND fd.family_id = $3 AND d.revoked_at IS NULL FOR UPDATE OF d`, [deviceId, userId, m.familyId])).rows[0];
      if (!d) throw notFound('device_not_found', 'Device not found, or it is not linked to your family.');
      const to = await loadMember(tx, m.familyId, toMemberId);
      if (to.member_id === m.memberId) throw badRequest('cannot_transfer_to_self', 'Choose another member.');
      const t = new Date(now());
      await tx.query(`UPDATE family_device_transfers SET status = 'expired', responded_at = $2 WHERE device_id = $1 AND status = 'pending' AND expires_at <= $2`, [d.id, t]);
      if ((await tx.query(`SELECT 1 FROM family_device_transfers WHERE device_id = $1 AND status = 'pending'`, [d.id])).rowCount) throw conflict('transfer_exists', 'This device already has an open hand-over. Cancel it first.');
      const row = (await tx.query<TRow>(`INSERT INTO family_device_transfers (family_id, device_id, from_member_id, to_member_id, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [m.familyId, d.id, m.memberId, to.member_id, new Date(now() + config.family.transferTtlMs)])).rows[0] as TRow;
      await audit(tx, m.familyId, 'device_transfer_offered', userId, to.user_id, { transferId: row.id, deviceId: d.id }, client);
      return { transfer: await transferDto(tx, row.id) };
    });
  }

  async function transferDto(db: Pool | PoolClient, id: string) {
    const r = await db.query<TRow & { device_name: string; from_petali_id: string; from_name: string | null; to_petali_id: string; to_name: string | null }>(
      `SELECT t.*, d.name AS device_name, fu.petali_id AS from_petali_id, fu.display_name AS from_name, tu.petali_id AS to_petali_id, tu.display_name AS to_name
       FROM family_device_transfers t JOIN devices d ON d.id = t.device_id JOIN family_members fm ON fm.id = t.from_member_id JOIN users fu ON fu.id = fm.user_id
       JOIN family_members tm ON tm.id = t.to_member_id JOIN users tu ON tu.id = tm.user_id WHERE t.id = $1`, [id]);
    const t = r.rows[0] as NonNullable<(typeof r.rows)[0]>;
    return {
      id: t.id, status: tEffective(t), createdAt: t.created_at.toISOString(), expiresAt: t.expires_at.toISOString(), respondedAt: t.responded_at ? t.responded_at.toISOString() : null,
      device: { id: t.device_id, name: t.device_name },
      from: { memberId: t.from_member_id, petaliId: t.from_petali_id, displayName: t.from_name }, to: { memberId: t.to_member_id, petaliId: t.to_petali_id, displayName: t.to_name },
    };
  }

  // Only the two parties see a hand-over: not even a parent sees other members' offers.
  async function listTransfers(userId: string) {
    const m = await requireMembership(pool, userId);
    const r = await pool.query<{ id: string }>(`SELECT id FROM family_device_transfers WHERE family_id = $1 AND (from_member_id = $2 OR to_member_id = $2) AND (status = 'pending' OR responded_at > $3) ORDER BY created_at DESC LIMIT 50`,
      [m.familyId, m.memberId, new Date(now() - 30 * 86_400_000)]);
    const out = []; for (const x of r.rows) out.push(await transferDto(pool, x.id));
    return { transfers: out };
  }

  async function ownTransfer(tx: PoolClient, m: Membership, id: string, side: 'from' | 'to'): Promise<TRow> {
    const col = side === 'from' ? 'from_member_id' : 'to_member_id';
    const r = await tx.query<TRow>(`SELECT * FROM family_device_transfers WHERE id = $1 AND family_id = $2 AND ${col} = $3 FOR UPDATE`, [id, m.familyId, m.memberId]);
    if (!r.rows[0]) throw notFound('transfer_not_found', 'Hand-over not found.');
    return r.rows[0];
  }

  async function closeTransfer(userId: string, id: string, side: 'from' | 'to', status: 'cancelled' | 'declined', client: Client) {
    return family.withFamilyTx(userId, async (tx, m) => {
      const t = await ownTransfer(tx, m, id, side);
      if (tEffective(t) !== 'pending') { if (t.status === status) return { transfer: await transferDto(tx, id), changed: false }; throw conflict('transfer_not_pending', `This hand-over is already ${tEffective(t)}.`); }
      await tx.query(`UPDATE family_device_transfers SET status = $2, responded_at = $3 WHERE id = $1`, [id, status, new Date(now())]);
      await audit(tx, m.familyId, status === 'cancelled' ? 'device_transfer_cancelled' : 'device_transfer_declined', userId, null, { transferId: id, deviceId: t.device_id }, client);
      return { transfer: await transferDto(tx, id), changed: true };
    });
  }

  // The receiving member accepts: the device (with its own cloud history) moves to their account. Everything happens in one transaction under the locks of
  // both accounts' device and sync work (taken in a fixed order), so no upload can be half-way through while the device changes owner.
  async function acceptTransfer(userId: string, id: string, client: Client) {
    const pre = (await pool.query<{ from_user: string; family_id: string }>(
      `SELECT fm.user_id AS from_user, t.family_id FROM family_device_transfers t JOIN family_members fm ON fm.id = t.from_member_id WHERE t.id = $1`, [id])).rows[0];
    if (!pre) throw notFound('transfer_not_found', 'Hand-over not found.');
    const result = await withTransaction(pool, async (tx) => {
      const keys = [...new Set([`devices:${userId}`, `sync:${userId}`, `devices:${pre.from_user}`, `sync:${pre.from_user}`])].sort();
      await lockKey(tx, `family:${pre.family_id}`);
      for (const k of keys) await lockKey(tx, k);
      const me = await loadMembership(tx, userId);
      if (!me || me.familyId !== pre.family_id) throw notFound('transfer_not_found', 'Hand-over not found.');
      const t = await ownTransfer(tx, me, id, 'to');
      const st = tEffective(t);
      if (st === 'expired' && t.status === 'pending') { await tx.query(`UPDATE family_device_transfers SET status = 'expired', responded_at = $2 WHERE id = $1`, [id, new Date(now())]); return { kind: 'expired' as const }; }
      if (st === 'accepted') return { kind: 'used' as const };
      if (st !== 'pending') return { kind: 'closed' as const, status: st };

      const from = (await tx.query<{ user_id: string }>('SELECT user_id FROM family_members WHERE id = $1 AND family_id = $2', [t.from_member_id, t.family_id])).rows[0];
      const dev = (await tx.query<DeviceRow>('SELECT * FROM devices WHERE id = $1 FOR UPDATE', [t.device_id])).rows[0];
      const link = (await tx.query<{ member_id: string }>('SELECT member_id FROM family_devices WHERE device_id = $1 AND family_id = $2', [t.device_id, t.family_id])).rows[0];
      // The offer is only valid while the offerer still owns the device, it is still linked by them, and it was not removed in the meantime.
      if (!from || !dev || dev.revoked_at || dev.user_id !== from.user_id || !link || link.member_id !== t.from_member_id) {
        await tx.query(`UPDATE family_device_transfers SET status = 'cancelled', responded_at = $2 WHERE id = $1`, [id, new Date(now())]);
        return { kind: 'invalid' as const };
      }
      const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0]?.n ?? 0;
      if (count >= MAX_DEVICES) throw conflict('device_limit', `An account can have at most ${MAX_DEVICES} devices.`);
      if (dev.client_device_id && (await tx.query('SELECT 1 FROM devices WHERE user_id = $1 AND client_device_id = $2', [userId, dev.client_device_id])).rowCount) throw conflict('transfer_conflict', 'You already have a record of this computer. It cannot be handed over to you.');
      const used = Number((await tx.query<{ b: string }>('SELECT COALESCE(sum(size_bytes), 0)::text AS b FROM sync_documents WHERE user_id = $1', [userId])).rows[0]?.b ?? 0);
      const moving = Number((await tx.query<{ b: string }>('SELECT COALESCE(sum(size_bytes), 0)::text AS b FROM sync_documents WHERE user_id = $1 AND device_id = $2', [from.user_id, dev.id])).rows[0]?.b ?? 0);
      if (used + moving > config.sync.userQuotaBytes) throw conflict('quota_exceeded', 'Your cloud storage is too full to receive this computer\'s history.');

      // 1. the device itself changes account; the epoch moves so the previous owner's computer can no longer upload for it
      await tx.query('UPDATE devices SET user_id = $2, epoch = epoch + 1 WHERE id = $1', [dev.id, userId]);
      // 2. its own history goes with it (device-scoped documents only: the previous owner's account-wide data, such as plant growth and settings, stays theirs)
      await tx.query(`UPDATE sync_documents SET user_id = $3, change_seq = nextval('sync_change_seq') WHERE device_id = $1 AND user_id = $2`, [dev.id, from.user_id, userId]);
      // 3. the previous owner's sign-ins that were bound to this computer end (the computer must sign in as its new owner)
      await tx.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'device_transferred' WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [from.user_id, dev.id]);
      // 4. the family link follows the owner (the database trigger re-checks that the new member really owns the device)
      await tx.query('UPDATE family_devices SET member_id = $2, linked_by = $3, linked_at = now() WHERE device_id = $1', [dev.id, me.memberId, userId]);
      await tx.query(`UPDATE family_device_transfers SET status = 'accepted', responded_at = $2 WHERE id = $1`, [id, new Date(now())]);
      await audit(tx, t.family_id, 'device_transferred', userId, from.user_id, { transferId: id, deviceId: dev.id }, client);
      return { kind: 'accepted' as const };
    });
    switch (result.kind) {
      case 'expired': throw gone('transfer_expired', 'This hand-over has expired.');
      case 'closed': throw gone(`transfer_${result.status}`, `This hand-over was ${result.status}.`);
      case 'used': throw conflict('transfer_already_used', 'This hand-over was already completed.');
      case 'invalid': throw conflict('transfer_invalid', 'This device can no longer be handed over (it was removed or changed owner).');
      default: return { transfer: await transferDto(pool, id), changed: true };
    }
  }

  return {
    listMine, link, unlink, listFamily, createTransfer, listTransfers, acceptTransfer,
    declineTransfer: (userId: string, id: string, client: Client) => closeTransfer(userId, id, 'to', 'declined', client),
    cancelTransfer: (userId: string, id: string, client: Client) => closeTransfer(userId, id, 'from', 'cancelled', client),
  };
}
export type FamilyDeviceService = ReturnType<typeof createFamilyDeviceService>;
