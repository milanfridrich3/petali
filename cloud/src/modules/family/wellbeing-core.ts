import { APP_CATEGORIES } from './app-category-table';

// Digital Wellbeing rules (Stage 3): the ONE description of what a rule may contain. The desktop app has the same rules in wellbeing-core.js and
// test/fixtures/wellbeing-vectors.json is checked by both suites, so the two cannot drift apart. Everything here is pure.
//
// What a rule can and cannot do: Petali evaluates rules on the Windows computer and REMINDS (notifications and in-app status). It never blocks an
// application, locks the computer or ends a session: those restrictions cannot be enforced reliably by this architecture, and the product decision is
// that Petali stays a soft, honest tool.

export type RuleKind = 'limit' | 'schedule' | 'break';
export const RULE_KINDS: readonly RuleKind[] = ['limit', 'schedule', 'break'];
export const isRuleKind = (v: unknown): v is RuleKind => typeof v === 'string' && (RULE_KINDS as readonly string[]).includes(v);

export const LIMITS = Object.freeze({ maxMinutes: 1440, maxLimitRules: 30, maxScheduleRules: 20, maxDevices: 20, maxNameLength: 40 });
export const APP_ID_RE = /^[a-z0-9][a-z0-9 ._()+-]{0,79}$/;       // lower-case process name as the desktop records it ("chrome.exe")
export const CLOUD_DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export type LimitConfig = { enabled: boolean; scope: 'total' | 'category' | 'app'; category?: string; app?: string; minutes: number; warnAtPercent: number; deviceIds: string[] };
export type ScheduleConfig = { enabled: boolean; name: string; days: number[]; start: string; end: string; leadMinutes: number; deviceIds: string[] };
export type BreakConfig = { enabled: boolean; intervalMinutes: number; breakMinutes: number; snoozeMinutes: number; style: 'notification' | 'quiet' };
export type RuleConfig = LimitConfig | ScheduleConfig | BreakConfig;

export const DEFAULT_BREAK: Readonly<BreakConfig> = Object.freeze({ enabled: true, intervalMinutes: 60, breakMinutes: 5, snoozeMinutes: 10, style: 'notification' });

