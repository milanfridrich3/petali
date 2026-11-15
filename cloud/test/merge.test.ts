import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canonicalize } from '../src/modules/sync/canonical';
import { mergeApps, mergeDay, mergeDocument, mergeHealth, mergeLedger, mergeRollup, type MergeName } from '../src/modules/sync/merge';

// Pure tests (no database): the deterministic merge rules of a computer's own documents (Phase 4 conflict resolution).
type Vec = { kind: string; a: any; b: any; expected: any };
const vectors: Vec[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'merge-vectors.json'), 'utf8')).vectors;
const c = (v: unknown) => canonicalize(v);
const name = (k: string): MergeName => (k === 'plant' ? 'maxmap' : k) as MergeName;   // the ledger kind is called "plant", its merge rule "maxmap"

describe('merge rules: parity with the desktop implementation', () => {
  it('produces exactly the documents the desktop rules (merge-rules.js) produced for the shared vectors', () => {
    assert.ok(vectors.length >= 70);
    for (const [i, v] of vectors.entries()) assert.equal(c(mergeDocument(name(v.kind), v.a, v.b)), c(v.expected), `vector ${i} (${v.kind})`);
  });
});

describe('merge rules: algebraic properties (what makes sync order-independent and repeat-safe)', () => {
  const byKind = (k: string) => vectors.filter((v) => v.kind === k);
  it('commutative: the order of two uploads does not matter', () => {
    for (const v of vectors) assert.equal(c(mergeDocument(name(v.kind), v.a, v.b)), c(mergeDocument(name(v.kind), v.b, v.a)), v.kind);
  });
  it('idempotent: merging the same document again changes nothing', () => {
    for (const v of vectors) {
      const m = mergeDocument(name(v.kind), v.a, v.b);
      assert.equal(c(mergeDocument(name(v.kind), m, v.b)), c(m), `${v.kind}: merge(m, b)`);
      assert.equal(c(mergeDocument(name(v.kind), m, v.a)), c(m), `${v.kind}: merge(m, a)`);
      assert.equal(c(mergeDocument(name(v.kind), m, m)), c(m), `${v.kind}: merge(m, m)`);
    }
  });
  it('associative: three computers/retries in any grouping give the same document', () => {
    for (const k of ['day', 'apps', 'rollup', 'health', 'plant']) {
      const vs = byKind(k);
      for (let i = 0; i + 2 < vs.length; i += 1) {
        const [x, y, z] = [vs[i]!.a, vs[i + 1]!.a, vs[i + 2]!.b];
        const f = (p: unknown, q: unknown) => mergeDocument(name(k), p, q);
        assert.equal(c(f(f(x, y), z)), c(f(x, f(y, z))), `${k} ${i}`);
      }
    }
  });
  it('monotone: nothing either side knew is lost', () => {
    for (const v of byKind('day')) {
      const m = mergeDay(v.a, v.b) as any;
      const ids = new Set(m.sessions.map((s: any) => s.id));
      for (const s of [...v.a.sessions, ...v.b.sessions]) assert.ok(ids.has(s.id));
      assert.ok(m.activeMs >= Math.max(v.a.activeMs, v.b.activeMs));
    }
    for (const v of byKind('apps')) {
      const m = mergeApps(v.a, v.b) as any;
      for (const src of [v.a, v.b]) for (const [app, ms] of Object.entries(src.apps)) assert.ok(m.apps[app] >= (ms as number), app);
      assert.equal(m.attributedMs, m.unknownMs + (Object.values(m.apps) as number[]).reduce((x, y) => x + y, 0), 'the app-usage invariant holds');
    }
    for (const v of byKind('rollup')) {
      const m = mergeRollup(v.a, v.b) as any;
      for (const src of [v.a, v.b]) for (const [d, e] of Object.entries(src.days) as [string, any][]) assert.ok(m.days[d].hw.minutes >= e.hw.minutes, d);
    }
    for (const v of byKind('health')) {
      const m = mergeHealth(v.a, v.b) as any; const have = new Set(m.lines.map(c));
      for (const l of [...v.a.lines, ...v.b.lines]) assert.ok(have.has(c(l)));
    }
    for (const v of byKind('plant')) {
      const m = mergeLedger(v.a, v.b);
      assert.ok(m.baseMs >= v.a.baseMs && m.baseMs >= v.b.baseMs);
      for (const src of [v.a, v.b]) for (const [d, ms] of Object.entries(src.days)) assert.ok((m.days[d] ?? 0) >= (ms as number));
    }
  });
});

