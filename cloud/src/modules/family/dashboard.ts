import type { Pool, PoolClient } from 'pg';
import { badRequest } from '../../lib/errors';
import { addDays, mondayOf, neighbour, periodFor, type ReportKind } from '../web/report-core';
import { loadAllMembers, loadMember, loadSharing, requireMembership, type Membership, type MemberRow } from './access';
import {
  CATEGORIES, categoryTotals, compareUsage, dailySeries, dayKeys, monthlyBuckets, rankApps, resolveWindow, share, sumOf, trendOf, weeklyBuckets,
  isCategory, type AppTotal, type Window,
} from './dashboard-core';
import type { AppCategory } from './app-category-table';
import type { FamilyDeviceService } from './devices';
import { canViewMemberData, type AccessDecision, type PrivacyCategory, type Sharing } from './permissions';

// Petali Family, Stage 2: the Family Dashboard. READ-ONLY: every statistic is computed from the synchronised documents of Cloud Sync (`day`, `apps` and
// the account setting `apps.override.*`); nothing is stored, nothing is written, and nothing here can change what a computer does (no limits, no blocking).
//
// Who may see what (Stage 1 stays authoritative, nothing is re-decided here):
//   * one decision function, canViewMemberData(viewer, member, category): same family AND (own data OR viewer holds memberData.view AND the member shares the
//     category). A Parent role alone shows nothing. Membership, permissions and consent are read from the database inside every request, from ONE snapshot
//     (REPEATABLE READ, read-only) together with the data, and nothing is cached in the process: a removal or a revoked consent is effective on the next request.
//   * categories: screenTime = Active Work totals and comparisons, usageHistory = per-day / weekly / monthly series and the history list, appUsage = time per
//     application, appCategories = time per category, individualReports = the daily / weekly / monthly reports (a report's sections are still gated by the
//     categories above).
//   * devices: for ANOTHER member only the computers that member linked to the family (their explicit "show to the family" choice) and that are not removed
//     count. For one's own data every non-removed computer counts. Documents of unlinked computers are never read for somebody else.
//   * a section the viewer may not read answers { state: 'restricted', reason } and carries NO numbers; "no data" ({ state: 'empty' }) is a different answer
//     from zero usage; a family total only ever sums members whose category the VIEWER may read and says how many that is (included / total).
type Db = Pool | PoolClient;
type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
const WEEKLY_AFTER_DAYS = 62;
const DASH_CATS = ['screenTime', 'usageHistory', 'appUsage', 'appCategories', 'individualReports'] as const satisfies readonly PrivacyCategory[];
type DashCat = (typeof DASH_CATS)[number];
type Access = Record<PrivacyCategory, AccessDecision>;

type Target = {
  member: MemberRow; isSelf: boolean; access: Access; deviceIds: string[]; deviceCount: number; lastSyncAt: Date | null;
};

const restricted = (a: AccessDecision) => ({ state: 'restricted' as const, reason: a.reason === 'no_permission' ? ('no_permission' as const) : ('not_shared' as const) });
const accessDto = (a: Access) => Object.fromEntries(DASH_CATS.map((c) => [c, { allowed: a[c].allowed, reason: a[c].reason }])) as Record<DashCat, { allowed: boolean; reason: string }>;

