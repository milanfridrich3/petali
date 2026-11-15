import type { Db } from './access';

// Per-device history summary, computed ONLY from the documents of that one device (device_id = target), so two computers can never be mixed
// or double-counted. Days are each computer's own local calendar days; the window is counted back from the cloud's current date (UTC).
// The desktop builds the same shape for its own computer from its local files (device-summary.js), so both views agree.
export const SUMMARY_TOP_APPS = 20;
export type Summary = {
  range: { days: number; from: string; to: string };
  usage: { activeMs: number; activeDays: number; daily: { day: string; activeMs: number; sessions: number }[] };
  apps: { attributedMs: number; unknownMs: number; top: { app: string; ms: number }[]; otherMs: number };
  health: { episodes: number; months: { month: string; episodes: number }[]; topProblems: { id: string; episodes: number }[] };
  performance: { months: string[] };
  coverage: { firstDay: string | null; lastDay: string | null; usageDays: number };
};

const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function buildSummary(db: Db, userId: string, deviceId: string, days: number, nowMs: number): Promise<Summary> {
  const to = dayKeyOf(nowMs + 86_400_000);                       // a computer ahead of UTC may already be on the next calendar day
  const from = dayKeyOf(nowMs - (days - 1) * 86_400_000);
  const fromMonth = from.slice(0, 7);
  const id = [userId, deviceId];

  const day = await db.query<{ k: string; ms: string; n: number }>(
    `SELECT doc_key AS k, (data->>'activeMs')::numeric::text AS ms, jsonb_array_length(data->'sessions') AS n FROM sync_documents
     WHERE user_id = $1 AND device_id = $2 AND kind = 'day' AND NOT deleted AND doc_key >= $3 AND doc_key <= $4 ORDER BY doc_key`, [...id, from, to]);
  const apps = await db.query<{ unk: string; apps: Record<string, number> }>(
    `SELECT COALESCE(data->>'unknownMs', '0') AS unk, data->'apps' AS apps FROM sync_documents
     WHERE user_id = $1 AND device_id = $2 AND kind = 'apps' AND NOT deleted AND doc_key >= $3 AND doc_key <= $4`, [...id, from, to]);
  const health = await db.query<{ month: string; id: string; n: number }>(
    `SELECT d.doc_key AS month, l->>'id' AS id, count(*)::int AS n FROM sync_documents d, jsonb_array_elements(d.data->'lines') l
     WHERE d.user_id = $1 AND d.device_id = $2 AND d.kind = 'health' AND NOT d.deleted AND d.doc_key >= $3 AND l->>'k' = 'start' GROUP BY 1, 2`, [...id, fromMonth]);
  const perf = await db.query<{ k: string }>(`SELECT doc_key AS k FROM sync_documents WHERE user_id = $1 AND device_id = $2 AND kind = 'rollup' AND NOT deleted AND doc_key >= $3 ORDER BY doc_key`, [...id, fromMonth]);
  const cover = await db.query<{ a: string | null; b: string | null; n: number }>(`SELECT min(doc_key) AS a, max(doc_key) AS b, count(*)::int AS n FROM sync_documents WHERE user_id = $1 AND device_id = $2 AND kind = 'day' AND NOT deleted`, id);

  const daily = day.rows.map((r) => ({ day: r.k, activeMs: Math.round(Number(r.ms)), sessions: r.n }));
  const totals = new Map<string, number>(); let unknownMs = 0;
  for (const r of apps.rows) {
    unknownMs += Number(r.unk) || 0;
    for (const [app, ms] of Object.entries(r.apps ?? {})) if (typeof ms === 'number' && Number.isFinite(ms)) totals.set(app, (totals.get(app) ?? 0) + ms);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = ranked.slice(0, SUMMARY_TOP_APPS).map(([app, ms]) => ({ app, ms }));
  const otherMs = ranked.slice(SUMMARY_TOP_APPS).reduce((a, [, ms]) => a + ms, 0);
  const attributedMs = ranked.reduce((a, [, ms]) => a + ms, 0) + unknownMs;

  const byMonth = new Map<string, number>(); const byProblem = new Map<string, number>();
  for (const r of health.rows) { byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.n); byProblem.set(r.id, (byProblem.get(r.id) ?? 0) + r.n); }
  const c = cover.rows[0];
  return {
    range: { days, from, to: dayKeyOf(nowMs) },
    usage: { activeMs: daily.reduce((a, d) => a + d.activeMs, 0), activeDays: daily.filter((d) => d.activeMs > 0).length, daily },
    apps: { attributedMs, unknownMs, top, otherMs },
    health: { episodes: [...byMonth.values()].reduce((a, b) => a + b, 0), months: [...byMonth.entries()].sort().map(([month, episodes]) => ({ month, episodes })), topProblems: [...byProblem.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([id, episodes]) => ({ id, episodes })) },
    performance: { months: perf.rows.map((r) => r.k) },
    coverage: { firstDay: c?.a ?? null, lastDay: c?.b ?? null, usageDays: c?.n ?? 0 },
  };
}
