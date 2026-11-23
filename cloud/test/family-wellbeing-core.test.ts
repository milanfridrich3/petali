import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayCompliance, parseTime, validateConfig } from '../src/modules/family/wellbeing-core';

const ok = (kind: any, raw: unknown) => { const r = validateConfig(kind, raw); assert.ok(r.ok, JSON.stringify(r)); return (r as any).config; };
const bad = (kind: any, raw: unknown, re?: RegExp) => { const r = validateConfig(kind, raw); assert.equal(r.ok, false); if (re) assert.match((r as any).error, re); };
const DEV = '11111111-1111-4111-8111-111111111111';

describe('wellbeing rule validation: limits', () => {
  it('accepts total, category and application limits and fills defaults', () => {
    assert.deepEqual(ok('limit', { scope: 'total', minutes: 120 }), { enabled: true, scope: 'total', minutes: 120, warnAtPercent: 80, deviceIds: [] });
    assert.equal(ok('limit', { scope: 'category', category: 'Games', minutes: 60 }).category, 'Games');
    assert.equal(ok('limit', { scope: 'app', app: 'chrome.exe', minutes: 30, warnAtPercent: 50, deviceIds: [DEV, DEV.toUpperCase()] }).deviceIds.length, 1);
  });
  it('rejects bad scopes, minutes, percentages and mismatching fields', () => {
    bad('limit', { scope: 'x', minutes: 5 }); bad('limit', { scope: 'total', minutes: 0 }); bad('limit', { scope: 'total', minutes: 1441 }); bad('limit', { scope: 'total', minutes: 1.5 });
    bad('limit', { scope: 'total', minutes: '60' }); bad('limit', { scope: 'total', minutes: 60, warnAtPercent: 100 }); bad('limit', { scope: 'total', minutes: 60, warnAtPercent: 49 });
    bad('limit', { scope: 'category', minutes: 60 }); bad('limit', { scope: 'category', category: 'Nope', minutes: 60 }); bad('limit', { scope: 'total', category: 'Games', minutes: 60 }, /only allowed/);
    bad('limit', { scope: 'app', app: 'C:\\x.exe', minutes: 60 }); bad('limit', { scope: 'app', minutes: 60 }); bad('limit', { scope: 'total', app: 'a.exe', minutes: 60 });
    bad('limit', { scope: 'total', minutes: 60, deviceIds: ['nope'] }); bad('limit', { scope: 'total', minutes: 60, extra: 1 }, /unknown field/); bad('limit', { scope: 'total', minutes: 60, enabled: 'yes' });
    bad('limit', null); bad('limit', []); bad('limit', 'x');
  });
});
describe('wellbeing rule validation: schedules', () => {
  it('accepts weekdays, custom intervals and intervals past midnight; normalises days', () => {
    const c = ok('schedule', { name: '  School   night ', days: [5, 1, 1, 0], start: '21:30', end: '06:15' });
    assert.deepEqual(c.days, [0, 1, 5]); assert.equal(c.name, 'School night'); assert.equal(c.leadMinutes, 10);
  });
  it('rejects bad times, equal start/end, empty or invalid weekdays and control characters', () => {
    bad('schedule', { days: [1], start: '24:00', end: '06:00' }); bad('schedule', { days: [1], start: '9:00', end: '10:00' }); bad('schedule', { days: [1], start: '10:00', end: '10:00' });
    bad('schedule', { days: [], start: '10:00', end: '11:00' }); bad('schedule', { days: [7], start: '10:00', end: '11:00' }); bad('schedule', { days: [1], start: '10:00' });
    bad('schedule', { name: 'a\u0000b', days: [1], start: '10:00', end: '11:00' }); bad('schedule', { name: 'x'.repeat(41), days: [1], start: '10:00', end: '11:00' });
    bad('schedule', { days: [1], start: '10:00', end: '11:00', leadMinutes: 121 });
  });
  it('parseTime', () => { assert.equal(parseTime('00:00'), 0); assert.equal(parseTime('23:59'), 1439); assert.equal(parseTime('7:00'), null); });
});
describe('wellbeing rule validation: breaks', () => {
  it('defaults and bounds', () => {
    assert.deepEqual(ok('break', {}), { enabled: true, intervalMinutes: 60, breakMinutes: 5, snoozeMinutes: 10, style: 'notification' });
    bad('break', { intervalMinutes: 14 }); bad('break', { intervalMinutes: 241 }); bad('break', { breakMinutes: 0 }); bad('break', { snoozeMinutes: 61 }); bad('break', { style: 'loud' });
  });
});
describe('dayCompliance', () => {
  it('sums documents of several computers, ignores junk and returns null without documents', () => {
    assert.equal(dayCompliance('d', []), null);
    const r = dayCompliance('d', [{ limits: [{ limitMs: 1, exceeded: true }, { limitMs: 1, exceeded: false }], breaks: { reminders: 2, dismissed: 1, taken: 1 }, schedules: [{ violationMs: 5 }] }, { limits: [{ limitMs: 1, exceeded: true }, 'x', { limitMs: 'a' }], breaks: { reminders: -3 } }, 7 as any]);
    assert.deepEqual(r, { day: 'd', limits: 3, exceeded: 2, withinLimit: 1, breaks: { reminders: 2, dismissed: 1, taken: 1 }, scheduleViolationMs: 5 });
  });
  it('a document with no limits is data, not "no data"', () => { assert.equal(dayCompliance('d', [{ limits: [], breaks: {} }])?.limits, 0); });
});

describe('desktop / cloud parity of rule validation', () => {
  const vectors = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'wellbeing-vectors.json'), 'utf8')).vectors as { kind: string; input: unknown; ok: boolean; config?: unknown }[];
  it(`the ${vectors.length} shared vectors give the same answer as the desktop implementation`, () => {
    for (const v of vectors) {
      const r = validateConfig(v.kind as any, v.input as any) as any;
      if (v.kind === 'nope') { assert.equal(v.ok, false); continue; }                 // the cloud validates the kind separately (isRuleKind)
      assert.equal(r.ok, v.ok, JSON.stringify(v));
      if (v.ok) assert.deepEqual(r.config, v.config, JSON.stringify(v));
    }
  });
});
