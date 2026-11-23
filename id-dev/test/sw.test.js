import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, beforeEach } from 'node:test';

const SRC = readFileSync(new URL('../../id/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://petali.netlify.app';

function harness({ online = true, pages = {} } = {}) {
  const stores = new Map(); const listeners = {}; const fetched = [];
  const key = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const cachesImpl = {
    async open(name) { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name); return { async put(r, res) { m.set(key(r), res); }, async match(r) { return m.get(key(r)); } }; },
    async keys() { return [...stores.keys()]; }, async delete(n) { return stores.delete(n); },
    async match(r, o) { const m = stores.get(o && o.cacheName); return m ? m.get(key(r)) : undefined; },
  };
  const mkRes = (body, o = {}) => ({ ok: o.ok ?? true, status: o.status ?? 200, redirected: false, type: 'basic', headers: { get: (k) => (k.toLowerCase() === 'content-type' ? o.type || 'text/html' : null) }, body, clone() { return this; } });
  const net = { online };
  const fetchImpl = async (r) => { const p = key(r); fetched.push(p); if (!net.online) throw new TypeError('offline'); return mkRes(pages[p] ?? `net:${p}`, { type: p.endsWith('.js') ? 'text/javascript' : 'text/html' }); };
  const self = { location: new URL(`${ORIGIN}/id/sw.js`), skipWaiting: () => {}, clients: { claim: async () => {} }, addEventListener: (t, f) => { listeners[t] = f; }, caches: cachesImpl };
  const ctx = vm.createContext({ self, caches: cachesImpl, fetch: fetchImpl, Request: class { constructor(u, i) { this.url = new URL(u, ORIGIN).href; this.mode = 'cors'; Object.assign(this, i); } }, Response: class { constructor(b, i) { Object.assign(this, { body: b, status: i && i.status, ok: false, headers: { get: () => null } }); } }, URL, setTimeout, clearTimeout, Promise });
  vm.runInContext(SRC, ctx);
  const dispatch = async (t, ev) => { let p; ev.waitUntil = (x) => { p = x; }; ev.respondWith = (x) => { ev.__resp = x; }; listeners[t](ev); if (p) await p; return ev.__resp ? await ev.__resp : undefined; };
  const request = (path, { method = 'GET', mode = 'cors', origin = ORIGIN } = {}) => ({ request: { url: `${origin}${path}`, method, mode } });
  return { stores, fetched, net, dispatch, request, handled: async (path, o) => { const ev = request(path, o); const r = await dispatch('fetch', ev); return r; }, installed: () => dispatch('install', {}) };
}
const PRE = [...SRC.slice(SRC.indexOf('const PRECACHE'), SRC.indexOf('];', SRC.indexOf('const PRECACHE'))).matchAll(/'(\/[^']+)'/g)].map((m) => m[1]);

describe('service worker', () => {
  let h;
  beforeEach(async () => { h = harness({ pages: { '/id/index.html': 'SHELL' } }); await h.installed(); await h.dispatch('activate', {}); });

  it('install precaches the whole app shell', () => { const names = [...h.stores.keys()]; assert.equal(names.length, 1); const cache = h.stores.get(names[0]); for (const p of PRE) assert.ok(cache.has(p), p); assert.ok(cache.has('/id/index.html')); });
  it('never intercepts the API (no caching of responses, sessions, tokens)', async () => {
    for (const p of ['/id/api/v1/web/overview', '/id/api/v1/web/session/refresh', '/id/api/v1/devices']) { const before = h.fetched.length; assert.equal(await h.handled(p), undefined, p); assert.equal(h.fetched.length, before, 'the worker did not even fetch'); }
    for (const c of h.stores.values()) for (const k of c.keys()) assert.ok(!k.startsWith('/id/api'), k);
  });
  it('ignores non-GET requests and other origins', async () => { assert.equal(await h.handled('/id/plant', { method: 'POST', mode: 'navigate' }), undefined); assert.equal(await h.handled('/id/js/app.js', { origin: 'https://evil.example' }), undefined); });
  it('does not take over the landing page or anything outside /id/', async () => {
    for (const p of ['/', '/feedback.html', '/index.html', '/idx', '/app', '/identity/login']) assert.equal(await h.handled(p, { mode: 'navigate' }), undefined, p);
    assert.equal(await h.handled('/styles.css'), undefined); assert.equal(await h.handled('/og-image.png'), undefined);
  });
  it('every /id/... navigation is answered with the app shell when offline - on every route', async () => {
    h.net.online = false;
    for (const p of ['/id/', '/id/login', '/id/register', '/id/computers', '/id/computers/3f2b8c1e-5d4a-4e7b-9a10-1c2d3e4f5a6b', '/id/plant', '/id/usage', '/id/health', '/id/reports', '/id/settings', '/id/more']) { const r = await h.handled(p, { mode: 'navigate' }); assert.equal(r.body, 'SHELL', p); }
  });
  it('online navigations go to the network and refresh the cached shell', async () => {
    const h2 = harness({ pages: { '/id/plant': '<html>new shell</html>' } }); await h2.installed();
    const r = await h2.handled('/id/plant', { mode: 'navigate' }); assert.equal(r.body, '<html>new shell</html>'); h2.net.online = false;
    assert.equal((await h2.handled('/id/usage', { mode: 'navigate' })).body, '<html>new shell</html>');
  });
  it('offline before the first visit gives a plain 503, not a broken page', async () => { const h2 = harness({ online: false }); const r = await h2.handled('/id/login', { mode: 'navigate' }); assert.equal(r.status, 503); });
  it('static assets: cache first, refreshed in the background; works offline', async () => {
    h.net.online = false; const r = await h.handled('/id/js/app.js'); assert.ok(r && String(r.body).startsWith('net:'), 'served from the precache'); assert.equal((await h.handled('/id/css/app.css')).body, 'net:/id/css/app.css');
  });
  it('does not cache or handle arbitrary files and never the worker itself', async () => { assert.equal(await h.handled('/id/sw.js'), undefined); assert.equal(await h.handled('/id/secrets.json'), undefined); });
  it('activate removes old cache versions only', async () => {
    const h2 = harness(); await h2.installed(); h2.stores.set('petali-id-shell-v0', new Map()); h2.stores.set('other-site-cache', new Map()); await h2.dispatch('activate', {});
    assert.ok(!h2.stores.has('petali-id-shell-v0')); assert.ok(h2.stores.has('other-site-cache')); assert.ok(h2.stores.has('petali-id-shell-v6-1.6.0'));
  });
  it('the clear-caches message empties and rebuilds the shell cache', async () => { const before = h.fetched.length; await h.dispatch('message', { data: { type: 'clear-caches' } }); assert.ok(h.fetched.length > before); assert.ok([...h.stores.values()][0].has('/id/index.html')); });
  it('unknown messages are ignored', async () => { const n = h.stores.size; await h.dispatch('message', { data: { type: 'x' } }); assert.equal(h.stores.size, n); });
});