export function createDashboardService(deps: { pool: Pool; devices: FamilyDeviceService; now?: () => number }) {
  const { pool } = deps;
  const now = deps.now ?? Date.now;

  // One consistent snapshot for the whole request: membership, consent, devices and data are read as of the same instant.
  async function snapshot<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* the original error matters more */ } throw e; } finally { c.release(); }
  }

  // ---- who is looked at, what may the viewer read, which computers count ------------------------------------------------------------------------
  async function targets(db: Db, viewer: Membership, only?: string): Promise<Target[]> {
    let rows: MemberRow[];
    if (only) rows = [await loadMember(db, viewer.familyId, only)];                         // a member of another family is "not found"
    else if (viewer.permissions.has('members.view')) rows = await loadAllMembers(db, viewer.familyId);
    else rows = [await loadMember(db, viewer.familyId, viewer.memberId)];                   // without members.view the viewer only sees themselves
    const sharing = await loadSharing(db, rows.map((r) => r.member_id));
    const out: Target[] = rows.map((member) => {
      const sh = sharing.get(member.member_id) as Sharing;
      const access = {} as Access;
      for (const c of Object.keys(sh) as PrivacyCategory[]) access[c] = canViewMemberData(viewer, { memberId: member.member_id, familyId: member.family_id, sharing: sh }, c);
      return { member, isSelf: member.member_id === viewer.memberId, access, deviceIds: [], deviceCount: 0, lastSyncAt: null };
    });
    const need = out.filter((t) => DASH_CATS.some((c) => t.access[c].allowed) || t.access.deviceInfo.allowed);
    if (need.length) {
      const d = await db.query<{ id: string; user_id: string; last_sync_at: Date | null; linked_member: string | null }>(
        `SELECT d.id, d.user_id, d.last_sync_at, fd.member_id AS linked_member FROM devices d
         LEFT JOIN family_devices fd ON fd.device_id = d.id AND fd.family_id = $1
         WHERE d.user_id = ANY($2::uuid[]) AND d.revoked_at IS NULL ORDER BY d.created_at, d.id`, [viewer.familyId, need.map((t) => t.member.user_id)]);
      for (const t of need) {
        const mine = d.rows.filter((r) => r.user_id === t.member.user_id && (t.isSelf || r.linked_member === t.member.member_id));
        t.deviceIds = mine.map((r) => r.id); t.deviceCount = mine.length;
        t.lastSyncAt = mine.reduce<Date | null>((m, r) => (r.last_sync_at && (!m || r.last_sync_at > m) ? r.last_sync_at : m), null);
      }
    }
    return out;
  }
  const can = (t: Target, c: DashCat) => t.access[c].allowed;
  const pairs = (ts: Target[]) => { const dev: string[] = []; const mem: string[] = []; for (const t of ts) for (const id of t.deviceIds) { dev.push(id); mem.push(t.member.member_id); } return { dev, mem }; };

  // ---- aggregation (SQL, per member): Active Work per day --------------------------------------------------------------------------------------
  type DayAgg = { ms: number; sessions: number; longestMs: number };
  async function usageByMember(db: Db, ts: Target[], from: string, to: string): Promise<Map<string, Map<string, DayAgg>>> {
    const out = new Map<string, Map<string, DayAgg>>(); const { dev, mem } = pairs(ts);
    if (!dev.length) return out;
    const r = await db.query<Row>(
      `SELECT m.member_id::text AS member_id, s.doc_key AS day,
         sum(LEAST(GREATEST((s.data->>'activeMs')::numeric, 0), 90000000))::float8 AS ms,
         sum(CASE WHEN jsonb_typeof(s.data->'sessions') = 'array' THEN jsonb_array_length(s.data->'sessions') ELSE 0 END)::int AS sessions,
         max((SELECT max(LEAST(GREATEST((x->>'activeMs')::numeric, 0), 90000000)) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.data->'sessions') = 'array' THEN s.data->'sessions' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x->'activeMs') = 'number'))::float8 AS longest
       FROM sync_documents s JOIN unnest($1::uuid[], $2::uuid[]) AS m(device_id, member_id) ON m.device_id = s.device_id
       WHERE s.kind = 'day' AND NOT s.deleted AND s.doc_key >= $3 AND s.doc_key <= $4 AND jsonb_typeof(s.data->'activeMs') = 'number'
       GROUP BY m.member_id, s.doc_key`, [dev, mem, from, to]);
    for (const row of r.rows) {
      const m = out.get(row['member_id']) ?? new Map<string, DayAgg>(); out.set(row['member_id'], m);
      m.set(row['day'], { ms: Number(row['ms']) || 0, sessions: Number(row['sessions']) || 0, longestMs: Number(row['longest']) || 0 });
    }
    return out;
  }

  // ---- aggregation (SQL, per member): time per application ---------------------------------------------------------------------------------------
  // The desktop rule travels with the data: program time of a day on a computer never exceeds that day's Active Work (unknown time is trimmed first, then
  // programs proportionally), see stats.js fitToActive. It is applied per computer and day, BEFORE anything is added up.
  const APPS_CTE = `WITH map AS MATERIALIZED (SELECT device_id, member_id FROM unnest($1::uuid[], $2::uuid[]) AS t(device_id, member_id)),
    ap AS MATERIALIZED (
      SELECT map.member_id, s.device_id, s.doc_key AS day, s.data->'apps' AS apps,
             CASE WHEN jsonb_typeof(s.data->'unknownMs') = 'number' THEN LEAST(GREATEST((s.data->>'unknownMs')::numeric, 0), 90000000) ELSE 0 END AS unk
      FROM sync_documents s JOIN map ON map.device_id = s.device_id
      WHERE s.kind = 'apps' AND NOT s.deleted AND s.doc_key >= $3 AND s.doc_key <= $4 AND jsonb_typeof(s.data->'apps') = 'object'),
    sums AS MATERIALIZED (SELECT ap.*, COALESCE((SELECT sum(LEAST(GREATEST((e.value #>> '{}')::numeric, 0), 90000000)) FROM jsonb_each(ap.apps) e WHERE jsonb_typeof(e.value) = 'number'), 0) AS s FROM ap),
    act AS MATERIALIZED (
      SELECT s.device_id, s.doc_key AS day, (s.data->>'activeMs')::numeric AS active
      FROM sync_documents s JOIN map ON map.device_id = s.device_id
      WHERE s.kind = 'day' AND NOT s.deleted AND s.doc_key >= $3 AND s.doc_key <= $4 AND jsonb_typeof(s.data->'activeMs') = 'number'),
    fit AS (
      SELECT sums.member_id, sums.device_id, sums.day, sums.apps, sums.unk, sums.s,
             CASE WHEN act.active IS NULL THEN 0 ELSE GREATEST(sums.unk + sums.s - act.active, 0) END AS excess
      FROM sums LEFT JOIN act ON act.device_id = sums.device_id AND act.day = sums.day),
    fit2 AS MATERIALIZED (
      SELECT fit.*, LEAST(unk, excess) AS from_unk,
             CASE WHEN s > 0 THEN GREATEST((s - GREATEST(excess - LEAST(unk, excess), 0)) / s, 0) ELSE 0 END AS factor
      FROM fit)`;

  type AppsAgg = { apps: AppTotal[]; unknownMs: number; clampedDays: number; days: number };
  async function appsByMember(db: Db, ts: Target[], from: string, to: string): Promise<Map<string, AppsAgg>> {
    const out = new Map<string, AppsAgg>(); const { dev, mem } = pairs(ts);
    if (!dev.length) return out;
    // ONE statement: the per-application rows and the per-member summary rows (app IS NULL) share the single materialised computation above.
    const r = await db.query<Row>(`${APPS_CTE}
      SELECT fit2.member_id::text AS member_id, e.key AS app, sum(floor(LEAST(GREATEST((e.value #>> '{}')::numeric, 0), 90000000) * fit2.factor))::float8 AS ms,
             NULL::float8 AS unknown_ms, NULL::int AS clamped_days, NULL::int AS days
      FROM fit2, jsonb_each(fit2.apps) e WHERE jsonb_typeof(e.value) = 'number' GROUP BY fit2.member_id, e.key
      UNION ALL
      SELECT member_id::text, NULL, NULL, sum(unk - from_unk)::float8, count(*) FILTER (WHERE excess > 0)::int, count(*)::int FROM fit2 GROUP BY member_id`, [dev, mem, from, to]);
    for (const x of r.rows) if (x['app'] === null) out.set(x['member_id'], { apps: [], unknownMs: Math.max(0, Number(x['unknown_ms']) || 0), clampedDays: Number(x['clamped_days']) || 0, days: Number(x['days']) || 0 });
    for (const x of r.rows) { const a = out.get(x['member_id']); if (a && x['app'] !== null && Number(x['ms']) > 0) a.apps.push({ app: String(x['app']), ms: Number(x['ms']) }); }
    return out;
  }

  // The member's own category choices (account-wide setting documents), only for members whose categories the viewer may read.
  async function overridesByMember(db: Db, ts: Target[]): Promise<Map<string, Map<string, AppCategory>>> {
    const out = new Map<string, Map<string, AppCategory>>();
    const users = ts.filter((t) => can(t, 'appCategories')); if (!users.length) return out;
    const r = await db.query<Row>(
      `SELECT user_id, substr(doc_key, 15) AS app, data #>> '{}' AS category FROM sync_documents
       WHERE kind = 'setting' AND device_id IS NULL AND NOT deleted AND user_id = ANY($1::uuid[]) AND doc_key LIKE 'apps.override.%'`, [users.map((t) => t.member.user_id)]);
    const byUser = new Map(users.map((t) => [t.member.user_id, t.member.member_id]));
    for (const row of r.rows) {
      const m = byUser.get(row['user_id']); if (!m || !isCategory(row['category'])) continue;
      const o = out.get(m) ?? new Map<string, AppCategory>(); out.set(m, o); o.set(String(row['app']).toLowerCase(), row['category']);
    }
    return out;
  }

  const person = (t: Target) => ({ memberId: t.member.member_id, petaliId: t.member.petali_id, displayName: t.member.display_name, role: t.member.role, isOwner: t.member.is_owner, isMe: t.isSelf });
  const sumRange = (days: Map<string, DayAgg> | undefined, from: string, to: string) => {
    let ms = 0; let n = 0; if (days) for (const [k, v] of days) if (k >= from && k <= to) { ms += v.ms; n += 1; }
    return { totalMs: Math.round(ms), daysWithData: n };
  };
  const byDayMap = (days: Map<string, DayAgg> | undefined, from: string, to: string) => { const m = new Map<string, number>(); if (days) for (const [k, v] of days) if (k >= from && k <= to) m.set(k, v.ms); return m; };
  const rangeDto = (w: Window) => ({ from: w.range.from, to: w.range.to, days: w.range.days, previous: { from: w.previous.from, to: w.previous.to }, today: w.today });

  // What a member's usage looks like for the viewer: restricted, empty (and why) or the numbers.
  function emptyReason(t: Target): 'no_devices_shared' | 'no_devices' | 'no_data' { return t.deviceIds.length === 0 ? (t.isSelf ? 'no_devices' : 'no_devices_shared') : 'no_data'; }
  function usageBlock(t: Target, days: Map<string, DayAgg> | undefined, w: Window) {
    if (!can(t, 'screenTime')) return restricted(t.access.screenTime);
    const cur = sumRange(days, w.range.from, w.range.to); const prev = sumRange(days, w.previous.from, w.previous.to);
    if (cur.daysWithData === 0) return { state: 'empty' as const, reason: emptyReason(t) };          // "no data" is never shown as 0
    return {
      state: 'ok' as const, totalMs: cur.totalMs, previousTotalMs: prev.daysWithData ? prev.totalMs : null, daysWithData: cur.daysWithData, daysInRange: w.range.days,
      dailyAverageMs: Math.round(cur.totalMs / cur.daysWithData), comparison: compareUsage(cur, prev, w.range.days, w.range.to >= w.today),
    };
  }

  // ---- 1. family overview -----------------------------------------------------------------------------------------------------------------------
  async function overview(userId: string, q: Record<string, unknown>) {
    const w = resolveWindow(q, now());
    return snapshot(async (db) => {
      const viewer = await requireMembership(db, userId);
      const famDevices = deps.devices.listFamily(userId);                       // same consent rules as the Devices tab (deviceInfo), read in parallel
      famDevices.catch(() => undefined);                                        // a failure is reported where it is awaited, never as an unhandled rejection
      const family = (await db.query<{ name: string }>('SELECT name FROM families WHERE id = $1', [viewer.familyId])).rows[0];
      const ts = await targets(db, viewer);
      const keys = dayKeys(w.range.from, w.range.to);
      const usageT = ts.filter((t) => can(t, 'screenTime') || can(t, 'usageHistory'));
      const usage = await usageByMember(db, usageT, w.previous.from, w.range.to);
      const appsT = ts.filter((t) => can(t, 'appUsage') || can(t, 'appCategories'));
      const apps = await appsByMember(db, appsT, w.range.from, w.range.to);
      const overrides = await overridesByMember(db, appsT);

      // members: each one's own numbers for the categories the viewer may read
      const members = ts.map((t) => ({
        ...person(t), access: accessDto(t.access),
        devices: can(t, 'screenTime') || t.access.deviceInfo.allowed ? { count: t.deviceCount, lastSyncAt: t.lastSyncAt ? t.lastSyncAt.toISOString() : null } : null,
        usage: usageBlock(t, usage.get(t.member.member_id), w) as Row,
      }));

      // family total: only members whose Active Work totals the viewer may read; the share of each is relative to THAT total
      const st = ts.filter((t) => can(t, 'screenTime'));
      const cur = st.map((t) => sumRange(usage.get(t.member.member_id), w.range.from, w.range.to));
      const prv = st.map((t) => sumRange(usage.get(t.member.member_id), w.previous.from, w.previous.to));
      const total = { totalMs: cur.reduce((a, b) => a + b.totalMs, 0), daysWithData: new Set(st.flatMap((t) => [...(usage.get(t.member.member_id)?.keys() ?? [])].filter((k) => k >= w.range.from && k <= w.range.to))).size };
      const ptotal = { totalMs: prv.reduce((a, b) => a + b.totalMs, 0), daysWithData: new Set(st.flatMap((t) => [...(usage.get(t.member.member_id)?.keys() ?? [])].filter((k) => k >= w.previous.from && k <= w.previous.to))).size };
      for (const m of members) {
        if (m.usage['state'] === 'ok') m.usage['share'] = share(m.usage['totalMs'], total.totalMs);
      }
      // The viewer's own data always counts (own data is never "restricted"), so a family-level section is never restricted as a whole: it says how many
      // members it includes instead.
      const totals = {
        state: total.daysWithData === 0 ? ('empty' as const) : ('ok' as const), includedMembers: st.length, totalMembers: ts.length,
        ...(total.daysWithData === 0 ? { reason: 'no_data' as const } : { totalMs: total.totalMs, previousTotalMs: ptotal.daysWithData ? ptotal.totalMs : null, daysWithData: total.daysWithData, comparison: compareUsage(total, ptotal, w.range.days, w.range.to >= w.today) }),
      };

      // family history: per day, stacked by member (members whose usageHistory the viewer may read)
      const ht = ts.filter((t) => can(t, 'usageHistory'));
      // Up to 62 days the series is per day; beyond that it is per calendar week (Monday), so a year of a big family stays a few dozen points, not thousands.
      const weekly = w.range.days > WEEKLY_AFTER_DAYS;
      const daily = (() => {
        const bucketKeys = weekly ? [...new Set(keys.map((k) => mondayOf(k)))] : keys;
        const days = bucketKeys.map((day) => {
          const inBucket = weekly ? keys.filter((k) => mondayOf(k) === day) : [day];
          const parts: Record<string, number> = {}; let any = false; let ms = 0;
          for (const t of ht) {
            let mine = 0; let has = false;
            for (const k of inBucket) { const v = usage.get(t.member.member_id)?.get(k); if (v) { mine += v.ms; has = true; } }
            if (has) { parts[t.member.member_id] = Math.round(mine); ms += mine; any = true; }
          }
          return { day, activeMs: any ? Math.round(ms) : null, byMember: parts, ...(weekly ? { daysInRange: inBucket.length } : {}) };
        });
        const have = days.some((d) => d.activeMs !== null);
        return { state: have ? ('ok' as const) : ('empty' as const), ...(have ? {} : { reason: 'no_data' as const }), granularity: weekly ? ('week' as const) : ('day' as const), includedMembers: ht.length, totalMembers: ts.length, days: have ? days : [] };
      })();

      // family applications and categories
      const at = ts.filter((t) => can(t, 'appUsage'));
      const famApps = (() => {
        const acc = new Map<string, number>(); let unk = 0; let withData = 0;
        for (const t of at) { const a = apps.get(t.member.member_id); if (!a) continue; withData += 1; unk += a.unknownMs; for (const x of a.apps) acc.set(x.app, (acc.get(x.app) ?? 0) + x.ms); }
        if (!withData) return { state: 'empty' as const, reason: 'no_data' as const, includedMembers: at.length, totalMembers: ts.length };
        return { state: 'ok' as const, includedMembers: at.length, totalMembers: ts.length, ...rankApps([...acc].map(([app, ms]) => ({ app, ms })), unk, undefined, false) };
      })();
      const ct = ts.filter((t) => can(t, 'appCategories'));
      const famCats = (() => {
        const acc = new Map<AppCategory, number>(); let total2 = 0; let withData = 0;
        for (const t of ct) {
          const a = apps.get(t.member.member_id); if (!a) continue; withData += 1;
          const c = categoryTotals(a.apps, a.unknownMs, overrides.get(t.member.member_id));
          for (const i of c.items) acc.set(i.category, (acc.get(i.category) ?? 0) + i.ms); total2 += c.totalMs;
        }
        if (!withData) return { state: 'empty' as const, reason: 'no_data' as const, includedMembers: ct.length, totalMembers: ts.length };
        return { state: 'ok' as const, includedMembers: ct.length, totalMembers: ts.length, totalMs: total2, items: CATEGORIES.map((category) => ({ category, ms: Math.round(acc.get(category) ?? 0), share: share(acc.get(category) ?? 0, total2) })).filter((i) => i.ms > 0).sort((a, b) => b.ms - a.ms) };
      })();

      const fd = await famDevices;
      const devices = fd.devices.map((d) => ({ id: d.id, name: d.name, isMine: d.isMine, owner: d.owner, detailHidden: d.detailHidden, detail: d.detail ? { status: d.detail.status, lastSyncAt: d.detail.lastSyncAt } : null }));
      return {
        generatedAt: new Date(now()).toISOString(), source: 'cloud-snapshot' as const, range: rangeDto(w),
        family: { id: viewer.familyId, name: family?.name ?? '' }, viewer: { memberId: viewer.memberId, role: viewer.role, isOwner: viewer.isOwner, canViewMemberData: viewer.permissions.has('memberData.view') },
        totals, members, daily, apps: famApps, categories: famCats, devices,
      };
    });
  }

  // ---- 2. one member ----------------------------------------------------------------------------------------------------------------------------
  async function member(userId: string, memberId: string, q: Record<string, unknown>) {
    const w = resolveWindow(q, now());
    return snapshot(async (db) => {
      const viewer = await requireMembership(db, userId);
      const t = (await targets(db, viewer, memberId))[0] as Target;
      const keys = dayKeys(w.range.from, w.range.to);
      const glanceFrom = addDays(w.today, -29);
      const needUsage = can(t, 'screenTime') || can(t, 'usageHistory');
      const lo = [w.previous.from, glanceFrom].sort()[0] as string; const hi = [w.range.to, w.today].sort().reverse()[0] as string;
      const usage = needUsage ? (await usageByMember(db, [t], lo, hi)).get(t.member.member_id) : undefined;
      const wantApps = can(t, 'appUsage') || can(t, 'appCategories');
      const apps = wantApps ? (await appsByMember(db, [t], w.range.from, w.range.to)).get(t.member.member_id) : undefined;
      const ov = can(t, 'appCategories') ? (await overridesByMember(db, [t])).get(t.member.member_id) : undefined;

      const usageSec = usageBlock(t, usage, w) as Row;
      if (usageSec['state'] !== 'restricted') {
        const g = (days: number) => { const s = sumRange(usage, addDays(w.today, -(days - 1)), w.today); return { days, totalMs: s.daysWithData ? s.totalMs : null, daysWithData: s.daysWithData }; };
        const todayRow = usage?.get(w.today);
        usageSec['glance'] = { today: { day: w.today, activeMs: todayRow ? Math.round(todayRow.ms) : null }, last7: g(7), last30: g(30) };
      }
      let trend: Row;
      if (!can(t, 'usageHistory')) trend = restricted(t.access.usageHistory);
      else {
        const by = byDayMap(usage, w.range.from, w.range.to);
        if (by.size === 0) trend = { state: 'empty', reason: emptyReason(t) };
        else {
          let best: { day: string; activeMs: number } | null = null; for (const [k, v] of by) if (!best || v > best.activeMs) best = { day: k, activeMs: Math.round(v) };
          trend = { state: 'ok', daily: dailySeries(keys, by), weekly: w.range.days > 7 ? weeklyBuckets(keys, by) : [], monthly: new Set(keys.map((k) => k.slice(0, 7))).size > 1 ? monthlyBuckets(keys, by) : [], bestDay: best, trend: trendOf(keys, by), totalMs: Math.round(sumOf(by)) };
        }
      }
      const appsSec = !can(t, 'appUsage') ? restricted(t.access.appUsage)
        : !apps || apps.days === 0 ? { state: 'empty' as const, reason: emptyReason(t) }
          : { state: 'ok' as const, ...rankApps(apps.apps, apps.unknownMs, ov, can(t, 'appCategories')), clampedDays: apps.clampedDays, daysWithData: apps.days };
      const catSec = !can(t, 'appCategories') ? restricted(t.access.appCategories)
        : !apps || apps.days === 0 ? { state: 'empty' as const, reason: emptyReason(t) }
          : { state: 'ok' as const, ...categoryTotals(apps.apps, apps.unknownMs, ov), daysWithData: apps.days };
      return {
        generatedAt: new Date(now()).toISOString(), source: 'cloud-snapshot' as const, range: rangeDto(w),
        member: person(t), access: accessDto(t.access),
        devices: { scope: t.isSelf ? ('own' as const) : ('family-linked' as const), count: t.deviceCount, lastSyncAt: (can(t, 'screenTime') || can(t, 'usageHistory')) && t.lastSyncAt ? t.lastSyncAt.toISOString() : null },
        usage: usageSec, trend, apps: appsSec, categories: catSec,
      };
    });
  }

  // ---- 3. history list (paginated, newest first) ------------------------------------------------------------------------------------------------
  async function history(userId: string, memberId: string, q: Record<string, unknown>) {
    const w = resolveWindow(q, now());
    const limit = q['limit'] === undefined ? 31 : Number(q['limit']);
    if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw badRequest('validation_failed', 'limit must be between 1 and 60.');
    const before = q['before'];
    if (before !== undefined && (typeof before !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(before))) throw badRequest('validation_failed', 'before must be a calendar day.');
    return snapshot(async (db) => {
      const viewer = await requireMembership(db, userId);
      const t = (await targets(db, viewer, memberId))[0] as Target;
      const base = { generatedAt: new Date(now()).toISOString(), source: 'cloud-snapshot' as const, range: rangeDto(w), member: person(t) };
      if (!can(t, 'usageHistory')) return { ...base, ...restricted(t.access.usageHistory), days: [], nextBefore: null };
      const { dev, mem } = pairs([t]);
      if (!dev.length) return { ...base, state: 'empty' as const, reason: emptyReason(t), days: [], nextBefore: null };
      const upper = typeof before === 'string' && before <= w.range.to ? addDays(before, -1) : w.range.to;
      const r = await db.query<Row>(
        `SELECT s.doc_key AS day, sum(LEAST(GREATEST((s.data->>'activeMs')::numeric, 0), 90000000))::float8 AS ms,
           sum(CASE WHEN jsonb_typeof(s.data->'sessions') = 'array' THEN jsonb_array_length(s.data->'sessions') ELSE 0 END)::int AS sessions,
           max((SELECT max(LEAST(GREATEST((x->>'activeMs')::numeric, 0), 90000000)) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.data->'sessions') = 'array' THEN s.data->'sessions' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x->'activeMs') = 'number'))::float8 AS longest
         FROM sync_documents s JOIN unnest($1::uuid[], $2::uuid[]) AS m(device_id, member_id) ON m.device_id = s.device_id
         WHERE s.kind = 'day' AND NOT s.deleted AND s.doc_key >= $3 AND s.doc_key <= $4 AND jsonb_typeof(s.data->'activeMs') = 'number'
         GROUP BY s.doc_key ORDER BY s.doc_key DESC LIMIT $5`, [dev, mem, w.range.from, upper, limit + 1]);
      const page = r.rows.slice(0, limit);
      const days = page.map((x) => ({ day: String(x['day']), activeMs: Math.round(Number(x['ms']) || 0), sessions: Number(x['sessions']) || 0, longestSessionMs: Math.round(Number(x['longest']) || 0) }));
      return { ...base, state: days.length || before !== undefined ? ('ok' as const) : ('empty' as const), ...(days.length || before !== undefined ? {} : { reason: 'no_data' as const }), days, nextBefore: r.rows.length > limit ? (days[days.length - 1] as { day: string }).day : null, lastSyncAt: t.lastSyncAt ? t.lastSyncAt.toISOString() : null };
    });
  }

  // ---- 4. reports: daily / weekly / monthly -----------------------------------------------------------------------------------------------------
  async function report(userId: string, memberId: string, kind: string, q: Record<string, unknown>) {
    const w0 = resolveWindow({ today: q['today'], from: undefined, to: undefined }, now());       // validates `today`
    const period = periodFor(kind, q['key'], w0.today);
    if ('error' in period) throw badRequest(`report_${period.error.replace('-', '_')}`, period.error === 'invalid-kind' ? 'kind must be daily, weekly or monthly.' : period.error === 'invalid-key' ? 'The period key is not valid.' : 'That period has not started yet.');
    const prevKey = neighbour(period.kind as ReportKind, period.key, -1);
    const prevP = periodFor(period.kind, prevKey, w0.today);
    return snapshot(async (db) => {
      const viewer = await requireMembership(db, userId);
      const t = (await targets(db, viewer, memberId))[0] as Target;
      const head = { generatedAt: new Date(now()).toISOString(), source: 'cloud-snapshot' as const, member: person(t), period: { kind: period.kind, key: period.key, from: period.from, to: period.to, days: period.dayKeys.length, elapsedDays: period.elapsedKeys.length, today: w0.today } };
      if (!can(t, 'individualReports')) return { ...head, ...restricted(t.access.individualReports), navigation: { previous: null, next: null } };
      const { dev, mem } = pairs([t]);
      const first = dev.length ? (await db.query<{ a: string | null }>(`SELECT min(s.doc_key) AS a FROM sync_documents s WHERE s.kind = 'day' AND NOT s.deleted AND s.device_id = ANY($1::uuid[])`, [dev])).rows[0]?.a ?? null : null;
      const lo = 'error' in prevP ? period.from : prevP.from;
      const usage = (await usageByMember(db, [t], lo, period.to)).get(t.member.member_id);
      const cur = byDayMap(usage, period.from, period.to);
      const prevMap = 'error' in prevP ? new Map<string, number>() : byDayMap(usage, prevP.from, prevP.to);
      const next = neighbour(period.kind as ReportKind, period.key, 1);
      const nav = { previous: first !== null && addDays(period.from, -1) < first ? null : prevKey, next: 'error' in periodFor(period.kind, next, w0.today) ? null : next };
      const incomplete = period.isCurrent || (first !== null && period.from < first);
      if (!dev.length || (cur.size === 0 && prevMap.size === 0)) return { ...head, state: 'empty' as const, reason: emptyReason(t), incomplete, navigation: nav };
      const curT = { totalMs: Math.round(sumOf(cur)), daysWithData: cur.size }; const prevT = { totalMs: Math.round(sumOf(prevMap)), daysWithData: prevMap.size };
      // each section of a report is still gated by its own category
      const usageSec = can(t, 'screenTime')
        ? { state: 'ok' as const, totalMs: curT.totalMs, daysWithData: curT.daysWithData, dailyAverageMs: curT.daysWithData ? Math.round(curT.totalMs / curT.daysWithData) : null, comparison: compareUsage(curT, prevT, period.dayKeys.length, period.isCurrent), previousTotalMs: prevT.daysWithData ? prevT.totalMs : null }
        : restricted(t.access.screenTime);
      let best: { day: string; activeMs: number } | null = null; for (const [k, v] of cur) if (!best || v > best.activeMs) best = { day: k, activeMs: Math.round(v) };
      const daysSec = can(t, 'usageHistory') ? { state: 'ok' as const, days: dailySeries(period.dayKeys, cur), bestDay: best, trend: period.dayKeys.length >= 7 ? trendOf(period.dayKeys, cur) : null } : restricted(t.access.usageHistory);
      const wantApps = can(t, 'appUsage') || can(t, 'appCategories');
      const ap = wantApps ? (await appsByMember(db, [t], period.from, period.to)).get(t.member.member_id) : undefined;
      const ov = can(t, 'appCategories') ? (await overridesByMember(db, [t])).get(t.member.member_id) : undefined;
      const appsSec = !can(t, 'appUsage') ? restricted(t.access.appUsage) : !ap || ap.days === 0 ? { state: 'empty' as const, reason: 'no_data' as const } : { state: 'ok' as const, ...rankApps(ap.apps, ap.unknownMs, ov, can(t, 'appCategories')) };
      const catSec = !can(t, 'appCategories') ? restricted(t.access.appCategories) : !ap || ap.days === 0 ? { state: 'empty' as const, reason: 'no_data' as const } : { state: 'ok' as const, ...categoryTotals(ap.apps, ap.unknownMs, ov) };
      return { ...head, state: 'ok' as const, incomplete, usage: usageSec, history: daysSec, apps: appsSec, categories: catSec, navigation: nav, lastSyncAt: (can(t, 'screenTime') || can(t, 'usageHistory')) && t.lastSyncAt ? t.lastSyncAt.toISOString() : null };
    });
  }

  return { overview, member, history, report };
}
export type DashboardService = ReturnType<typeof createDashboardService>;
