import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool';
import { conflict } from '../../lib/errors';
import type { AuthService } from '../auth/service';
import { deviceDto, enrichDevices, loadDevice, type DeviceRow } from './access';
import { buildSummary } from './summary';

type Client = { ip: string | null; userAgent: string | null };
const SKEW_MS = 5 * 60_000;

// Device management for the signed-in account. Every operation takes the user id of the VERIFIED token and looks the device up by
// (device id AND that user id): a device of another account is indistinguishable from one that does not exist.
export function createDeviceService(deps: { pool: Pool; auth: AuthService; now?: () => number }) {
  const { pool, auth } = deps;
  const now = deps.now ?? Date.now;

  async function list(userId: string, q: { clientDeviceId?: string | undefined; includeRemoved: boolean }) {
    const rows = await pool.query<DeviceRow>(`SELECT * FROM devices WHERE user_id = $1${q.includeRemoved ? '' : ' AND revoked_at IS NULL'} ORDER BY revoked_at IS NOT NULL, created_at`, [userId]);
    return { devices: await enrichDevices(pool, userId, rows.rows, q.clientDeviceId, now()), serverTime: new Date(now()).toISOString() };
  }

  async function detail(userId: string, deviceId: string, clientDeviceId?: string) {
    const d = await loadDevice(pool, userId, deviceId, { allowRemoved: true });
    const [dto] = await enrichDevices(pool, userId, [d], clientDeviceId, now());
    const size = await pool.query<{ b: string }>('SELECT COALESCE(sum(size_bytes), 0)::text AS b FROM sync_documents WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
    return { device: { ...dto, storageBytes: Number(size.rows[0]?.b ?? 0) }, serverTime: new Date(now()).toISOString() };
  }

  // Rename. Idempotent (same name = "unchanged") and ordered by the client's clock like account settings (an older queued rename that
  // arrives late is "superseded" and cannot undo a newer one). The name is the display name only; it never identifies the computer.
  async function rename(userId: string, deviceId: string, input: { name: string; clientUpdatedAt?: string | undefined }) {
    return withTransaction(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`devices:${userId}`]);
      const d = await loadDevice(tx, userId, deviceId, { forUpdate: true });
      let ts = input.clientUpdatedAt ? Date.parse(input.clientUpdatedAt) : now();
      if (!Number.isFinite(ts) || ts < Date.parse('2020-01-01T00:00:00Z')) ts = NaN;
      if (Number.isNaN(ts)) throw conflict('invalid_timestamp', 'clientUpdatedAt is not a valid time.');
      ts = Math.min(ts, now() + SKEW_MS);
      if (d.name === input.name && d.name_customized) return { outcome: 'unchanged' as const, device: deviceDto(d, now()) };
      if (d.name_updated_at && ts < d.name_updated_at.getTime()) return { outcome: 'superseded' as const, device: deviceDto(d, now()) };
      const r = await tx.query<DeviceRow>('UPDATE devices SET name = $3, name_customized = true, name_updated_at = $4 WHERE id = $1 AND user_id = $2 RETURNING *', [deviceId, userId, input.name, new Date(ts)]);
      return { outcome: 'applied' as const, device: deviceDto(r.rows[0] as DeviceRow, now()) };
    });
  }

  // Remove a device from the account.
  //   * The device is REVOKED, never hard-deleted: sync endpoints refuse it from now on (403 device_removed) and the account sessions bound to it end.
  //   * Cloud history: kept by default (it can be restored by reinstalling Petali on that computer and choosing to restore it). With
  //     deleteCloudHistory every document of that device is deleted for good, EXCEPT its plant ledger: plant growth belongs to the whole account
  //     and must never shrink.
  //   * The computer's own local data is never touched (the server has no access to it).
  //   * Removing the computer the request comes from needs allowCurrent: true, so it can never happen by accident.
  //   * Repeating the request changes nothing ("alreadyRemoved"); a repeat may still add the history deletion that was not requested before.
  async function remove(userId: string, deviceId: string, input: { currentDeviceId?: string | undefined; allowCurrent?: boolean | undefined; deleteCloudHistory?: boolean | undefined }, client: Client, sessionId: string) {
    return withTransaction(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`devices:${userId}`]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sync:${userId}`]);       // no push can be half-way through while the device is revoked
      const d = await loadDevice(tx, userId, deviceId, { allowRemoved: true, forUpdate: true });
      const alreadyRemoved = !!d.revoked_at;
      let revokedSessions = 0;
      if (!alreadyRemoved) {
        // "The computer you are using" is what the SERVER knows (the session of this request is bound to a device), not only what the client claims.
        const bound = (await tx.query<{ device_id: string | null }>('SELECT device_id FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, userId])).rows[0]?.device_id ?? null;
        if ((bound === d.id || input.currentDeviceId === d.id) && input.allowCurrent !== true) throw conflict('cannot_remove_current_device', 'This is the computer you are using. Confirm explicitly to remove it and stop syncing it.');
        await tx.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2', [deviceId, userId]);
        // Petali Family: a removed computer disappears from the family view and its open hand-over (if any) ends. Nothing else of the family is touched.
        await tx.query('DELETE FROM family_devices WHERE device_id = $1', [deviceId]);
        await tx.query(`UPDATE family_device_transfers SET status = 'cancelled', responded_at = now() WHERE device_id = $1 AND status = 'pending'`, [deviceId]);
        const ended = await tx.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'device_removed' WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL", [userId, deviceId]);
        revokedSessions = ended.rowCount ?? 0;
        await auth.recordEvent(tx, userId, 'session_revoked', client, sessionId, `device removed (${revokedSessions} session(s))`);
      }
      let purged = false;
      if (input.deleteCloudHistory === true && !d.history_purged_at) {
        await tx.query("DELETE FROM sync_documents WHERE user_id = $1 AND device_id = $2 AND kind <> 'plant'", [userId, deviceId]);
        await tx.query('UPDATE devices SET history_purged_at = now() WHERE id = $1 AND user_id = $2', [deviceId, userId]);
        purged = true;
      }
      const fresh = (await tx.query<DeviceRow>('SELECT * FROM devices WHERE id = $1', [deviceId])).rows[0] as DeviceRow;
      return { device: deviceDto(fresh, now()), alreadyRemoved, historyDeletedNow: purged, revokedSessions };
    });
  }

  async function summary(userId: string, deviceId: string, days: number) {
    const d = await loadDevice(pool, userId, deviceId, { allowRemoved: true });
    return { device: deviceDto(d, now()), summary: await buildSummary(pool, userId, deviceId, days, now()), serverTime: new Date(now()).toISOString() };
  }

  return { list, detail, rename, remove, summary };
}
export type DeviceService = ReturnType<typeof createDeviceService>;
