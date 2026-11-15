// Phase 6 regression tests: Petali ID theme (Automatic / Day / Night). Automated, in jsdom; real-browser checks are in the Chromium run (see the report).
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { createTheme, msUntilBoundary, isNightAt, sanitizeSchedule, KEYS, DEFAULT_SCHEDULE } from '../../id/js/theme.js';

// loaded in THIS realm (a vm realm has its own Date and the module's `instanceof Date` check would reject ours)
const TS = (() => { const root = {}; new Function('self', readFileSync(new URL('../../id/vendor/theme-schedule.js', import.meta.url), 'utf8'))(root); return root.PetaliThemeSchedule; })();
const at = (h, m = 0, s = 0) => new Date(2026, 10, 12, h, m, s);
const mem = (init = {}) => { const m = new Map(Object.entries(init)); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const page = () => { const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content="#ebf5e9"></head><body></body></html>'); return { doc: dom.window.document, win: dom.window, dom }; };
const mk = (storage, date, extra = {}) => { const p = page(); const clock = { d: date }; const t = createTheme({ storage, doc: p.doc, win: p.win, now: () => clock.d, TS, ...extra }); return { t, clock, ...p }; };

describe('automatic schedule boundaries (default 22:00-06:00)', () => {
  const cases = [[21, 59, 'day'], [22, 0, 'night'], [23, 59, 'night'], [0, 0, 'night'], [3, 30, 'night'], [5, 59, 'night'], [6, 0, 'day'], [6, 1, 'day'], [12, 0, 'day']];
  for (const [h, m, want] of cases) it(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} is ${want}`, () => {
    const { t, doc } = mk(mem(), at(h, m));
    assert.equal(t.apply(), want); assert.equal(doc.documentElement.classList.contains('night'), want === 'night');
  });
  it('the fallback rule gives exactly the same answer as the desktop module for every minute of the day, default and custom schedules', () => {
    for (const sch of [DEFAULT_SCHEDULE, { from: '20:30', to: '07:15' }, { from: '01:00', to: '05:00' }, { from: '00:00', to: '12:00' }]) {
      for (let i = 0; i < 1440; i += 1) { const d = at(Math.floor(i / 60), i % 60); assert.equal(isNightAt(sch, d), TS.isNight(sch, d), `${JSON.stringify(sch)} @${i}`); }
    }
  });
});

describe('manual Day / Night and Automatic', () => {
  it('Day and Night ignore the clock and update the page immediately, including the browser colour', () => {
    const { t, doc } = mk(mem(), at(23, 0));
    assert.equal(doc.documentElement.classList.contains('night'), false);
    t.apply(); assert.equal(doc.documentElement.classList.contains('night'), true); assert.equal(doc.querySelector('meta[name=theme-color]').content, '#153d52');
    t.setMode('day'); assert.equal(doc.documentElement.classList.contains('night'), false); assert.equal(doc.querySelector('meta[name=theme-color]').content, '#ebf5e9');
    t.setMode('night'); assert.equal(doc.documentElement.classList.contains('night'), true);
    t.setMode('auto'); assert.equal(t.getMode(), 'auto'); assert.equal(doc.documentElement.classList.contains('night'), true);   // 23:00 -> night by schedule
  });
  it('Night chosen at noon and Day chosen at midnight are honoured', () => {
    const noon = mk(mem(), at(12)); noon.t.setMode('night'); assert.equal(noon.t.resolve(), 'night');
    const mid = mk(mem(), at(0)); mid.t.setMode('day'); assert.equal(mid.t.resolve(), 'day');
  });
  it('Automatic follows the clock as time passes (the boundary timer / visibility refresh calls apply())', () => {
    const { t, clock } = mk(mem(), at(21, 59, 30));
    assert.equal(t.apply(), 'day'); clock.d = at(22, 0, 1); assert.equal(t.apply(), 'night'); clock.d = at(6, 0, 1); assert.equal(t.apply(), 'day');
  });
  it('a custom schedule (set in the desktop app) is used, and an invalid one falls back to 22:00-06:00', () => {
    const s = mem({ [KEYS.schedule]: JSON.stringify({ from: '20:00', to: '07:00' }) });
    assert.equal(mk(s, at(20, 0)).t.resolve(), 'night'); assert.equal(mk(s, at(7, 0)).t.resolve(), 'day'); assert.equal(mk(s, at(21, 59)).t.resolve(), 'night');
    for (const bad of ['{"from":"25:00","to":"06:00"}', '{"from":"22:00","to":"22:00"}', 'nonsense', '{"from":1,"to":2}']) { const b = mem({ [KEYS.schedule]: bad }); assert.deepEqual(mk(b, at(12)).t.getSchedule(), DEFAULT_SCHEDULE); assert.equal(mk(b, at(23)).t.resolve(), 'night'); }
    assert.deepEqual(sanitizeSchedule(null), DEFAULT_SCHEDULE);
  });
  it('setSchedule(null) (sign-out) removes the account schedule', () => { const st = mem(); const { t } = mk(st, at(12)); t.setSchedule({ from: '20:00', to: '07:00' }); assert.ok(st.m.has(KEYS.schedule)); t.setSchedule(null); assert.ok(!st.m.has(KEYS.schedule)); assert.equal(t.hasCustomSchedule(), false); });
});

describe('persistence', () => {
  it('the choice survives a reload (a new instance on the same storage) and sign-out/sign-in (only the schedule is cleared)', () => {
    const st = mem(); mk(st, at(12)).t.setMode('night');
    const reloaded = mk(st, at(12)); assert.equal(reloaded.t.getMode(), 'night'); assert.equal(reloaded.t.resolve(), 'night');
    reloaded.t.setSchedule(null); assert.equal(mk(st, at(12)).t.getMode(), 'night');
    mk(st, at(12)).t.setMode('auto'); assert.ok(!st.m.has(KEYS.mode)); assert.equal(mk(st, at(12)).t.getMode(), 'auto');
  });
  it('legacy values (system / light / dark) are understood', () => { assert.equal(mk(mem({ [KEYS.mode]: 'dark' }), at(12)).t.getMode(), 'night'); assert.equal(mk(mem({ [KEYS.mode]: 'light' }), at(12)).t.getMode(), 'day'); assert.equal(mk(mem({ [KEYS.mode]: 'system' }), at(12)).t.getMode(), 'auto'); });
  it('unavailable storage (private mode) never throws and a manual choice still works for this page', () => {
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    const { t, doc } = mk(broken, at(12)); assert.doesNotThrow(() => t.setMode('night')); assert.equal(doc.documentElement.classList.contains('night'), true); assert.equal(t.getMode(), 'night');
  });
  it('another tab changing the choice updates this tab (storage event)', () => {
    const st = mem(); const { t, doc, win } = mk(st, at(12)); t.start(); assert.equal(doc.documentElement.classList.contains('night'), false);
    st.setItem(KEYS.mode, 'night'); win.dispatchEvent(new win.StorageEvent('storage', { key: KEYS.mode, newValue: 'night' })); assert.equal(doc.documentElement.classList.contains('night'), true); t.stop();
  });
});

describe('boundary timer maths', () => {
  it('msUntilBoundary is the time to the next 22:00 / 06:00 (never negative, wraps midnight)', () => {
    assert.equal(msUntilBoundary(DEFAULT_SCHEDULE, at(21, 0)), 3600000); assert.equal(msUntilBoundary(DEFAULT_SCHEDULE, at(21, 59, 30)), 30000);
    assert.equal(msUntilBoundary(DEFAULT_SCHEDULE, at(23, 0)), 7 * 3600000); assert.equal(msUntilBoundary(DEFAULT_SCHEDULE, at(5, 59)), 60000);
    assert.equal(msUntilBoundary(DEFAULT_SCHEDULE, at(22, 0)), 8 * 3600000);
    for (let i = 0; i < 1440; i += 7) assert.ok(msUntilBoundary({ from: '20:15', to: '06:40' }, at(Math.floor(i / 60), i % 60)) > 0);
  });
});

describe('theme-boot.js (runs before first paint)', () => {
  const boot = readFileSync(new URL('../../id/js/theme-boot.js', import.meta.url), 'utf8'); const tsSrc = readFileSync(new URL('../../id/vendor/theme-schedule.js', import.meta.url), 'utf8');
  function run({ ls = {}, date, withTS = true }) {
    const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content="#ebf5e9"></head><body></body></html>', { runScripts: 'outside-only' }); const w = dom.window;
    Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in ls ? ls[k] : null) }, configurable: true });
    const RealDate = w.Date; w.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [date.getTime()])); } };
    if (withTS) vm.runInContext(tsSrc, dom.getInternalVMContext()); vm.runInContext(boot, dom.getInternalVMContext());
    return { night: w.document.documentElement.classList.contains('night'), color: w.document.querySelector('meta[name=theme-color]').getAttribute('content') };
  }
  it('matches theme.js for every mode x time x schedule x (script present | missing)', () => {
    for (const withTS of [true, false]) for (const mode of [null, 'day', 'night']) for (const sch of [null, { from: '20:00', to: '07:00' }]) for (const [h, m] of [[0, 0], [5, 59], [6, 0], [12, 0], [19, 59], [20, 0], [21, 59], [22, 0], [23, 59]]) {
      const ls = {}; if (mode) ls[KEYS.mode] = mode; if (sch) ls[KEYS.schedule] = JSON.stringify(sch);
      const got = run({ ls, date: at(h, m), withTS }); const st = mem(ls); const want = mk(st, at(h, m)).t.resolve();
      assert.equal(got.night, want === 'night', `${withTS} ${mode} ${JSON.stringify(sch)} ${h}:${m}`); assert.equal(got.color, want === 'night' ? '#153d52' : '#ebf5e9');
    }
  });
  it('without the vendored script Automatic still follows 22:00-06:00 (it can never get stuck on Day)', () => { assert.equal(run({ date: at(23), withTS: false }).night, true); assert.equal(run({ date: at(12), withTS: false }).night, false); });
});

describe('the theme is wired everywhere', () => {
  it('index.html loads the boot script before the stylesheet and before the Google Fonts request, and app.js starts the theme', () => {
    const html = readFileSync(new URL('../../id/index.html', import.meta.url), 'utf8');
    assert.ok(html.indexOf('theme-boot.js') < html.indexOf('fonts.googleapis.com/css2') && html.indexOf('theme-boot.js') < html.indexOf('css/app.css'));
    const app = readFileSync(new URL('../../id/js/app.js', import.meta.url), 'utf8'); assert.match(app, /theme\.start\(\)/); assert.match(app, /\/v1\/web\/appearance/);
  });
  it('every component colour comes from variables that html.night redefines (no hard-coded light surfaces in views)', () => {
    const css = readFileSync(new URL('../../id/css/app.css', import.meta.url), 'utf8');
    const night = css.match(/html\.night\{[^}]*\}/)[0]; for (const v of ['--ink', '--muted', '--card', '--panel', '--field', '--bar', '--sky-grad', '--primary', 'color-scheme']) assert.ok(night.includes(v), `html.night must redefine ${v}`);
    assert.ok(/main:focus,main:focus-visible\{outline:none\}/.test(css), 'the page-frame focus ring must stay removed');
  });
});