function strictKeys(o: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unknown field "${k}"`;
  return null;
}
function deviceIds(v: unknown): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > LIMITS.maxDevices) return 'deviceIds must be a short list';
  const out: string[] = [];
  for (const d of v) { if (typeof d !== 'string' || !CLOUD_DEVICE_ID_RE.test(d)) return 'deviceIds must contain device ids'; const l = d.toLowerCase(); if (!out.includes(l)) out.push(l); }
  return out;
}

export function parseTime(s: string): number | null { const m = TIME_RE.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

// Validates and normalises a rule body. Returns the clean config or an error text (never throws): unknown fields are an error, not ignored.
export function validateConfig(kind: RuleKind, raw: unknown): { ok: true; config: RuleConfig } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'The rule must be an object.' };
  const enabled = raw['enabled'] === undefined ? true : raw['enabled'];
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false.' };
  if (kind === 'limit') {
    const bad = strictKeys(raw, ['enabled', 'scope', 'category', 'app', 'minutes', 'warnAtPercent', 'deviceIds']); if (bad) return { ok: false, error: bad };
    const scope = raw['scope'];
    if (scope !== 'total' && scope !== 'category' && scope !== 'app') return { ok: false, error: 'scope must be total, category or app.' };
    if (!int(raw['minutes'], 1, LIMITS.maxMinutes)) return { ok: false, error: `minutes must be a whole number from 1 to ${LIMITS.maxMinutes}.` };
    const warn = raw['warnAtPercent'] === undefined ? 80 : raw['warnAtPercent'];
    if (!int(warn, 50, 99)) return { ok: false, error: 'warnAtPercent must be from 50 to 99.' };
    const ids = deviceIds(raw['deviceIds']); if (typeof ids === 'string') return { ok: false, error: ids };
    const cfg: LimitConfig = { enabled, scope, minutes: raw['minutes'], warnAtPercent: warn, deviceIds: ids };
    if (scope === 'category') {
      if (typeof raw['category'] !== 'string' || !(APP_CATEGORIES as readonly string[]).includes(raw['category'])) return { ok: false, error: 'category is not a known category.' };
      cfg.category = raw['category'];
    } else if (raw['category'] !== undefined) return { ok: false, error: 'category is only allowed for category limits.' };
    if (scope === 'app') {
      if (typeof raw['app'] !== 'string' || !APP_ID_RE.test(raw['app'])) return { ok: false, error: 'app must be an application name such as "chrome.exe".' };
      cfg.app = raw['app'];
    } else if (raw['app'] !== undefined) return { ok: false, error: 'app is only allowed for application limits.' };
    return { ok: true, config: cfg };
  }
  if (kind === 'schedule') {
    const bad = strictKeys(raw, ['enabled', 'name', 'days', 'start', 'end', 'leadMinutes', 'deviceIds']); if (bad) return { ok: false, error: bad };
    const name = typeof raw['name'] === 'string' ? raw['name'].normalize('NFC').replace(/\s+/g, ' ').trim() : '';
    if (name.length > LIMITS.maxNameLength || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'name is too long or contains control characters.' };
    const days = raw['days'];
    if (!Array.isArray(days) || days.length < 1 || days.length > 7 || !days.every((d) => int(d, 0, 6))) return { ok: false, error: 'days must list weekdays 0 (Sunday) to 6 (Saturday).' };
    const uniqueDays = [...new Set(days as number[])].sort((a, b) => a - b);
    if (typeof raw['start'] !== 'string' || typeof raw['end'] !== 'string') return { ok: false, error: 'start and end must be HH:MM.' };
    const s = parseTime(raw['start']); const e = parseTime(raw['end']);
    if (s === null || e === null) return { ok: false, error: 'start and end must be HH:MM (24-hour).' };
    if (s === e) return { ok: false, error: 'start and end must differ (an interval past midnight is allowed).' };
    const lead = raw['leadMinutes'] === undefined ? 10 : raw['leadMinutes'];
    if (!int(lead, 0, 120)) return { ok: false, error: 'leadMinutes must be from 0 to 120.' };
    const ids = deviceIds(raw['deviceIds']); if (typeof ids === 'string') return { ok: false, error: ids };
    return { ok: true, config: { enabled, name, days: uniqueDays, start: raw['start'], end: raw['end'], leadMinutes: lead, deviceIds: ids } };
  }
  const bad = strictKeys(raw, ['enabled', 'intervalMinutes', 'breakMinutes', 'snoozeMinutes', 'style']); if (bad) return { ok: false, error: bad };
  const interval = raw['intervalMinutes'] === undefined ? DEFAULT_BREAK.intervalMinutes : raw['intervalMinutes'];
  const brk = raw['breakMinutes'] === undefined ? DEFAULT_BREAK.breakMinutes : raw['breakMinutes'];
  const snooze = raw['snoozeMinutes'] === undefined ? DEFAULT_BREAK.snoozeMinutes : raw['snoozeMinutes'];
  if (!int(interval, 15, 240)) return { ok: false, error: 'intervalMinutes must be from 15 to 240.' };
  if (!int(brk, 1, 60)) return { ok: false, error: 'breakMinutes must be from 1 to 60.' };
  if (!int(snooze, 1, 60)) return { ok: false, error: 'snoozeMinutes must be from 1 to 60.' };
  const style = raw['style'] === undefined ? 'notification' : raw['style'];
  if (style !== 'notification' && style !== 'quiet') return { ok: false, error: 'style must be notification or quiet.' };
  return { ok: true, config: { enabled, intervalMinutes: interval, breakMinutes: brk, snoozeMinutes: snooze, style } };
}

// ---- reports: pure helpers over the synchronised "wellbeing" day documents --------------------------------------------------------
// A wellbeing day document (written by the computer that evaluated the rules): { version:1, dayKey, activeMs, limits:[{ruleId,scope,category?,app?,limitMs,usedMs,exceeded,warned}],
//   breaks:{ reminders, dismissed, taken, longestStreakMs }, schedules:[{ruleId, violationMs}], tzOffsetMin }
export type DayCompliance = { day: string; limits: number; exceeded: number; withinLimit: number; breaks: { reminders: number; dismissed: number; taken: number }; scheduleViolationMs: number };

export function dayCompliance(day: string, docs: unknown[]): DayCompliance | null {
  let limits = 0; let exceeded = 0; let reminders = 0; let dismissed = 0; let taken = 0; let viol = 0; let any = false;
  for (const d of docs) {
    if (!isObj(d)) continue; any = true;
    if (Array.isArray(d['limits'])) for (const l of d['limits']) if (isObj(l) && typeof l['limitMs'] === 'number') { limits += 1; if (l['exceeded'] === true) exceeded += 1; }
    const b = d['breaks'];
    if (isObj(b)) { const n = (k: string) => (typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) >= 0 ? Math.min(b[k] as number, 10_000) : 0); reminders += n('reminders'); dismissed += n('dismissed'); taken += n('taken'); }
    if (Array.isArray(d['schedules'])) for (const s of d['schedules']) if (isObj(s) && typeof s['violationMs'] === 'number' && s['violationMs'] > 0) viol += Math.min(s['violationMs'], 86_400_000);
  }
  return any ? { day, limits, exceeded, withinLimit: limits - exceeded, breaks: { reminders, dismissed, taken }, scheduleViolationMs: viol } : null;
}
