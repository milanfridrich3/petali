import type { Pool, PoolClient } from 'pg';
import type { Config } from '../../config/env';
import { withTransaction } from '../../db/pool';
import { badRequest, conflict, notFound, AppError } from '../../lib/errors';
import { bindSession, deviceDto, enrichDevices, loadDevice, touchDevice, MAX_DEVICES, type DeviceRow } from '../devices/access';
import { canonicalize, hashOf } from './canonical';
import { KINDS } from './kinds';
import { mergeDocument } from './merge';

export type PushOp = { kind: string; key: string; scope: 'account' | 'device'; clientUpdatedAt: string; data?: unknown; deleted?: boolean };
export type OpResult =
  | { kind: string; key: string; scope: string; outcome: 'applied' | 'unchanged'; seq?: number; cloudAhead?: boolean }
  | { kind: string; key: string; scope: string; outcome: 'superseded'; current: { data: unknown; deleted: boolean; clientUpdatedAt: string } }
  | { kind: string; key: string; scope: string; outcome: 'rejected'; reason: string };

type DocRow = { id: string; device_id: string | null; kind: string; doc_key: string; data: unknown; deleted: boolean; data_hash: string; size_bytes: number; client_updated_at: Date; written_by_device: string | null; change_seq: string };

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const SKEW_MS = 5 * 60_000;
const NIL = '00000000-0000-0000-0000-000000000000';
const UNCHANGED_AT = Date.parse('2020-01-02T00:00:00.000Z');

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createSyncService(deps: { pool: Pool; config: Config; now?: () => number }) {
  const { pool, config } = deps;
  const now = deps.now ?? Date.now;

  const ownDevice = (db: Pool | PoolClient, userId: string, deviceId: string) => loadDevice(db, userId, deviceId);

  // A computer (installation id) belongs to exactly ONE account at a time. Not a unique index on purpose: Phase 2 data may already hold the
  // same id under two accounts (a computer that switched accounts), and a migration must never fail on or rewrite existing rows. Those old
  // rows keep working; only a NEW registration / claim of an id that is active elsewhere is refused. A global lock per id closes the race.
  async function assertInstallationFree(tx: PoolClient, userId: string, clientDeviceId: string) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`client:${clientDeviceId}`]);
    const other = await tx.query('SELECT 1 FROM devices WHERE client_device_id = $1 AND user_id <> $2 AND revoked_at IS NULL LIMIT 1', [clientDeviceId, userId]);
    if (other.rowCount) throw conflict('device_in_use_by_another_account', 'This computer is currently connected to another Petali account.');
  }

  // ---- devices ------------------------------------------------------------------------------------------------
  async function registerDevice(userId: string, sessionId: string, input: { clientDeviceId: string; name: string; platform?: string | undefined; appVersion?: string | undefined; hardware?: Record<string, unknown> | undefined; reactivate?: boolean | undefined }) {
    return withTransaction(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`devices:${userId}`]);
      await assertInstallationFree(tx, userId, input.clientDeviceId);
      const existing = (await tx.query<DeviceRow>('SELECT * FROM devices WHERE user_id = $1 AND client_device_id = $2', [userId, input.clientDeviceId])).rows[0];
      // A removed computer can never bring itself back silently: coming back is an explicit decision of the user (reactivate: true).
      if (existing?.revoked_at && input.reactivate !== true) throw conflict('device_removed', 'This computer was removed from the account. Add it again explicitly to continue.');
      if (!existing || existing.revoked_at) {
        const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
        if ((count.rows[0]?.n ?? 0) >= MAX_DEVICES) throw conflict('device_limit', `An account can have at most ${MAX_DEVICES} devices.`);
      }
      // The name the user chose is never replaced by the host name the app sends automatically.
      const r = await tx.query<DeviceRow & { created: boolean }>(
        `INSERT INTO devices (user_id, client_device_id, name, platform, app_version, hardware, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (user_id, client_device_id) WHERE client_device_id IS NOT NULL
         DO UPDATE SET name = CASE WHEN devices.name_customized THEN devices.name ELSE EXCLUDED.name END, platform = EXCLUDED.platform, app_version = EXCLUDED.app_version,
           hardware = COALESCE(EXCLUDED.hardware, devices.hardware), last_seen_at = now(), revoked_at = NULL, history_purged_at = NULL
         RETURNING *, (xmax = 0) AS created`,
        [userId, input.clientDeviceId, input.name, input.platform ?? null, input.appVersion ?? null, input.hardware ? JSON.stringify(input.hardware) : null]);
      const row = r.rows[0] as DeviceRow & { created: boolean };
      await bindSession(tx, userId, sessionId, row.id);
      return { device: deviceDto(row, now()), created: row.created, reactivated: !!existing?.revoked_at, historyWasDeleted: !!existing?.history_purged_at };
    });
  }

  // A new computer takes over the identity of an existing device (restore / replace). The old computer is cut off by the epoch.
  // A device that was REMOVED but whose cloud history was kept can be claimed too (a reinstalled computer restoring it): that reinstates it.
  async function claimDevice(userId: string, sessionId: string, input: { deviceId: string; clientDeviceId: string; name: string; platform?: string | undefined; appVersion?: string | undefined; hardware?: Record<string, unknown> | undefined }) {
    return withTransaction(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`devices:${userId}`]);
      const target = await loadDevice(tx, userId, input.deviceId, { allowRemoved: true });
      if (target.client_device_id !== input.clientDeviceId) await assertInstallationFree(tx, userId, input.clientDeviceId);
      if (target.revoked_at && target.history_purged_at) throw conflict('device_history_deleted', 'The cloud history of this removed computer was deleted, so there is nothing to restore.');
      if (!target.revoked_at && target.client_device_id === input.clientDeviceId) return { device: deviceDto(target, now()), takenOver: false };
      if (target.revoked_at) {
        const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
        if ((count.rows[0]?.n ?? 0) >= MAX_DEVICES) throw conflict('device_limit', `An account can have at most ${MAX_DEVICES} devices.`);
      }
      const clash = await tx.query<{ id: string }>('SELECT id FROM devices WHERE user_id = $1 AND client_device_id = $2 AND id <> $3', [userId, input.clientDeviceId, input.deviceId]);
      if (clash.rows[0]) {
        const docs = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_documents WHERE user_id = $1 AND device_id = $2', [userId, clash.rows[0].id]);
        if ((docs.rows[0]?.n ?? 0) > 0) throw conflict('device_already_registered', 'This computer is already registered with data of its own.');
        await tx.query('DELETE FROM devices WHERE id = $1 AND user_id = $2', [clash.rows[0].id, userId]);   // an empty registration of this very computer
      }
      const r = await tx.query<DeviceRow>(
        `UPDATE devices SET client_device_id = $3, epoch = epoch + 1, name = CASE WHEN name_customized THEN name ELSE $4 END, platform = $5, app_version = $6, hardware = COALESCE($7::jsonb, hardware), last_seen_at = now(), revoked_at = NULL
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [input.deviceId, userId, input.clientDeviceId, input.name, input.platform ?? null, input.appVersion ?? null, input.hardware ? JSON.stringify(input.hardware) : null]);
      await bindSession(tx, userId, sessionId, input.deviceId);
      return { device: deviceDto(r.rows[0] as DeviceRow, now()), takenOver: true };
    });
  }

  async function listDevices(userId: string, clientDeviceId?: string, includeRemoved = false) {
    // includeRemoved: also the removed computers whose cloud history still exists (a reinstalled computer may restore from them).
    const devs = await pool.query<DeviceRow>(`SELECT * FROM devices WHERE user_id = $1 AND (revoked_at IS NULL${includeRemoved ? ' OR history_purged_at IS NULL' : ''}) ORDER BY created_at`, [userId]);
    return enrichDevices(pool, userId, devs.rows, clientDeviceId, now());
  }

  // ---- push ---------------------------------------------------------------------------------------------------
  async function push(userId: string, input: { deviceId: string; epoch: number; ops: PushOp[] }) {
    if (input.ops.length > config.sync.maxOpsPerPush) throw badRequest('too_many_ops', `At most ${config.sync.maxOpsPerPush} documents per request.`);
    return withTransaction(pool, async (tx) => {
      // One push per user at a time: change_seq values of one user then commit in order, so no reader can skip a document.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sync:${userId}`]);
      const device = await ownDevice(tx, userId, input.deviceId);
      if (device.epoch !== input.epoch) throw new AppError(409, 'device_superseded', 'Another computer has taken over this device.');
      const used = Number((await tx.query<{ b: string }>('SELECT COALESCE(sum(size_bytes), 0)::text AS b FROM sync_documents WHERE user_id = $1', [userId])).rows[0]?.b ?? 0);
      let budget = config.sync.userQuotaBytes - used;
      const results: OpResult[] = [];
      for (const op of input.ops) results.push(await applyOp(tx, userId, device, op, () => budget, (n) => { budget -= n; }));
      await tx.query('UPDATE devices SET last_sync_at = now(), last_seen_at = now() WHERE id = $1', [device.id]);
      return { results, serverTime: new Date(now()).toISOString(), quota: { usedBytes: config.sync.userQuotaBytes - budget, limitBytes: config.sync.userQuotaBytes } };
    });
  }

  async function applyOp(tx: PoolClient, userId: string, device: DeviceRow, op: PushOp, budget: () => number, spend: (n: number) => void): Promise<OpResult> {
    const base = { kind: op.kind, key: op.key, scope: op.scope };
    const reject = (reason: string): OpResult => ({ ...base, outcome: 'rejected', reason });
    const def = KINDS[op.kind];
    if (!def) return reject('unknown kind');
    if (def.scope !== op.scope) return reject(`kind ${op.kind} is ${def.scope}-scoped`);
    if (!def.key.test(op.key)) return reject('invalid key');
    const isDelete = op.deleted === true;
    if (isDelete && !def.allowDelete) return reject('this kind cannot be deleted');
    if (!isDelete) {
      if (op.data === undefined) return reject('data is required');
      const problem = def.validate(op.data, op.key);
      if (problem) return reject(problem);
    }
    let ts = Date.parse(op.clientUpdatedAt);
    if (!Number.isFinite(ts) || ts < Date.parse('2020-01-01T00:00:00Z')) return reject('invalid clientUpdatedAt');
    ts = Math.min(ts, now() + SKEW_MS);                                    // a clock running ahead cannot win forever
    const targetDevice = def.scope === 'device' ? device.id : null;
    const existing = (await tx.query<DocRow>(
      `SELECT * FROM sync_documents WHERE user_id = $1 AND COALESCE(device_id, '${NIL}'::uuid) = COALESCE($2::uuid, '${NIL}'::uuid) AND kind = $3 AND doc_key = $4 FOR UPDATE`, [userId, targetDevice, op.kind, op.key])).rows[0];

    // A computer's own documents never replace the cloud copy blindly: they are MERGED with it by the kind's deterministic rule (merge.ts), so a stale,
    // partial or repeated upload can never make the cloud copy smaller. Account-wide settings are not merged; they use last-writer-wins below.
    let data: unknown = isDelete ? null : op.data;
    let selfHash = '';
    if (!isDelete && def.merge !== 'lww') {
      const self = mergeDocument(def.merge, op.data, op.data);      // the upload in canonical form, so that a repeat of the same upload is always recognised as unchanged
      selfHash = hashOf(self);
      data = existing && !existing.deleted ? mergeDocument(def.merge, existing.data, self) : self;
    }
    if (!isDelete && data !== op.data) { const problem = def.validate(data, op.key); if (problem) return reject(`merged document is not valid: ${problem}`); }
    const text = isDelete ? '' : canonicalize(data);
    const size = Buffer.byteLength(text);
    if (size > def.maxBytes) return reject(`document is larger than ${def.maxBytes} bytes`);
    const hash = hashOf(isDelete ? { deleted: true } : data);
    // true when the cloud already held information this upload did not contain (the computer is behind its own cloud copy)
    const cloudAhead = !isDelete && def.merge !== 'lww' && hash !== selfHash;

    if (existing && existing.data_hash === hash && existing.deleted === isDelete) return { ...base, outcome: 'unchanged', ...(cloudAhead ? { cloudAhead: true } : {}) };
    if (existing && def.scope === 'account') {
      // account-wide documents: last writer wins by client time, ties broken by the writer's device id (deterministic on every server instance)
      const existingTs = existing.client_updated_at.getTime();
      // A value stamped with the "never changed on this computer" time (see UNCHANGED_AT) only fills an empty slot: it never replaces
      // anything, so a freshly installed computer cannot overwrite the account's real settings with its defaults, whatever the tie-break says.
      const wins = ts > UNCHANGED_AT && (ts > existingTs || (ts === existingTs && device.id > (existing.written_by_device ?? '')));
      if (!wins) return { ...base, outcome: 'superseded', current: { data: existing.data, deleted: existing.deleted, clientUpdatedAt: existing.client_updated_at.toISOString() } };
    }
    const delta = size - (existing ? existing.size_bytes : 0);
    if (delta > 0 && delta > budget()) return reject('storage quota exceeded');
    const r = existing
      ? await tx.query<{ change_seq: string }>(`UPDATE sync_documents SET data = $2::jsonb, deleted = $3, data_hash = $4, size_bytes = $5, client_updated_at = $6, written_by_device = $7, change_seq = nextval('sync_change_seq') WHERE id = $1 RETURNING change_seq`,
        [existing.id, isDelete ? null : text, isDelete, hash, size, new Date(ts), device.id])
      : await tx.query<{ change_seq: string }>(`INSERT INTO sync_documents (user_id, device_id, kind, doc_key, data, deleted, data_hash, size_bytes, client_updated_at, written_by_device) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) RETURNING change_seq`,
        [userId, targetDevice, op.kind, op.key, isDelete ? null : text, isDelete, hash, size, new Date(ts), device.id]);
    spend(delta);
    return { ...base, outcome: 'applied', seq: Number((r.rows[0] as { change_seq: string }).change_seq), ...(cloudAhead ? { cloudAhead: true } : {}) };
  }

  // ---- changes feed (incremental pull) -----------------------------------------------------------------------
  async function changes(userId: string, q: { deviceId: string; epoch?: number | undefined; scope: 'account' | 'plant' | 'device'; target?: string | undefined; since: number; limit: number; skipOwn: boolean }) {
    const me = await ownDevice(pool, userId, q.deviceId);
    if (q.epoch !== undefined && q.epoch !== me.epoch) throw new AppError(409, 'device_superseded', 'Another computer has taken over this device.');
    await touchDevice(pool, me.id);
    const params: unknown[] = [userId, q.since, q.limit + 1];
    let where = 'user_id = $1 AND change_seq > $2';
    if (q.scope === 'account') {
      where += ' AND device_id IS NULL';
      if (q.skipOwn) { params.push(me.id); where += ` AND written_by_device IS DISTINCT FROM $${params.length}`; }
    } else if (q.scope === 'plant') {
      where += " AND kind = 'plant'";
    } else {
      if (!q.target) throw badRequest('validation_failed', 'target is required for scope=device');
      await loadDevice(pool, userId, q.target, { allowRemoved: true });   // restoring from a removed computer whose history was kept
      params.push(q.target); where += ` AND device_id = $${params.length}`;
    }
    const r = await pool.query<DocRow>(`SELECT * FROM sync_documents WHERE ${where} ORDER BY change_seq LIMIT $3`, params);
    const docs: DocRow[] = []; let bytes = 0; let more = r.rows.length > q.limit;
    for (const row of r.rows.slice(0, q.limit)) {
      if (docs.length > 0 && bytes + row.size_bytes > MAX_FEED_BYTES) { more = true; break; }   // keep one response a sensible size
      docs.push(row); bytes += row.size_bytes;
    }
    const last = docs[docs.length - 1];
    const cursor = last ? Number(last.change_seq) : q.since;
    return {
      docs: docs.map((d) => ({ scope: d.device_id ? 'device' : 'account', deviceId: d.device_id, kind: d.kind, key: d.doc_key, data: d.data, deleted: d.deleted, clientUpdatedAt: d.client_updated_at.toISOString(), seq: Number(d.change_seq) })),
      cursor, hasMore: more, serverTime: new Date(now()).toISOString(),
    };
  }

  // ---- manifest (backup verification) --------------------------------------------------------------------------------------------
  // What the cloud holds for ONE computer, as a compact list (kind, key, content hash, change number). The desktop uses it to verify that everything it
  // believes is backed up really is in the cloud (e.g. after the database was restored from an older snapshot) and to re-send what is missing.
  // Read-only, paginated by change_seq like the changes feed; `highWaterSeq` is the account's newest change at the time of the read.
  async function manifest(userId: string, q: { deviceId: string; epoch?: number | undefined; since: number; limit: number }) {
    const me = await ownDevice(pool, userId, q.deviceId);
    if (q.epoch !== undefined && q.epoch !== me.epoch) throw new AppError(409, 'device_superseded', 'Another computer has taken over this device.');
    await touchDevice(pool, me.id);
    const r = await pool.query<{ kind: string; doc_key: string; data_hash: string; change_seq: string; deleted: boolean; size_bytes: number }>(
      'SELECT kind, doc_key, data_hash, change_seq, deleted, size_bytes FROM sync_documents WHERE user_id = $1 AND device_id = $2 AND change_seq > $3 ORDER BY change_seq LIMIT $4', [userId, me.id, q.since, q.limit + 1]);
    const rows = r.rows.slice(0, q.limit);
    const hw = await pool.query<{ s: string }>('SELECT COALESCE(max(change_seq), 0)::text AS s FROM sync_documents WHERE user_id = $1', [userId]);
    const last = rows[rows.length - 1];
    return {
      entries: rows.map((d) => ({ kind: d.kind, key: d.doc_key, hash: d.data_hash, seq: Number(d.change_seq), deleted: d.deleted, bytes: d.size_bytes })),
      cursor: last ? Number(last.change_seq) : q.since, hasMore: r.rows.length > q.limit, highWaterSeq: Number(hw.rows[0]?.s ?? 0), serverTime: new Date(now()).toISOString(),
    };
  }

  async function status(userId: string, deviceId: string) {
    const me = await ownDevice(pool, userId, deviceId);
    await touchDevice(pool, me.id);
    const u = await pool.query<{ b: string; n: number }>('SELECT COALESCE(sum(size_bytes),0)::text AS b, count(*)::int AS n FROM sync_documents WHERE user_id = $1', [userId]);
    return { serverTime: new Date(now()).toISOString(), device: deviceDto(me, now()), documents: u.rows[0]?.n ?? 0, usedBytes: Number(u.rows[0]?.b ?? 0), limitBytes: config.sync.userQuotaBytes };
  }

  return { registerDevice, claimDevice, listDevices, push, changes, manifest, status };
}
export type SyncService = ReturnType<typeof createSyncService>;

