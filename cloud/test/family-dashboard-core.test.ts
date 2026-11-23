import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays } from '../src/modules/web/report-core';
import { APP_CATEGORIES, BUILTIN_APP_CATEGORIES } from '../src/modules/family/app-category-table';
import {
  MAX_RANGE_DAYS, categoryTotals, compareUsage, dailySeries, dayKeys, daysBetween, isAppId, monthlyBuckets, rankApps, resolveCategory, resolveWindow, trendOf, weeklyBuckets,
} from '../src/modules/family/dashboard-core';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'no-error'; };

describe('dashboard core: ranges and calendar days', () => {
  it('a single day: today is the default, the previous period is the day before', () => {
    const w = resolveWindow({}, NOW);
    assert.deepEqual(w.range, { from: '2026-11-16', to: '2026-11-16', days: 1 }); assert.deepEqual(w.previous, { from: '2026-11-15', to: '2026-11-15', days: 1 }); assert.equal(w.today, '2026-11-16');
  });
  it('last 7 / last 30 days (inclusive) and the equally long previous period', () => {
    const w7 = resolveWindow({ from: '2026-11-10', to: '2026-11-16', today: '2026-11-16' }, NOW);
    assert.equal(w7.range.days, 7); assert.deepEqual(w7.previous, { from: '2026-11-03', to: '2026-11-09', days: 7 });
    const w30 = resolveWindow({ from: '2026-10-18', to: '2026-11-16' }, NOW);
    assert.equal(w30.range.days, 30); assert.deepEqual(w30.previous, { from: '2026-09-18', to: '2026-10-17', days: 30 });
  });
  it('previous periods are plain calendar arithmetic: leap day, year change and DST changes cannot shift or lose a day', () => {
    assert.equal(resolveWindow({ from: '2028-03-01', to: '2028-03-01', today: '2028-03-01' }, Date.parse('2028-03-01T10:00:00Z')).previous.from, '2028-02-29');
    assert.equal(resolveWindow({ from: '2027-01-01', to: '2027-01-03', today: '2027-01-03' }, Date.parse('2027-01-03T10:00:00Z')).previous.from, '2026-12-29');
    assert.equal(daysBetween('2026-03-28', '2026-03-30'), 3, 'the 23-hour day of the spring DST change is still one day');
    assert.equal(daysBetween('2026-10-24', '2026-10-26'), 3, 'and so is the 25-hour day of the autumn change');
    assert.deepEqual(dayKeys('2026-03-27', '2026-03-31'), ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
    assert.equal(dayKeys('2026-01-01', '2026-12-31').length, 365);
  });
  it('the client\'s own today may be one day ahead of (UTC+14) or behind (UTC-12) the server\'s UTC date, never more', () => {
    assert.equal(resolveWindow({ today: '2026-11-17' }, NOW).today, '2026-11-17');
    assert.equal(resolveWindow({ today: '2026-11-15' }, NOW).today, '2026-11-15');
    assert.equal(code(() => resolveWindow({ today: '2026-11-18' }, NOW)), 'invalid_today');
    assert.equal(code(() => resolveWindow({ today: '2026-11-14' }, NOW)), 'invalid_today');
    assert.equal(code(() => resolveWindow({ today: 'yesterday' }, NOW)), 'invalid_today');
  });
  it('rejects anything that is not a real, ordered, bounded range', () => {
    for (const bad of [{ from: '2026-02-31', to: '2026-03-01' }, { from: 'x', to: '2026-03-01' }, { from: '2026-03-02', to: '2026-03-01' }, { from: ['2026-03-01'], to: '2026-03-02' }, { from: '2019-12-31', to: '2020-01-02' }]) assert.equal(code(() => resolveWindow({ ...bad, today: '2026-11-16' }, NOW)), 'invalid_range', JSON.stringify(bad));
    assert.equal(code(() => resolveWindow({ from: '2026-11-16', to: '2026-11-17', today: '2026-11-16' }, NOW)), 'range_in_future');
    assert.equal(code(() => resolveWindow({ from: addDays('2026-11-16', -MAX_RANGE_DAYS), to: '2026-11-16' }, NOW)), 'range_too_long');
    assert.doesNotThrow(() => resolveWindow({ from: addDays('2026-11-16', -(MAX_RANGE_DAYS - 1)), to: '2026-11-16' }, NOW));
  });
});

describe('dashboard core: categories (resolved when read, like the desktop)', () => {
  it('order: the user\'s own choice, then the built-in table, then Other; unidentified time counts as Other', () => {
    assert.equal(resolveCategory('steam.exe', undefined), 'Games'); assert.equal(resolveCategory('code.exe', undefined), 'Productivity'); assert.equal(resolveCategory('spotify.exe', undefined), 'Entertainment');
    assert.equal(resolveCategory('chrome.exe', undefined), 'Other', 'browsers are Other on purpose'); assert.equal(resolveCategory('unknownthing.exe', undefined), 'Other');
    assert.equal(resolveCategory('Chrome.EXE', new Map([['chrome.exe', 'Education']])), 'Education', 'the member\'s own choice wins and ids are case-insensitive');
    const c = categoryTotals([{ app: 'steam.exe', ms: 600_000 }, { app: 'code.exe', ms: 300_000 }, { app: 'weird.exe', ms: 100_000 }], 50_000, undefined);
    assert.equal(c.totalMs, 1_050_000); assert.deepEqual(c.items.map((i) => [i.category, i.ms]), [['Games', 600_000], ['Productivity', 300_000], ['Other', 150_000]]);
    assert.ok(Math.abs(c.items.reduce((a, i) => a + (i.share as number), 0) - 1) < 1e-9);
  });
  it('the generated table is the full desktop table and only holds known categories', () => {
    assert.ok(Object.keys(BUILTIN_APP_CATEGORIES).length >= 150);
    for (const v of Object.values(BUILTIN_APP_CATEGORIES)) assert.ok((APP_CATEGORIES as readonly string[]).includes(v));
  });
  it('only plausible executable ids are shown as applications (no paths, no odd characters); the time is still counted', () => {
    assert.ok(isAppId('chrome.exe')); for (const bad of ['C:\\x\\a.exe', 'a/b.exe', 'noext', '.exe', 'x'.repeat(200) + '.exe', 5]) assert.equal(isAppId(bad), false, String(bad));
    const r = rankApps([{ app: 'a.exe', ms: 100 }, { app: 'C:\\evil.exe', ms: 900 }], 0, undefined, false);
    assert.deepEqual(r.top.map((t) => t.app), ['a.exe']); assert.equal(r.attributedMs, 1000); assert.equal(r.otherMs, 900);
  });
  it('rankApps: ordered by time then name, capped, shares relative to all tracked time', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ app: `a${String(i).padStart(2, '0')}.exe`, ms: 1000 + i }));
    const r = rankApps(many, 500, undefined, false);
    assert.equal(r.top.length, 15); assert.equal(r.top[0]?.app, 'a29.exe'); assert.equal(r.unknownMs, 500);
    assert.equal(r.attributedMs, many.reduce((a, b) => a + b.ms, 0) + 500); assert.equal(r.top.reduce((a, t) => a + t.ms, 0) + r.otherMs + r.unknownMs, r.attributedMs);
    assert.ok(!('category' in (r.top[0] as object)), 'no category without the member\'s consent for categories');
    assert.equal(rankApps([{ app: 'steam.exe', ms: 5 }], 0, undefined, true).top[0]?.category, 'Games');
  });
});

