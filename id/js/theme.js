// Petali ID theme: Automatic / Day / Night.
//
//  * The CHOICE (auto | day | night) is per device (localStorage 'petali-id-theme'; "auto" = key absent), so it survives reloads, sign-outs and the next sign-in.
//  * The SCHEDULE used by Automatic is the one the user set in the Petali desktop app (account setting ui.autoNight, read through /v1/web/appearance),
//    kept in localStorage 'petali-id-schedule' so the page is painted correctly BEFORE any network answer. Default 22:00-06:00 when none is known.
//    It is account data, so it is removed when the account signs out.
//  * The decision is made by the desktop's own pure module (vendor/theme-schedule.js) when it is loaded, otherwise by the identical fallback below:
//    a missing script can therefore never leave Automatic stuck on Day.
//  * Applied before first paint by theme-boot.js, then kept current: at the exact schedule boundary (a timer), when the tab becomes visible or the
//    page is restored from the back/forward cache, and when ANOTHER tab changes the choice.
export const KEYS = { mode: 'petali-id-theme', schedule: 'petali-id-schedule' };
export const DEFAULT_SCHEDULE = Object.freeze({ from: '22:00', to: '06:00' });
export const COLORS = { day: '#ebf5e9', night: '#153d52' };       // <meta name="theme-color">: the page background of each theme
const LEGACY = { system: 'auto', light: 'day', dark: 'night' };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const parseTime = (v) => { if (typeof v !== 'string') return null; const m = TIME_RE.exec(v.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function sanitizeSchedule(s) {
  if (!s || typeof s !== 'object') return { ...DEFAULT_SCHEDULE };
  const a = parseTime(s.from); const b = parseTime(s.to);
  return a === null || b === null || a === b ? { ...DEFAULT_SCHEDULE } : { from: s.from.trim(), to: s.to.trim() };
}
// night = from <= time < to, wrapping midnight when from > to (identical to the desktop module)
export function isNightAt(schedule, date) {
  const s = sanitizeSchedule(schedule); const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const now = d.getHours() * 60 + d.getMinutes(); const from = parseTime(s.from); const to = parseTime(s.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}
export const resolveTheme = (mode, schedule, date) => (mode === 'day' ? 'day' : mode === 'night' ? 'night' : isNightAt(schedule, date) ? 'night' : 'day');
// Milliseconds until the theme next changes by the clock (Automatic only); null when it never will.
export function msUntilBoundary(schedule, date) {
  const s = sanitizeSchedule(schedule); const d = date; const nowMin = d.getHours() * 60 + d.getMinutes();
  const msIntoMinute = d.getSeconds() * 1000 + d.getMilliseconds();
  let best = Infinity;
  for (const t of [parseTime(s.from), parseTime(s.to)]) { let diff = t - nowMin; if (diff <= 0) diff += 1440; best = Math.min(best, diff * 60000 - msIntoMinute); }
  return Number.isFinite(best) ? best : null;
}

export function createTheme({ storage = safeStorage(), doc = typeof document !== 'undefined' ? document : null, win = typeof window !== 'undefined' ? window : null, now = () => new Date(), TS = globalThis.PetaliThemeSchedule } = {}) {
  const listeners = new Set(); let timer = null;
  const read = (k) => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
  const write = (k, v) => { try { if (!storage) return; if (v === null) storage.removeItem(k); else storage.setItem(k, v); } catch { /* storage unavailable: the choice then only lasts for this page */ } };
  let memoryMode = null;      // used when storage is unavailable, so a manual choice still works until reload
  const t = {
    getMode() { const raw = read(KEYS.mode); const v = LEGACY[raw] || raw; return v === 'day' || v === 'night' ? v : storage && read(KEYS.mode) === null && memoryMode ? memoryMode : 'auto'; },
    setMode(m) { const v = m === 'day' || m === 'night' ? m : 'auto'; memoryMode = v === 'auto' ? null : v; write(KEYS.mode, v === 'auto' ? null : v); t.apply(); },
    getSchedule() { let s = null; try { s = JSON.parse(read(KEYS.schedule) || 'null'); } catch { s = null; } return sanitizeSchedule(s); },
    hasCustomSchedule() { const s = t.getSchedule(); return s.from !== DEFAULT_SCHEDULE.from || s.to !== DEFAULT_SCHEDULE.to; },
    setSchedule(s) { if (s === null) write(KEYS.schedule, null); else { const c = sanitizeSchedule(s); write(KEYS.schedule, JSON.stringify(c)); } t.apply(); },
    resolve(date = now()) { const m = t.getMode(); const sch = t.getSchedule(); return TS && typeof TS.resolve === 'function' ? TS.resolve(m === 'auto' ? null : m, sch, date) : resolveTheme(m, sch, date); },
    apply() {
      const night = t.resolve() === 'night';
      if (doc && doc.documentElement) {
        doc.documentElement.classList.toggle('night', night);
        const m = doc.querySelector && doc.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', night ? COLORS.night : COLORS.day);
      }
      rearm(); listeners.forEach((f) => { try { f(night ? 'night' : 'day'); } catch { /* a listener must not break theming */ } });
      return night ? 'night' : 'day';
    },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    // Applies now, then keeps the page right: boundary timer, visibility, bfcache restore, other tabs.
    start() {
      t.apply();
      if (doc) doc.addEventListener('visibilitychange', () => { if (!doc.hidden) t.apply(); });
      if (win) { win.addEventListener('pageshow', () => t.apply()); win.addEventListener('focus', () => t.apply()); win.addEventListener('storage', (e) => { if (!e.key || e.key === KEYS.mode || e.key === KEYS.schedule) t.apply(); }); }
    },
    stop() { if (timer) clearTimeout(timer); timer = null; },
  };
  function rearm() {
    if (timer) clearTimeout(timer); timer = null;
    if (t.getMode() !== 'auto') return;
    const ms = msUntilBoundary(t.getSchedule(), now()); if (ms === null) return;
    // +1 s so the clock is safely past the boundary; capped so a long sleep or a clock change is corrected at least every minute
    timer = setTimeout(() => t.apply(), Math.min(ms + 1000, 60_000));
    if (timer && typeof timer === 'object' && timer.unref) timer.unref();
  }
  return t;
}
function safeStorage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } }
