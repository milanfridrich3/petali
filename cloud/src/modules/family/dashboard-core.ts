import { badRequest } from '../../lib/errors';
import { COMPARE, addDays, mondayOf, parseDay } from '../web/report-core';
import { BUILTIN_APP_CATEGORIES, FALLBACK_CATEGORY, APP_CATEGORIES, type AppCategory } from './app-category-table';

// Pure helpers of the Family Dashboard (Stage 2): nothing here touches the database, the clock or a request, so every rule is testable on its own.
//
// Calendar rule (the one that keeps activity on the right day): a synchronised "day" document is keyed by the owning computer's LOCAL calendar day.
// Those keys are only ever compared and shifted as plain calendar labels (no time zone, no UTC conversion). The CLIENT says what "today" is on its own
// calendar and which days it wants; the server validates the labels and never reinterprets them.
const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;
export const MIN_DAY_KEY = '2020-01-01';
export const CATEGORIES: readonly AppCategory[] = APP_CATEGORIES;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const dayIndex = (key: string): number => Math.round((parseDay(key) as Date).getTime() / DAY_MS);
export const daysBetween = (from: string, to: string): number => dayIndex(to) - dayIndex(from) + 1;          // inclusive
export const utcDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export type Range = { from: string; to: string; days: number };
export type Window = { range: Range; previous: Range; today: string };

// `today` is the client's own calendar day. Time zones span UTC-12 .. UTC+14, so a real "today" is never more than one day away from the UTC date; anything
// else is a wrong clock or an attempt to ask for the future.
export function resolveWindow(q: { from?: unknown; to?: unknown; today?: unknown }, nowMs: number): Window {
  const utc = utcDayKey(nowMs);
  const today = q.today === undefined ? utc : q.today;
  if (typeof today !== 'string' || !parseDay(today)) throw badRequest('invalid_today', 'today must be a calendar day (YYYY-MM-DD).');
  if (today < addDays(utc, -1) || today > addDays(utc, 1)) throw badRequest('invalid_today', 'today is not a plausible calendar day.');
  const from = q.from === undefined ? today : q.from;
  const to = q.to === undefined ? today : q.to;
  if (typeof from !== 'string' || typeof to !== 'string' || !parseDay(from) || !parseDay(to)) throw badRequest('invalid_range', 'from and to must be calendar days (YYYY-MM-DD).');
  if (from > to) throw badRequest('invalid_range', 'from must not be after to.');
  if (from < MIN_DAY_KEY) throw badRequest('invalid_range', 'The range starts before Petali existed.');
  if (to > today) throw badRequest('range_in_future', 'The range ends in the future.');
  const days = daysBetween(from, to);
  if (days > MAX_RANGE_DAYS) throw badRequest('range_too_long', `The range can be at most ${MAX_RANGE_DAYS} days.`);
  const prevTo = addDays(from, -1);
  return { range: { from, to, days }, previous: { from: addDays(prevTo, -(days - 1)), to: prevTo, days }, today };
}

export function dayKeys(from: string, to: string): string[] {
  const out: string[] = []; for (let k = from, i = 0; k <= to && i <= MAX_RANGE_DAYS + 1; k = addDays(k, 1), i += 1) out.push(k);
  return out;
}

// ---- categories (resolved when read, exactly like the desktop: the user's own choice, the built-in table, Other) -------------------------------
const FORBIDDEN_IN_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
export const isAppId = (v: unknown): v is string => typeof v === 'string' && v.length >= 5 && v.length <= 128 && !FORBIDDEN_IN_NAME.test(v) && v.endsWith('.exe');
export const isCategory = (v: unknown): v is AppCategory => typeof v === 'string' && (APP_CATEGORIES as readonly string[]).includes(v);
export function resolveCategory(appId: string, overrides: ReadonlyMap<string, AppCategory> | undefined): AppCategory {
  const id = appId.trim().toLowerCase();
  return overrides?.get(id) ?? BUILTIN_APP_CATEGORIES[id] ?? FALLBACK_CATEGORY;
}

export type AppTotal = { app: string; ms: number };
export type CategoryItem = { category: AppCategory; ms: number; share: number | null };

// Per-category totals of one member's (or the family's) app time; unidentified time counts as "Other", as on the desktop.
export function categoryTotals(apps: AppTotal[], unknownMs: number, overrides: ReadonlyMap<string, AppCategory> | undefined): { items: CategoryItem[]; totalMs: number } {
  const acc = new Map<AppCategory, number>();
  for (const a of apps) { const c = isAppId(a.app) ? resolveCategory(a.app, overrides) : FALLBACK_CATEGORY; acc.set(c, (acc.get(c) ?? 0) + a.ms); }
  if (unknownMs > 0) acc.set(FALLBACK_CATEGORY, (acc.get(FALLBACK_CATEGORY) ?? 0) + unknownMs);
  const totalMs = [...acc.values()].reduce((a, b) => a + b, 0);
  const items = CATEGORIES.map((category) => ({ category, ms: Math.round(acc.get(category) ?? 0), share: totalMs > 0 ? (acc.get(category) ?? 0) / totalMs : null })).filter((i) => i.ms > 0).sort((a, b) => b.ms - a.ms);
  return { items, totalMs: Math.round(totalMs) };
}