describe('dashboard core: comparison, trend and buckets', () => {
  it('a comparison needs real days on BOTH sides and compares daily averages', () => {
    assert.deepEqual(compareUsage({ totalMs: 0, daysWithData: 0 }, { totalMs: 5, daysWithData: 1 }, 1, false), { available: false, reason: 'not-enough-current-data' });
    assert.deepEqual(compareUsage({ totalMs: 5, daysWithData: 1 }, { totalMs: 0, daysWithData: 0 }, 1, false), { available: false, reason: 'not-enough-previous-data' });
    const c = compareUsage({ totalMs: 3 * 3_600_000, daysWithData: 3 }, { totalMs: 8 * 3_600_000, daysWithData: 4 }, 7, false);
    assert.equal(c.available, true); if (c.available) { assert.equal(c.currentAvgMs, 3_600_000); assert.equal(c.previousAvgMs, 2 * 3_600_000); assert.equal(c.changeMs, -3_600_000); assert.equal(c.changeRatio, -0.5); }
    assert.equal(compareUsage({ totalMs: 2, daysWithData: 2 }, { totalMs: 9, daysWithData: 9 }, 7, false).available, false, 'a week needs at least 3 days of data');
    assert.equal(compareUsage({ totalMs: 6, daysWithData: 6 }, { totalMs: 9, daysWithData: 9 }, 30, false).available, false, 'a month needs at least 7');
    const zero = compareUsage({ totalMs: 5, daysWithData: 1 }, { totalMs: 0, daysWithData: 1 }, 1, true); if (zero.available) { assert.equal(zero.changeRatio, null, 'no percentage against zero'); assert.equal(zero.partial, true); }
  });
  it('trend: first half against second half of the calendar range, needs data on both halves, +-15% is flat', () => {
    const keys = dayKeys('2026-11-01', '2026-11-10');
    const by = (f: (i: number) => number | null) => new Map(keys.flatMap((k, i) => { const v = f(i); return v === null ? [] : [[k, v] as [string, number]]; }));
    assert.equal(trendOf(keys, by((i) => (i < 5 ? 1000 : 2000)))?.direction, 'up'); assert.equal(trendOf(keys, by((i) => (i < 5 ? 2000 : 1000)))?.direction, 'down');
    assert.equal(trendOf(keys, by((i) => (i < 5 ? 1000 : 1100)))?.direction, 'flat');
    assert.equal(trendOf(keys, by((i) => (i < 5 ? 1000 : null))), null, 'no data in the second half: no trend'); assert.equal(trendOf(dayKeys('2026-11-01', '2026-11-05'), new Map()), null, 'under a week: no trend');
  });
  it('daily series says null (no data) and never 0 for a day without a document; buckets are calendar weeks (Monday) and months', () => {
    const keys = dayKeys('2026-11-02', '2026-11-16'); const by = new Map([['2026-11-02', 100], ['2026-11-09', 0], ['2026-11-10', 50]]);
    const s = dailySeries(keys, by); assert.equal(s.find((p) => p.day === '2026-11-03')?.activeMs, null); assert.equal(s.find((p) => p.day === '2026-11-09')?.activeMs, 0);
    const wk = weeklyBuckets(keys, by); assert.deepEqual(wk.map((b) => [b.weekStart, b.activeMs, b.daysWithData, b.daysInRange]), [['2026-11-02', 100, 1, 7], ['2026-11-09', 50, 2, 7], ['2026-11-16', 0, 0, 1]]);
    const mo = monthlyBuckets(dayKeys('2026-10-30', '2026-11-02'), new Map([['2026-10-31', 10], ['2026-11-01', 20]])); assert.deepEqual(mo.map((b) => [b.month, b.activeMs, b.daysInRange]), [['2026-10', 10, 2], ['2026-11', 20, 2]]);
  });
});
