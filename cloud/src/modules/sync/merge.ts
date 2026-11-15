import { canonicalize } from './canonical';

// Petali 1.5.0 Phase 4: conflict resolution for documents that belong to ONE computer.
//
// Until Phase 3 a computer's document simply replaced the cloud copy. That is only safe while the computer's files are always at least as
// complete as the cloud copy, which is not true after a reinstall / replaced computer (fresh local files for today), a restored folder copy
// or a delayed retry. These functions make the cloud copy MONOTONE: whatever was backed up once can only grow.
//
// Every merge is
//   * commutative   merge(a, b) = merge(b, a)       (two computers / two retries arriving in any order give the same result)
//   * idempotent    merge(a, a) = a, merge(a, merge(a, b)) = merge(a, b)     (a repeated upload changes nothing)
//   * associative   merge(merge(a, b), c) = merge(a, merge(b, c))
// and monotone: the result contains everything either input contains. The desktop app (merge-rules.js) implements the SAME rules; the shared
// vectors in test/fixtures/merge-vectors.json are checked by both test suites so the two cannot drift apart.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const MAX_DAY_ACTIVE_MS = 25 * 3_600_000;
export const MAX_HEALTH_LINES = 20_000;

// ---- usage day: { version, dayKey, activeMs, sessions: [{ id, startMs, endMs, activeMs, endReason }] } ----------------------------------
// Sessions are the unit of truth: the union by session id, and for the same id the most advanced copy (more active time, later end; a closed session
// beats an open one). Active Work of the day is the larger of what either side counted and the sum of all known sessions, so time counted before the
// reinstall plus time counted after it adds up instead of one side erasing the other.
function betterSession(a: Obj, b: Obj): Obj {
  const ka = [num(a['activeMs']), num(a['endMs']), a['endReason'] === null ? 0 : 1] as const;
  const kb = [num(b['activeMs']), num(b['endMs']), b['endReason'] === null ? 0 : 1] as const;
  for (let i = 0; i < 3; i += 1) if (ka[i] !== kb[i]) return (ka[i] as number) > (kb[i] as number) ? a : b;
  return canonicalize(a) >= canonicalize(b) ? a : b;
}

function mergeExtras(a: Obj, b: Obj, skip: Set<string>): Obj {
  // Fields the store passes through untouched: per key the value with the greater canonical text (a total order, so the result does not depend on the order).
  const out: Obj = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.has(k)) continue;
    const va = a[k]; const vb = b[k];
    if (va === undefined) out[k] = vb; else if (vb === undefined) out[k] = va; else out[k] = canonicalize(va) >= canonicalize(vb) ? va : vb;
  }
  return out;
}

export function mergeDay(existing: unknown, incoming: unknown): unknown {
  if (!isObj(existing) || !isObj(incoming) || !Array.isArray(existing['sessions']) || !Array.isArray(incoming['sessions'])) return incoming;
  const byId = new Map<string, Obj>();
  for (const s of [...existing['sessions'], ...incoming['sessions']]) {
    if (!isObj(s)) continue;
    // A session without an id (never written by the app) is kept as it is, keyed by its content: nothing is ever dropped.
    const key = typeof s['id'] === 'string' ? `id:${s['id']}` : `raw:${canonicalize(s)}`;
    const prev = byId.get(key);
    byId.set(key, prev ? betterSession(prev, s) : s);
  }
  const sessions = [...byId.entries()].sort((x, y) => (num(x[1]['startMs']) - num(y[1]['startMs'])) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((e) => e[1]);
  // Only sessions the app itself wrote (they have an id) take part in the sum; an id-less entry is kept but cannot raise Active Work.
  const sum = sessions.reduce((t, s) => t + (typeof s['id'] === 'string' ? num(s['activeMs']) : 0), 0);
  const activeMs = Math.min(MAX_DAY_ACTIVE_MS, Math.max(num(existing['activeMs']), num(incoming['activeMs']), sum));
  return { ...mergeExtras(existing, incoming, new Set(['activeMs', 'sessions'])), activeMs, sessions };
}

// ---- app usage day: { version, dayKey, attributedMs, unknownMs, apps: {id: ms}, hourly: [{ t, unknownMs, apps }] } -------------------------------------
// Time per app only grows during a day, so the larger value per app is the more advanced copy. attributedMs is recomputed so the invariant
// attributedMs = unknownMs + sum(apps) always holds. If the per-app maxima of two unrelated histories would exceed a day the more advanced
// whole document is kept instead (never an invalid document).
const maxMaps = (a: unknown, b: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const src of [a, b]) if (isObj(src)) for (const [k, v] of Object.entries(src)) out[k] = Math.max(out[k] ?? 0, num(v));
  return out;
};
const sumOf = (m: Record<string, number>) => Object.values(m).reduce((t, v) => t + v, 0);
const HOUR_CAP_MS = 3_600_000 + 60_000;