export const TOP_APPS = 15;
export function rankApps(apps: AppTotal[], unknownMs: number, overrides: ReadonlyMap<string, AppCategory> | undefined, includeCategory: boolean) {
  const valid = apps.filter((a) => isAppId(a.app) && a.ms > 0).sort((x, y) => y.ms - x.ms || (x.app < y.app ? -1 : 1));
  const attributedMs = Math.round(valid.reduce((a, b) => a + b.ms, 0) + apps.filter((a) => !isAppId(a.app)).reduce((a, b) => a + Math.max(0, b.ms), 0) + unknownMs);
  const top = valid.slice(0, TOP_APPS);
  const otherMs = Math.round(attributedMs - unknownMs - top.reduce((a, b) => a + b.ms, 0));
  return {
    top: top.map((a) => ({ app: a.app, ms: Math.round(a.ms), share: attributedMs > 0 ? a.ms / attributedMs : null, ...(includeCategory ? { category: resolveCategory(a.app, overrides) } : {}) })),
    otherMs: Math.max(0, otherMs), unknownMs: Math.round(unknownMs), attributedMs,
  };
}

// ---- comparison and trend ---------------------------------------------------------------------------------------------------------------------
export type Totals = { totalMs: number; daysWithData: number };

// Compares DAILY AVERAGES over the days that really have data, so a period with a late synchronisation is not mistaken for "less usage". A comparison
// needs enough real days on BOTH sides (the same thresholds as the Petali reports); otherwise it says why it cannot be made. Nothing is guessed.
export function compareUsage(cur: Totals, prev: Totals, rangeDays: number, currentIsPartial: boolean) {
  const need = Math.min(rangeDays, rangeDays >= 28 ? COMPARE.monthly.minDays : rangeDays >= 7 ? COMPARE.weekly.minDays : 1);
  if (cur.daysWithData < need) return { available: false as const, reason: 'not-enough-current-data' as const };
  if (prev.daysWithData < need) return { available: false as const, reason: 'not-enough-previous-data' as const };
  const a = cur.totalMs / cur.daysWithData; const b = prev.totalMs / prev.daysWithData;
  return { available: true as const, basis: 'daily-average' as const, currentAvgMs: Math.round(a), previousAvgMs: Math.round(b), changeMs: Math.round(a - b), changeRatio: b > 0 ? (a - b) / b : null, partial: currentIsPartial };
}

export const TREND_THRESHOLD = 0.15;
// First half of the range against the second half (by calendar, not by index), averaged over days with data. Needs a real week and data on both halves.
export function trendOf(keys: string[], byDay: ReadonlyMap<string, number>) {
  if (keys.length < 7) return null;
  const mid = Math.ceil(keys.length / 2);
  const part = (ks: string[]) => { const v = ks.filter((k) => byDay.has(k)).map((k) => byDay.get(k) as number); return { n: v.length, avg: v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0 }; };
  const a = part(keys.slice(0, mid)); const b = part(keys.slice(mid));
  if (a.n < 2 || b.n < 2) return null;
  const ratio = a.avg > 0 ? (b.avg - a.avg) / a.avg : null;
  const direction = ratio === null ? (b.avg > 0 ? 'up' : 'flat') : ratio > TREND_THRESHOLD ? 'up' : ratio < -TREND_THRESHOLD ? 'down' : 'flat';
  return { direction: direction as 'up' | 'down' | 'flat', firstHalfAvgMs: Math.round(a.avg), secondHalfAvgMs: Math.round(b.avg), changeRatio: ratio };
}

export type DailyPoint = { day: string; activeMs: number | null };
export function dailySeries(keys: string[], byDay: ReadonlyMap<string, number>): DailyPoint[] { return keys.map((day) => ({ day, activeMs: byDay.has(day) ? Math.round(byDay.get(day) as number) : null })); }   // null = no data, never 0

export function weeklyBuckets(keys: string[], byDay: ReadonlyMap<string, number>) {
  const out = new Map<string, { weekStart: string; activeMs: number; daysWithData: number; daysInRange: number }>();
  for (const k of keys) {
    const w = mondayOf(k); const b = out.get(w) ?? { weekStart: w, activeMs: 0, daysWithData: 0, daysInRange: 0 };
    b.daysInRange += 1; if (byDay.has(k)) { b.daysWithData += 1; b.activeMs += byDay.get(k) as number; } out.set(w, b);
  }
  return [...out.values()].map((b) => ({ ...b, activeMs: Math.round(b.activeMs) }));
}
export function monthlyBuckets(keys: string[], byDay: ReadonlyMap<string, number>) {
  const out = new Map<string, { month: string; activeMs: number; daysWithData: number; daysInRange: number }>();
  for (const k of keys) {
    const m = k.slice(0, 7); const b = out.get(m) ?? { month: m, activeMs: 0, daysWithData: 0, daysInRange: 0 };
    b.daysInRange += 1; if (byDay.has(k)) { b.daysWithData += 1; b.activeMs += byDay.get(k) as number; } out.set(m, b);
  }
  return [...out.values()].map((b) => ({ ...b, activeMs: Math.round(b.activeMs) }));
}

export const sumOf = (m: ReadonlyMap<string, number>): number => { let s = 0; for (const v of m.values()) s += v; return s; };
export const clampMs = (v: unknown, max = 25 * 3_600_000): number => (isNum(v) ? Math.min(Math.max(v, 0), max) : 0);
export const share = (ms: number, total: number): number | null => (total > 0 ? ms / total : null);
