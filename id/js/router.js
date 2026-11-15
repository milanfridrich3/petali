// Routing for Petali ID. Everything lives under /id; there is no other application path.
export const BASE = '/id';
const ROUTES = [
  { name: 'dashboard', pattern: '', public: false },
  { name: 'login', pattern: 'login', public: true },
  { name: 'register', pattern: 'register', public: true },
  { name: 'verify', pattern: 'verify', public: true, always: true },
  { name: 'computers', pattern: 'computers', public: false },
  { name: 'computer', pattern: 'computers/:deviceId', public: false },
  { name: 'plant', pattern: 'plant', public: false },
  { name: 'usage', pattern: 'usage', public: false },
  { name: 'health', pattern: 'health', public: false },
  { name: 'reports', pattern: 'reports', public: false },
  { name: 'settings', pattern: 'settings', public: false },
  { name: 'more', pattern: 'more', public: false },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// pathname -> { name, params, path, public } ; unknown paths under /id give { name: 'notfound' }.
export function matchRoute(pathname) {
  const p = String(pathname || '');
  if (p !== BASE && !p.startsWith(`${BASE}/`)) return { name: 'outside', params: {}, path: p, public: true };
  const rest = p.slice(BASE.length).replace(/^\/+|\/+$/g, '');
  const parts = rest === '' ? [] : rest.split('/');
  for (const r of ROUTES) {
    const pat = r.pattern === '' ? [] : r.pattern.split('/');
    if (pat.length !== parts.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < pat.length; i += 1) {
      if (pat[i].startsWith(':')) { if (pat[i] === ':deviceId' && !UUID.test(parts[i])) { ok = false; break; } params[pat[i].slice(1)] = parts[i]; } else if (pat[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { name: r.name, params, path: rest === '' ? BASE : `${BASE}/${rest}`, public: r.public, ...(r.always ? { always: true } : {}) };
  }
  return { name: 'notfound', params: {}, path: p, public: false };
}

// Only an internal /id path may be used as a "return to" target (open-redirect protection). Returns the safe path (+ query) or null.
export function safeReturnPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  let decoded; try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.includes('//') || decoded.split('?')[0].split('/').includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  if (!raw.startsWith('/')) return null;
  let u; try { u = new URL(raw, 'https://petali.invalid'); } catch { return null; }
  if (u.origin !== 'https://petali.invalid') return null;
  if (u.pathname !== BASE && !u.pathname.startsWith(`${BASE}/`)) return null;
  const m = matchRoute(u.pathname);
  if (m.name === 'login' || m.name === 'register' || m.name === 'verify' || m.name === 'notfound' || m.name === 'outside') return null;
  return u.pathname.replace(/\/+$/, '') + u.search;
}

export const loginUrl = (returnPath) => { const s = safeReturnPath(returnPath); return s && s !== BASE ? `${BASE}/login?next=${encodeURIComponent(s)}` : `${BASE}/login`; };
export const nextFromSearch = (search) => safeReturnPath(new URLSearchParams(search || '').get('next') || '') || BASE;
