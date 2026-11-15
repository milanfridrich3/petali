// Account-wide plant progression, computed from the plant LEDGERS the desktop apps synchronise (kind 'plant').
// This is a port of the account formula in the desktop's plant-growth.js (PlantGrowth._ledgerTotal / view); it is checked against that module by
// test/fixtures/plant-vectors.json (generated from the desktop code), so the web can never show a different stage than the desktop does:
//     growth = max(base of any computer) + sum over days of min(DAILY_CAP, sum of every computer's credit that day)
// The web app only DISPLAYS this; it never earns or changes growth.
const H = 3_600_000;
export const STAGES = [{ id: 'seed', atMs: 0 }, { id: 'sprout', atMs: 2 * H }, { id: 'young', atMs: 10 * H }, { id: 'mature', atMs: 30 * H }] as const;
export const DAILY_CAP_MS = 4 * H;
export const MAX_GROWTH_MS = 1000 * H;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type Ledger = { baseMs: number; days: Record<string, number> };
export type LedgerInput = { deviceId: string; name?: string; removed?: boolean; ledger: unknown };

export function sanitizeLedger(raw: unknown): Ledger | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const baseMs = isNum(r['baseMs']) && r['baseMs'] >= 0 ? Math.min(r['baseMs'], MAX_GROWTH_MS) : 0;
  const days: Record<string, number> = {};
  if (r['days'] && typeof r['days'] === 'object' && !Array.isArray(r['days'])) {
    for (const [k, v] of Object.entries(r['days'] as Record<string, unknown>)) if (DAY_KEY_RE.test(k) && isNum(v) && v >= 0) days[k] = Math.min(v, DAILY_CAP_MS);
  }
  return { baseMs, days };
}

export function stageIndexOf(growthMs: number): number {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i += 1) if (growthMs >= STAGES[i]!.atMs) idx = i;
  return idx;
}

export type PlantView = {
  stage: (typeof STAGES)[number]['id']; stageIndex: number; progress: number; growthMinutes: number;
  nextStage: { id: string; atMinutes: number; remainingMinutes: number } | null;
  stages: { id: string; atMinutes: number; reached: boolean }[];
  dailyCapMinutes: number;
  perDevice: { deviceId: string; name: string | null; removed: boolean; creditedMinutes: number }[];
  recentDays: { day: string; minutes: number }[];     // account growth credited per day (capped), newest last, only days with a credit
  lastCreditDay: string | null;
  computers: number;                                   // computers that have a ledger
};

export function accountPlant(inputs: LedgerInput[], opts: { recentDays?: number } = {}): PlantView | null {
  const ledgers = inputs.map((i) => ({ i, l: sanitizeLedger(i.ledger) })).filter((x): x is { i: LedgerInput; l: Ledger } => x.l !== null);
  if (ledgers.length === 0) return null;
  let base = 0;
  const dayTotals = new Map<string, number>();
  for (const { l } of ledgers) {
    base = Math.max(base, l.baseMs);
    for (const [k, v] of Object.entries(l.days)) dayTotals.set(k, (dayTotals.get(k) ?? 0) + v);
  }
  let sum = 0;
  const capped: { day: string; ms: number }[] = [];
  for (const [k, v] of dayTotals) { const c = Math.min(DAILY_CAP_MS, v); sum += c; if (c > 0) capped.push({ day: k, ms: c }); }
  capped.sort((a, b) => (a.day < b.day ? -1 : 1));
  const growthMs = Math.min(MAX_GROWTH_MS, base + sum);
  const idx = stageIndexOf(growthMs);
  const cur = STAGES[idx]!; const next = STAGES[idx + 1];
  const progress = next ? Math.min(1, Math.max(0, (growthMs - cur.atMs) / (next.atMs - cur.atMs))) : 1;
  const growthMinutes = Math.floor(growthMs / 60000);
  const n = opts.recentDays ?? 14;
  return {
    stage: cur.id, stageIndex: idx, progress, growthMinutes,
    nextStage: next ? { id: next.id, atMinutes: next.atMs / 60000, remainingMinutes: Math.max(0, Math.ceil((next.atMs - growthMs) / 60000)) } : null,
    stages: STAGES.map((s) => ({ id: s.id, atMinutes: s.atMs / 60000, reached: growthMs >= s.atMs })),
    dailyCapMinutes: DAILY_CAP_MS / 60000,
    perDevice: ledgers.map(({ i, l }) => ({ deviceId: i.deviceId, name: i.name ?? null, removed: !!i.removed, creditedMinutes: Math.round(Object.values(l.days).reduce((a, b) => a + b, 0) / 60000) })),
    recentDays: capped.slice(-n).map((c) => ({ day: c.day, minutes: Math.round(c.ms / 60000) })),
    lastCreditDay: capped.length ? capped[capped.length - 1]!.day : null,
    computers: ledgers.length,
  };
}