export function mergeApps(existing: unknown, incoming: unknown): unknown {
  if (!isObj(existing) || !isObj(incoming) || !isObj(existing['apps']) || !isObj(incoming['apps'])) return incoming;
  const apps = maxMaps(existing['apps'], incoming['apps']);
  const unknownMs = Math.max(num(existing['unknownMs']), num(incoming['unknownMs']));
  const attributedMs = unknownMs + sumOf(apps);
  const advanced = (num(existing['attributedMs']) > num(incoming['attributedMs']) || (num(existing['attributedMs']) === num(incoming['attributedMs']) && canonicalize(existing) >= canonicalize(incoming))) ? existing : incoming;
  if (attributedMs > MAX_DAY_ACTIVE_MS) return advanced;
  const hours = new Map<number, { t: number; unknownMs: number; apps: Record<string, number> }>();
  for (const src of [existing['hourly'], incoming['hourly']]) {
    if (!Array.isArray(src)) continue;
    for (const h of src) {
      if (!isObj(h) || !Number.isInteger(h['t'])) continue;
      const t = h['t'] as number;
      const cur = hours.get(t);
      hours.set(t, cur ? { t, unknownMs: Math.max(cur.unknownMs, num(h['unknownMs'])), apps: maxMaps(cur.apps, h['apps']) } : { t, unknownMs: num(h['unknownMs']), apps: maxMaps({}, h['apps']) });
    }
  }
  const hourly = [...hours.values()].sort((x, y) => x.t - y.t);
  if (hourly.some((h) => h.unknownMs > HOUR_CAP_MS || Object.values(h.apps).some((v) => v > HOUR_CAP_MS)) || hourly.length > 25) return advanced;
  return { ...mergeExtras(existing, incoming, new Set(['attributedMs', 'unknownMs', 'apps', 'hourly'])), attributedMs, unknownMs, apps, hourly };
}

// ---- hardware summaries of a month: { version, month, days: { 'YYYY-MM-DD': { hw: bucket, hourly: [bucket] } } } -------------------------------------
// Per day the richer entry wins (more minutes measured, then more samples, then the greater canonical text as a deterministic tie-break).
const richness = (d: unknown): [number, number] => (isObj(d) && isObj(d['hw']) ? [num(d['hw']['minutes']), num(d['hw']['n'])] : [0, 0]);
function richer(a: unknown, b: unknown): unknown {
  const ra = richness(a); const rb = richness(b);
  if (ra[0] !== rb[0]) return ra[0] > rb[0] ? a : b;
  if (ra[1] !== rb[1]) return ra[1] > rb[1] ? a : b;
  return canonicalize(a) >= canonicalize(b) ? a : b;
}
export function mergeRollup(existing: unknown, incoming: unknown): unknown {
  if (!isObj(existing) || !isObj(incoming) || !isObj(existing['days']) || !isObj(incoming['days'])) return incoming;
  const days: Obj = { ...existing['days'] };
  for (const [k, v] of Object.entries(incoming['days'])) days[k] = k in days ? richer(days[k], v) : v;
  const sorted: Obj = {};
  for (const k of Object.keys(days).sort()) sorted[k] = days[k];
  return { ...mergeExtras(existing, incoming, new Set(['days'])), days: sorted };
}

// ---- Device Health events of a month: { lines: [{ t, k, ... }] } --------------------------------------------------------------------------------
// An append-only log: the union of all distinct events, in time order. The same event arriving twice is one event.
export function mergeHealth(existing: unknown, incoming: unknown): unknown {
  if (!isObj(existing) || !isObj(incoming) || !Array.isArray(existing['lines']) || !Array.isArray(incoming['lines'])) return incoming;
  const seen = new Map<string, Obj>();
  for (const l of [...existing['lines'], ...incoming['lines']]) if (isObj(l)) seen.set(canonicalize(l), l);
  let lines = [...seen.entries()].sort((x, y) => (num(x[1]['t']) - num(y[1]['t'])) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((e) => e[1]);
  if (lines.length > MAX_HEALTH_LINES) lines = lines.slice(lines.length - MAX_HEALTH_LINES);   // only the oldest events can ever be dropped, and only past the hard cap
  return { ...mergeExtras(existing, incoming, new Set(['lines'])), lines };
}

// ---- plant ledger: { baseMs, days: { day: ms } } ------------------------------------------------------------------------------------------------
export function mergeLedger(a: unknown, b: unknown): { baseMs: number; days: Record<string, number> } {
  const oa = isObj(a) ? a : {}; const ob = isObj(b) ? b : {};
  const days: Record<string, number> = {};
  for (const src of [oa['days'], ob['days']]) if (isObj(src)) for (const [k, v] of Object.entries(src)) if (typeof v === 'number') days[k] = Math.max(days[k] ?? 0, v);
  return { baseMs: Math.max(Number(oa['baseMs']) || 0, Number(ob['baseMs']) || 0), days };
}

export type MergeName = 'lww' | 'day' | 'apps' | 'rollup' | 'health' | 'maxmap';
export function mergeDocument(name: MergeName, existing: unknown, incoming: unknown): unknown {
  switch (name) {
    case 'day': return mergeDay(existing, incoming);
    case 'apps': return mergeApps(existing, incoming);
    case 'rollup': return mergeRollup(existing, incoming);
    case 'health': return mergeHealth(existing, incoming);
    case 'maxmap': return mergeLedger(existing, incoming);
    default: return incoming;
  }
}
