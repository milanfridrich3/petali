import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { addDays } from '../src/modules/web/report-core';
import type { TestEnv } from './helpers';
import { call, device, setup, user, type User } from './family-helpers';

// Seeding for the Family Dashboard tests. Documents are written straight into sync_documents exactly as Cloud Sync stores them (kind, key, JSON data), so
// the tests control every number; a few suites additionally go through the real sync API (see family-dashboard-sync.test.ts).
export const HOUR = 3_600_000;
export const MIN = 60_000;
export const utcToday = (env: TestEnv): string => new Date(env.clock.now).toISOString().slice(0, 10);
export const dayAgo = (env: TestEnv, n: number): string => addDays(utcToday(env), -n);

export async function putDoc(env: TestEnv, userId: string, deviceId: string | null, kind: string, key: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data);
  await env.pool.query(
    `DELETE FROM sync_documents WHERE user_id = $1 AND COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid) AND kind = $3 AND doc_key = $4`, [userId, deviceId, kind, key]);
  await env.pool.query(
    `INSERT INTO sync_documents (user_id, device_id, kind, doc_key, data, data_hash, size_bytes, client_updated_at, written_by_device) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,now(),$2)`,
    [userId, deviceId, kind, key, json, createHash('sha256').update(json).digest('hex'), json.length]);
}
export const putDay = (env: TestEnv, u: User, dev: string, day: string, activeMs: number, sessions: { activeMs: number }[] = []) =>
  putDoc(env, u.id, dev, 'day', day, { version: 1, dayKey: day, activeMs, sessions });
export const putApps = (env: TestEnv, u: User, dev: string, day: string, apps: Record<string, number>, unknownMs = 0) =>
  putDoc(env, u.id, dev, 'apps', day, { version: 1, dayKey: day, attributedMs: unknownMs + Object.values(apps).reduce((a, b) => a + b, 0), unknownMs, apps, hourly: [] });
export const putOverride = (env: TestEnv, u: User, exe: string, category: string) => putDoc(env, u.id, null, 'setting', `apps.override.${exe}`, category);

export async function shareWith(env: TestEnv, u: User, patch: Record<string, boolean>) {
  const r = await call(env, u, 'PUT', '/me/sharing', patch); assert.equal(r.status, 200, r.text); return r;
}
export async function linkDevice(env: TestEnv, u: User, deviceId: string) {
  const r = await call(env, u, 'PUT', `/devices/${deviceId}/link`); assert.equal(r.status, 200, r.text);
}
export const ALL_SHARED = { screenTime: true, usageHistory: true, appUsage: true, appCategories: true, individualReports: true, deviceInfo: true };

export type Fam = Awaited<ReturnType<typeof family>>;
// owner (parent) + two children (A and B), every one with one linked computer
export async function family(env: TestEnv, opts: { parents?: number; children?: number } = {}) {
  const base = await setup(env, opts.children ?? 2, opts.parents ?? 0);
  const ownerDev = await device(env, base.owner, 'Owner PC'); await linkDevice(env, base.owner, ownerDev.id);
  const kids: { u: User; memberId: string; dev: string }[] = [];
  for (const k of base.kids) { const d = await device(env, k.u, 'Kid PC'); await linkDevice(env, k.u, d.id); kids.push({ ...k, dev: d.id }); }
  const pars: { u: User; memberId: string; dev: string }[] = [];
  for (const p of base.pars) { const d = await device(env, p.u, 'Parent PC'); await linkDevice(env, p.u, d.id); pars.push({ ...p, dev: d.id }); }
  return { ...base, ownerDev: ownerDev.id, kids, pars };
}
export const q = (o: Record<string, string | number | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
export { user, device, call };