describe('merge rules: specific cases', () => {
  const S = (id: string, activeMs: number, endReason: string | null = 'lock', startMs = 1000) => ({ id, startMs, endMs: startMs + activeMs, activeMs, endReason });
  const day = (activeMs: number, sessions: unknown[]) => ({ version: 1, dayKey: '2026-09-14', activeMs, sessions });

  it('a stale copy of the same session cannot make the day smaller', () => {
    const cloud = day(3_600_000, [S('a', 3_600_000)]); const stale = day(1_000_000, [S('a', 1_000_000, null)]);
    assert.equal((mergeDay(cloud, stale) as any).activeMs, 3_600_000);
    assert.equal((mergeDay(cloud, stale) as any).sessions[0].endReason, 'lock', 'the closed, longer copy wins over the open stale one');
  });
  it('time counted before and after a reinstall adds up (different sessions of one day)', () => {
    const before = day(3 * 3_600_000, [S('old1', 3 * 3_600_000, 'quit', 1000)]);
    const after = day(3_600_000, [S('new1', 3_600_000, null, 20_000_000)]);
    const m = mergeDay(before, after) as any;
    assert.equal(m.activeMs, 4 * 3_600_000); assert.equal(m.sessions.length, 2);
  });
  it('Active Work never exceeds a 25-hour day, whatever is merged', () => {
    const big = (id: string) => day(20 * 3_600_000, [S(id, 20 * 3_600_000)]);
    assert.equal((mergeDay(big('x'), big('y')) as any).activeMs, 25 * 3_600_000);
  });
  it('sessions without an id are kept and never raise Active Work', () => {
    const legacy = day(1000, [{ start: 1, end: 2, activeMs: 999_999 }]); const other = day(2000, [{ start: 5, end: 6, activeMs: 5 }]);
    const m = mergeDay(legacy, other) as any;
    assert.equal(m.sessions.length, 2); assert.equal(m.activeMs, 2000);
  });
  it('app usage keeps the larger time per app and recomputes the total', () => {
    const a = { version: 1, dayKey: 'd', attributedMs: 300, unknownMs: 100, apps: { 'chrome.exe': 200 }, hourly: [] };
    const b = { version: 1, dayKey: 'd', attributedMs: 450, unknownMs: 50, apps: { 'chrome.exe': 100, 'code.exe': 300 }, hourly: [] };
    const m = mergeApps(a, b) as any;
    assert.deepEqual(m.apps, { 'chrome.exe': 200, 'code.exe': 300 }); assert.equal(m.unknownMs, 100); assert.equal(m.attributedMs, 600);
  });
  it('app usage that would exceed a day keeps the more advanced document instead of an impossible one', () => {
    const a = { version: 1, dayKey: 'd', attributedMs: 20 * 3_600_000, unknownMs: 0, apps: { 'a.exe': 20 * 3_600_000 }, hourly: [] };
    const b = { version: 1, dayKey: 'd', attributedMs: 20 * 3_600_000 + 1, unknownMs: 0, apps: { 'b.exe': 20 * 3_600_000 + 1 }, hourly: [] };
    const m = mergeApps(a, b) as any;
    assert.ok(m.attributedMs <= 25 * 3_600_000); assert.deepEqual(Object.keys(m.apps), ['b.exe']);
  });
  it('hardware summaries: the day with more measured minutes wins, other days are all kept', () => {
    const e = (minutes: number, n = minutes) => ({ hw: { t: 1, n, minutes }, hourly: [] });
    const a = { version: 1, month: '2026-09', days: { '2026-09-01': e(600), '2026-09-02': e(100) } };
    const b = { version: 1, month: '2026-09', days: { '2026-09-02': e(700), '2026-09-03': e(50) } };
    const m = mergeRollup(a, b) as any;
    assert.deepEqual(Object.keys(m.days), ['2026-09-01', '2026-09-02', '2026-09-03']); assert.equal(m.days['2026-09-02'].hw.minutes, 700);
  });
  it('Device Health events: the same event twice is one event; order is by time', () => {
    const l1 = { t: 10, k: 'start', id: 'Overheating', sev: 'warning' }; const l2 = { t: 5, k: 'start', id: 'HighRam', sev: 'info' };
    const m = mergeHealth({ lines: [l1] }, { lines: [l1, l2] }) as any;
    assert.deepEqual(m.lines, [l2, l1]);
  });
  it('malformed existing data falls back to the incoming document (never throws)', () => {
    for (const bad of [null, 5, 'x', [], {}]) for (const f of [mergeDay, mergeApps, mergeRollup, mergeHealth]) assert.doesNotThrow(() => f(bad, { x: 1 }));
  });
});
