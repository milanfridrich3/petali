import type { Pool } from 'pg';
import { badRequest } from '../../lib/errors';
import { deviceDto, enrichDevices, loadDevice, type DeviceRow } from '../devices/access';
import { accountPlant, type LedgerInput } from './plant';
import {
  addDays, aggregateHardware, batterySection, buildEpisodes, compare, dayHardwareRows, healthSection, hourlyRows, neighbour, periodFor, usageSection,
  type ActiveDay, type HealthEvent, type HwMap, type Period,
} from './report-core';

// Read-only views for the Petali ID web app, computed ONLY from the account's synchronised documents. Every function takes the user id of the
// VERIFIED token and finds devices by (device id AND user id), so another account's data is indistinguishable from nothing.
// "Today" is the cloud's UTC date; documents are keyed by each computer's own local calendar days (so a computer east of UTC may already have the next day).
const DAY_MS = 86_400_000;
const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createWebService(deps: { pool: Pool; now?: () => number }) {
  const { pool } = deps;
  const now = deps.now ?? Date.now;
  const today = () => dayKeyOf(now());

  async function docs<T = any>(userId: string, deviceId: string, kind: string, from: string, to: string): Promise<{ key: string; data: T }[]> {
    const r = await pool.query<{ k: string; d: T }>(`SELECT doc_key AS k, data AS d FROM sync_documents WHERE user_id = $1 AND device_id = $2 AND kind = $3 AND NOT deleted AND doc_key >= $4 AND doc_key <= $5 ORDER BY doc_key`, [userId, deviceId, kind, from, to]);
    return r.rows.map((x) => ({ key: x.k, data: x.d }));
  }
  const monthsBetween = (fromDay: string, toDay: string): { from: string; to: string } => ({ from: fromDay.slice(0, 7), to: toDay.slice(0, 7) });

  async function loadActive(userId: string, deviceId: string, from: string, to: string): Promise<Map<string, ActiveDay>> {
    const out = new Map<string, ActiveDay>();
    for (const { key, data } of await docs(userId, deviceId, 'day', from, to)) {
      if (typeof data?.activeMs !== 'number' || !Number.isFinite(data.activeMs)) continue;
      const sessions: any[] = Array.isArray(data.sessions) ? data.sessions : [];
      out.set(key, { activeMs: Math.round(data.activeMs), sessions: sessions.length, longestSessionMs: sessions.reduce((a, s) => Math.max(a, typeof s?.activeMs === 'number' ? s.activeMs : 0), 0) });
    }
    return out;
  }

  async function loadHardware(userId: string, deviceId: string, from: string, to: string): Promise<HwMap> {
    const m = monthsBetween(from, to);
    const out: HwMap = new Map();
    for (const { data } of await docs(userId, deviceId, 'rollup', m.from, m.to)) {
      const days = data && typeof data.days === 'object' && data.days ? data.days : {};
      for (const [k, v] of Object.entries<any>(days)) if (k >= from && k <= to && v && v.hw && Array.isArray(v.hourly)) out.set(k, { hw: v.hw, hourly: v.hourly });
    }
    return out;
  }

  async function loadHealthEvents(userId: string, deviceId: string, from: string, to: string): Promise<HealthEvent[]> {
    const m = monthsBetween(from, to);
    const events: HealthEvent[] = [];
    for (const { data } of await docs(userId, deviceId, 'health', m.from, m.to)) {
      for (const l of Array.isArray(data?.lines) ? data.lines : []) if (l && typeof l === 'object' && typeof l.k === 'string' && typeof l.t === 'number') events.push(l);
    }
    return events.sort((a, b) => a.t - b.t);
  }

  async function loadApps(userId: string, deviceId: string, from: string, to: string) {
    const totals = new Map<string, number>(); let unknownMs = 0;
    for (const { data } of await docs(userId, deviceId, 'apps', from, to)) {
      unknownMs += Number(data?.unknownMs) || 0;
      for (const [app, ms] of Object.entries<any>(data?.apps ?? {})) if (typeof ms === 'number' && Number.isFinite(ms)) totals.set(app, (totals.get(app) ?? 0) + ms);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return { top: ranked.slice(0, 20).map(([app, ms]) => ({ app, ms })), otherMs: ranked.slice(20).reduce((a, [, ms]) => a + ms, 0), unknownMs, attributedMs: ranked.reduce((a, [, ms]) => a + ms, 0) + unknownMs, available: ranked.length > 0 || unknownMs > 0 };
  }

  const deviceBrief = (d: DeviceRow) => { const dto = deviceDto(d, now()); return { id: dto.id, name: dto.name, status: dto.status, lastSyncAt: dto.lastSyncAt, removedAt: dto.removedAt, historyDeleted: dto.historyDeleted }; };

  // The plant's IDENTITY (species + the name the user gave it) is an ordinary synchronised account setting (ui.plant, ui.name): read, never written, here.
  const SPECIES = ['cactus', 'fern', 'sprout', 'ivy', 'carnivore'];
  async function identity(userId: string) {
    const r = await pool.query<{ k: string; d: unknown }>(`SELECT doc_key AS k, data AS d FROM sync_documents WHERE user_id = $1 AND device_id IS NULL AND kind = 'setting' AND NOT deleted AND doc_key IN ('ui.plant', 'ui.name')`, [userId]);
    const get = (k: string) => r.rows.find((x) => x.k === k)?.d;
    const species = get('ui.plant'); const name = get('ui.name');
    return { species: typeof species === 'string' && SPECIES.includes(species) ? species : null, name: typeof name === 'string' && name.length <= 20 && name.trim() ? name.trim() : null };
  }

  // ---- plant (account-wide) -----------------------------------------------------------------------------------------
  async function plant(userId: string) {
    const rows = await pool.query<{ device_id: string; data: unknown; name: string; revoked_at: Date | null }>(
      `SELECT s.device_id, s.data, d.name, d.revoked_at FROM sync_documents s JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
       WHERE s.user_id = $1 AND s.kind = 'plant' AND s.doc_key = 'ledger' AND NOT s.deleted ORDER BY d.created_at`, [userId]);
    const inputs: LedgerInput[] = rows.rows.map((r) => ({ deviceId: r.device_id, name: r.name, removed: !!r.revoked_at, ledger: r.data }));
    return { plant: accountPlant(inputs), identity: await identity(userId), serverTime: new Date(now()).toISOString(), source: 'cloud-ledger' as const };
  }

  // ---- overview -----------------------------------------------------------------------------------------------------
  async function overview(userId: string) {
    const nowMs = now();
    const all = await pool.query<DeviceRow>('SELECT * FROM devices WHERE user_id = $1 ORDER BY revoked_at IS NOT NULL, created_at', [userId]);
    const live = all.rows.filter((d) => !d.revoked_at);
    const enriched = await enrichDevices(pool, userId, live, undefined, nowMs);
    const counts = { total: live.length, active: 0, offline: 0, stale: 0, never: 0, removed: all.rows.length - live.length };
    for (const d of enriched) if (d.status in counts) (counts as any)[d.status] += 1;
    const lastSync = live.reduce<number>((m, d) => Math.max(m, d.last_sync_at?.getTime() ?? 0, d.last_seen_at?.getTime() ?? 0), 0);

    const since = dayKeyOf(nowMs - 29 * DAY_MS); const to = dayKeyOf(nowMs + DAY_MS);
    const usage = await pool.query<{ k: string; ms: string }>(
      `SELECT s.doc_key AS k, COALESCE(sum((s.data->>'activeMs')::numeric), 0)::text AS ms FROM sync_documents s JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
       WHERE s.user_id = $1 AND d.revoked_at IS NULL AND s.kind = 'day' AND NOT s.deleted AND s.doc_key >= $2 AND s.doc_key <= $3 GROUP BY s.doc_key ORDER BY s.doc_key`, [userId, since, to]);
    const daily = usage.rows.map((r) => ({ day: r.k, activeMs: Math.round(Number(r.ms)) }));
    const week = dayKeyOf(nowMs - 6 * DAY_MS);
    const last7 = daily.filter((d) => d.day >= week);

    // Device Health of the last 30 days over the account's computers: EPISODES (a start, later escalations, an end), exactly as the desktop counts them.
    const cutoff = nowMs - 30 * DAY_MS;
    const healthDocs = await pool.query<{ device_id: string; lines: HealthEvent[] }>(
      `SELECT s.device_id, s.data->'lines' AS lines FROM sync_documents s JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
       WHERE s.user_id = $1 AND d.revoked_at IS NULL AND s.kind = 'health' AND NOT s.deleted AND s.doc_key >= $2 ORDER BY s.doc_key`, [userId, dayKeyOf(cutoff).slice(0, 7)]);
    const linesByDevice = new Map<string, HealthEvent[]>();
    for (const r of healthDocs.rows) for (const l of Array.isArray(r.lines) ? r.lines : []) if (l && typeof l.k === 'string' && typeof l.t === 'number') { const a = linesByDevice.get(r.device_id) ?? []; a.push(l); linesByDevice.set(r.device_id, a); }
    let episodes = 0; let critical = 0;
    for (const lines of linesByDevice.values()) {
      for (const ep of buildEpisodes(lines.sort((a, b) => a.t - b.t), { from: cutoff })) { episodes += 1; if (ep.severity === 'critical') critical += 1; }
    }
    const hasHealthData = (enriched as any[]).some((d) => (d.docCounts.health ?? 0) > 0 || (d.docCounts.rollup ?? 0) > 0);

    const alerts: { code: string; severity: 'info' | 'warning'; deviceId?: string; deviceName?: string }[] = [];
    for (const d of enriched) {
      if (d.status === 'stale') alerts.push({ code: 'device_stale', severity: 'warning', deviceId: d.id, deviceName: d.name });
      if (d.status === 'never') alerts.push({ code: 'device_never_synced', severity: 'info', deviceId: d.id, deviceName: d.name });
    }
    if (critical > 0) alerts.push({ code: 'critical_problems_30d', severity: 'warning' });

    return {
      serverTime: new Date(nowMs).toISOString(), source: 'cloud-snapshot' as const,
      devices: { ...counts, list: enriched.map((d) => ({ id: d.id, name: d.name, status: d.status, lastSyncAt: d.lastSyncAt, activeMsLast7Days: d.activeMsLast7Days, lastUsageDay: d.lastUsageDay })) },
      lastSyncAt: lastSync ? new Date(lastSync).toISOString() : null,
      ...(await (async () => { const p = await plant(userId); return { plant: p.plant, identity: p.identity }; })()),
      usage: { available: daily.length > 0, last7Days: { activeMs: last7.reduce((a, d) => a + d.activeMs, 0), days: last7.length }, last30Days: { activeMs: daily.reduce((a, d) => a + d.activeMs, 0), days: daily.length }, daily },
      health: { recorded: hasHealthData, episodes30d: hasHealthData ? episodes : null, critical30d: hasHealthData ? critical : null },
      alerts,
    };
  }

  // ---- per computer ---------------------------------------------------------------------------------------------------
  const daysParam = (days: number) => { if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest('validation_failed', 'days must be between 1 and 365.'); return days; };

  async function health(userId: string, deviceId: string, days: number) {
    daysParam(days);
    const d = await loadDevice(pool, userId, deviceId, { allowRemoved: true });
    const nowMs = now(); const to = dayKeyOf(nowMs + DAY_MS); const from = dayKeyOf(nowMs - (days - 1) * DAY_MS);
    const [events, hw] = await Promise.all([loadHealthEvents(userId, deviceId, from, to), loadHardware(userId, deviceId, from, to)]);
    const fromMs = Date.parse(`${from}T00:00:00Z`) - DAY_MS;      // generous at the start: a computer west of UTC started its day later
    const episodes = buildEpisodes(events.filter((e) => e.t >= fromMs), { from: fromMs });
    const agg = aggregateHardware([...hw.keys()].sort(), hw);
    const section = healthSection(episodes, events.filter((e) => e.t >= fromMs), agg);
    // The newest recorded hour with a Device Health verdict: what the computer last REPORTED, not a live reading.
    let latest: { at: number; status: 'healthy' | 'warning' | 'critical'; minutes: { healthy: number; warning: number; critical: number } } | null = null;
    for (const k of [...hw.keys()].sort().reverse()) {
      const day = hw.get(k) as { hourly: any[] };
      const hours = [...day.hourly].sort((a, b) => b.t - a.t).find((h) => Array.isArray(h.hsm));
      if (hours) { const [h0, w0, c0] = hours.hsm as number[]; latest = { at: hours.t, status: c0! > 0 ? 'critical' : w0! > 0 ? 'warning' : 'healthy', minutes: { healthy: h0!, warning: w0!, critical: c0! } }; break; }
    }
    return { device: deviceBrief(d), range: { days, from, to: dayKeyOf(nowMs) }, source: 'cloud-snapshot' as const, serverTime: new Date(nowMs).toISOString(), latest, health: section, coverage: { daysWithHardware: hw.size } };
  }

  async function performance(userId: string, deviceId: string, days: number) {
    daysParam(days);
    const d = await loadDevice(pool, userId, deviceId, { allowRemoved: true });
    const nowMs = now(); const to = dayKeyOf(nowMs + DAY_MS); const from = dayKeyOf(nowMs - (days - 1) * DAY_MS);
    const hw = await loadHardware(userId, deviceId, from, to);
    const keys: string[] = []; for (let k = from; k <= dayKeyOf(nowMs); k = addDays(k, 1)) keys.push(k);
    const agg = aggregateHardware(keys, hw);
    return { device: deviceBrief(d), range: { days, from, to: dayKeyOf(nowMs) }, source: 'cloud-snapshot' as const, serverTime: new Date(nowMs).toISOString(), available: hw.size > 0, minutes: agg.minutes, daysWithHardware: agg.daysWithHardware, metrics: Object.values(agg.metrics).filter((m: any) => m.available), battery: batterySection(agg), days: dayHardwareRows(keys, hw) };
  }

  async function collect(userId: string, deviceId: string, p: { dayKeys: string[]; from: string; to: string }) {
    const [active, hw, events] = await Promise.all([loadActive(userId, deviceId, p.from, p.to), loadHardware(userId, deviceId, p.from, p.to), loadHealthEvents(userId, deviceId, p.from, p.to)]);
    const fromMs = Date.parse(`${p.from}T00:00:00Z`) - DAY_MS; const toMs = Date.parse(`${p.to}T00:00:00Z`) + 2 * DAY_MS;
    const inPeriod = events.filter((e) => e.t >= fromMs && e.t <= toMs);
    const episodes = buildEpisodes(inPeriod, { from: fromMs, to: toMs });
    const agg = aggregateHardware(p.dayKeys, hw);
    return { active, hw, usage: usageSection(p.dayKeys, active), agg, health: healthSection(episodes, inPeriod, agg) };
  }

  async function report(userId: string, deviceId: string, kind: string, key: string | undefined) {
    const d = await loadDevice(pool, userId, deviceId, { allowRemoved: true });
    const nowMs = now(); const todayKey = today();
    const period = periodFor(kind, key, todayKey);
    if ('error' in period) throw badRequest(`report_${period.error.replace('-', '_')}`, period.error === 'invalid-kind' ? 'kind must be daily, weekly or monthly.' : period.error === 'invalid-key' ? 'The period key is not valid.' : 'That period has not started yet.');
    const cur = await collect(userId, deviceId, period);
    const prevKey = neighbour(period.kind, period.key, -1);
    const prevPeriod = periodFor(period.kind, prevKey, todayKey) as Period;
    const prev = 'error' in prevPeriod ? null : await collect(userId, deviceId, prevPeriod);
    const apps = await loadApps(userId, deviceId, period.from, period.to);
    const firstDay = (await pool.query<{ a: string | null }>(`SELECT min(doc_key) AS a FROM sync_documents WHERE user_id = $1 AND device_id = $2 AND kind = 'day' AND NOT deleted`, [userId, deviceId])).rows[0]?.a ?? null;
    const comparison = prev ? compare({ period, usage: cur.usage, agg: cur.agg, health: cur.health, prev: { key: prevPeriod.key, keys: prevPeriod.dayKeys, usage: prev.usage, agg: prev.agg, health: prev.health } }) : { available: false, reason: 'no-previous-data' };
    const next = neighbour(period.kind, period.key, 1);
    const nextOk = !('error' in periodFor(period.kind, next, todayKey));
    return {
      generatedAt: new Date(nowMs).toISOString(), source: 'cloud-snapshot' as const, device: deviceBrief(d),
      period: { kind: period.kind, key: period.key, from: period.from, to: period.to, days: period.dayKeys.length, elapsedDays: period.elapsedKeys.length, incomplete: period.isCurrent || (firstDay !== null && period.from < firstDay) },
      coverage: { firstDay, usageDays: cur.usage.knownDays },
      usage: cur.usage, apps, hardware: { minutes: cur.agg.minutes, daysWithHardware: cur.agg.daysWithHardware, metrics: Object.values(cur.agg.metrics).filter((m: any) => m.available), battery: batterySection(cur.agg), days: dayHardwareRows(period.dayKeys, cur.hw), hourly: period.kind === 'daily' ? hourlyRows(period.key, cur.hw) : [] },
      health: cur.health, comparison,
      navigation: { previous: firstDay !== null && addDays(period.from, -1) < firstDay ? null : prevKey, next: nextOk ? next : null },
    };
  }

  // The look of Petali (read, never written, here): the night schedule the user set in the desktop app (ui.autoNight) so that "Automatic" in Petali ID follows
  // the SAME schedule. Only a well-formed schedule is returned; anything else is null and the client uses the 22:00-06:00 default.
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  async function appearance(userId: string) {
    const r = await pool.query<{ d: unknown }>(`SELECT data AS d FROM sync_documents WHERE user_id = $1 AND device_id IS NULL AND kind = 'setting' AND NOT deleted AND doc_key = 'ui.autoNight' ORDER BY updated_at DESC LIMIT 1`, [userId]);
    const d = r.rows[0]?.d as { from?: unknown; to?: unknown } | undefined;
    const ok = d && typeof d.from === 'string' && typeof d.to === 'string' && TIME.test(d.from) && TIME.test(d.to) && d.from !== d.to;
    return { autoNight: ok ? { from: d.from as string, to: d.to as string } : null };
  }

  return { plant, overview, health, performance, report, appearance };
}
export type WebService = ReturnType<typeof createWebService>;
