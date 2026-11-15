import type { Pool, PoolClient } from 'pg';
import { AppError, notFound } from '../../lib/errors';

// Shared by the sync module and the device management module, so that "does this device belong to this account, and is it
// still allowed to act?" is decided in exactly ONE place.
export type Db = Pool | PoolClient;
export type DeviceRow = {
  id: string; user_id: string; client_device_id: string | null; name: string; platform: string | null; app_version: string | null; hardware: unknown;
  epoch: number; last_seen_at: Date | null; last_sync_at: Date | null; revoked_at: Date | null; created_at: Date;
  name_customized: boolean; name_updated_at: Date | null; history_purged_at: Date | null;
};

export const MAX_DEVICES = 20;
// A computer syncs at least every 5 minutes while it is running and signed in, so 15 minutes of silence means it is not running now.
export const ACTIVE_WINDOW_MS = 15 * 60_000;
// A computer that is switched off overnight or at the weekend is simply offline; after 3 days it has "not synchronised recently".
export const STALE_AFTER_MS = 3 * 86_400_000;

export type DeviceStatus = 'removed' | 'never' | 'active' | 'offline' | 'stale';

// removed: taken off the account. never: registered but never synchronised. active / offline / stale: see the two constants.
export function deviceStatus(d: DeviceRow, nowMs: number): DeviceStatus {
  if (d.revoked_at) return 'removed';
  const seen = Math.max(d.last_seen_at?.getTime() ?? 0, d.last_sync_at?.getTime() ?? 0);
  if (!seen) return 'never';
  const age = nowMs - seen;
  return age <= ACTIVE_WINDOW_MS ? 'active' : age <= STALE_AFTER_MS ? 'offline' : 'stale';
}

export function deviceDto(d: DeviceRow, nowMs: number) {
  return {
    id: d.id, name: d.name, platform: d.platform, appVersion: d.app_version, hardware: d.hardware ?? null, epoch: d.epoch,
    createdAt: d.created_at.toISOString(), lastSeenAt: d.last_seen_at ? d.last_seen_at.toISOString() : null, lastSyncAt: d.last_sync_at ? d.last_sync_at.toISOString() : null,
    status: deviceStatus(d, nowMs), nameCustomized: d.name_customized, removedAt: d.revoked_at ? d.revoked_at.toISOString() : null, historyDeleted: !!d.history_purged_at,
  };
}

// The ONLY way a request turns a device id into a device. The row is looked up by (id AND user_id) from the verified token, so a device id
// of another account behaves exactly like an unknown one (404, nothing leaks). A device of THIS account that was removed is refused with
// 403 device_removed (unless the caller explicitly deals with removed devices): a removed computer must not keep synchronising.
export async function loadDevice(db: Db, userId: string, deviceId: string, opts: { allowRemoved?: boolean; forUpdate?: boolean } = {}): Promise<DeviceRow> {
  const r = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1 AND user_id = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`, [deviceId, userId]);
  const d = r.rows[0];
  if (!d) throw notFound('device_not_found', 'Device not found.');
  if (d.revoked_at && !opts.allowRemoved) throw new AppError(403, 'device_removed', 'This computer was removed from the account.');
  return d;
}

// Keeps "last seen" honest for computers that have nothing to upload: any authenticated sync request counts, at most once a minute per device.
export async function touchDevice(db: Db, deviceId: string): Promise<void> {
  await db.query(`UPDATE devices SET last_seen_at = now(), last_sync_at = now() WHERE id = $1 AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')`, [deviceId]);
}

// The account session that registers / claims a device is bound to it, so removing the device can end that session too.
export async function bindSession(db: Db, userId: string, sessionId: string, deviceId: string): Promise<void> {
  await db.query('UPDATE sessions SET device_id = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [sessionId, userId, deviceId]);
}

// Adds what the UI needs to a list of devices: how much of each kind is in the cloud, the last usage day, active time of the last 7 days.
export async function enrichDevices(db: Db, userId: string, rows: DeviceRow[], clientDeviceId: string | undefined, nowMs: number) {
  if (rows.length === 0) return [];
  const counts = await db.query<{ device_id: string; kind: string; n: number; last_key: string }>(
    `SELECT device_id, kind, count(*)::int AS n, max(doc_key) AS last_key FROM sync_documents WHERE user_id = $1 AND device_id IS NOT NULL AND NOT deleted GROUP BY device_id, kind`, [userId]);
  const since = new Date(nowMs - 7 * 86_400_000).toISOString().slice(0, 10);
  const usage = await db.query<{ device_id: string; ms: string }>(
    `SELECT device_id, COALESCE(sum((data->>'activeMs')::numeric), 0)::text AS ms FROM sync_documents WHERE user_id = $1 AND kind = 'day' AND NOT deleted AND doc_key >= $2 GROUP BY device_id`, [userId, since]);
  return rows.map((d) => {
    const mine = counts.rows.filter((c) => c.device_id === d.id);
    const docCounts: Record<string, number> = {}; for (const c of mine) docCounts[c.kind] = c.n;
    return { ...deviceDto(d, nowMs), removed: !!d.revoked_at, current: !!clientDeviceId && d.client_device_id === clientDeviceId, docCounts, lastUsageDay: mine.find((c) => c.kind === 'day')?.last_key ?? null, activeMsLast7Days: Number(usage.rows.find((u) => u.device_id === d.id)?.ms ?? 0) };
  });
}
