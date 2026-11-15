import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createApi, ApiError } from '../../id/js/api.js';
import { createCache, MAX_AGE_MS } from '../../id/js/cache.js';
import { createSession } from '../../id/js/session.js';
import { createData } from '../../id/js/data.js';

const res = (status, body) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => body });
const user = (id, email = `${id}@x.io`) => ({ petaliId: id, email, displayName: id });
const sess = (id, n = 1) => res(200, { user: user(id), accessToken: `t${n}`, accessTokenExpiresAt: new Date(Date.now() + 9e5).toISOString() });

// A tiny fake Petali Cloud: one cookie session at a time, like a browser.
function world() {
  const w = { cookie: null, alive: new Set(), down: false, calls: [], accounts: { 'a@x.io': 'pa', 'b@x.io': 'pb' }, views: { pa: { v: 'A-data' }, pb: { v: 'B-data' } }, owner: {} };
  w.fetch = async (url, init) => {
    w.calls.push(`${init.method} ${url}`);
    if (w.down) throw new TypeError('network down');
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith('/session/login')) { const id = w.accounts[body.email]; if (!id || body.password !== 'pw') return res(401, { error: { code: 'invalid_credentials', message: 'bad' } }); w.cookie = `c-${id}-${w.alive.size}`; w.alive.add(w.cookie); w.owner[w.cookie] = id; return sess(id); }
    if (url.endsWith('/session/refresh')) { if (!w.cookie) return res(401, { error: { code: 'no_session', message: 'x' } }); if (!w.alive.has(w.cookie)) { w.cookie = null; return res(401, { error: { code: 'session_revoked', message: 'x' } }); } return sess(w.owner[w.cookie]); }
    if (url.endsWith('/session/logout')) { w.alive.delete(w.cookie); w.cookie = null; return res(204, null); }
    if (url.endsWith('/v1/web/overview')) { const id = w.owner[w.cookie]; return res(200, w.views[id]); }
    return res(404, { error: { code: 'not_found', message: 'x' } });
  };
  return w;
}
function setup(w) {
  const cache = createCache({ indexedDB: new IDBFactory() });
  const api = createApi({ fetchImpl: w.fetch, delays: [], locks: null });
  const states = [];
  const session = createSession({ api, cache, onChange: (s) => states.push(s.status) });
  const data = createData({ api, cache, session, isOnline: () => true });
  return { cache, api, session, data, states };
}
const load = (data, key, path) => new Promise((resolve) => { const seen = []; const c = data.watch(key, path, (st) => { seen.push(st); if (!st.loading) { c.stop(); resolve(seen); } }); });

describe('cache', () => {
  it('stores per account, returns only that account\'s copy, expires old copies', async () => {
    let t = 1000; const cache = createCache({ indexedDB: new IDBFactory(), now: () => t });
    await cache.put('pa', 'overview', { x: 1 }); await cache.put('pb', 'overview', { x: 2 });
    assert.deepEqual((await cache.get('pa', 'overview')).data, { x: 1 }); assert.deepEqual((await cache.get('pb', 'overview')).data, { x: 2 }); assert.equal(await cache.get('pc', 'overview'), null); assert.equal(await cache.get(null, 'overview'), null);
    t += MAX_AGE_MS + 1; assert.equal(await cache.get('pa', 'overview'), null);
  });
  it('wipeAll removes every view and marker', async () => {
    const cache = createCache({ indexedDB: new IDBFactory() }); await cache.put('pa', 'k', 1); await cache.setMeta('lastSession', { petaliId: 'pa' });
    await cache.wipeAll(); assert.equal(await cache.get('pa', 'k'), null); assert.equal(await cache.getMeta('lastSession'), null); assert.deepEqual(await cache.list(), []);
  });
  it('degrades quietly without IndexedDB', async () => {
    const cache = createCache({ indexedDB: null }); assert.equal(await cache.put('pa', 'k', 1), false); assert.equal(await cache.get('pa', 'k'), null); assert.equal(await cache.getMeta('x'), null);
  });
  it('holds no credentials: whatever is stored never contains token text', async () => {
    const w = world(); const s = setup(w); await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview');
    assert.ok(!JSON.stringify(await s.cache.list()).includes('t1')); assert.ok(!JSON.stringify(await s.cache.list()).includes('c-pa'));
  });
});

describe('session', () => {
  let w; let s;
  beforeEach(() => { w = world(); s = setup(w); });
  it('first visit with no cookie: anonymous (not an error)', async () => { assert.equal(await s.session.boot(), 'anonymous'); });
  it('login, then a later visit restores the session from the cookie', async () => {
    await s.session.login('a@x.io', 'pw'); assert.equal(s.session.state().status, 'authenticated');
    const again = setup(w); again.cache = s.cache; // same browser: cookie jar (w.cookie) persists
    const s2 = createSession({ api: createApi({ fetchImpl: w.fetch, delays: [], locks: null }), cache: s.cache }); assert.equal(await s2.boot(), 'authenticated'); assert.equal(s2.userId(), 'pa');
  });
  it('wrong password is a plain error, nothing is stored', async () => {
    await assert.rejects(s.session.login('a@x.io', 'nope'), (e) => e.code === 'invalid_credentials'); assert.equal(s.session.state().status, 'booting'); assert.equal(await s.cache.getMeta('lastSession'), null);
  });
  it('logout: server session ended, cookie gone, local copies wiped', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview');
    await s.session.logout(); assert.equal(s.session.state().status, 'anonymous'); assert.equal(w.alive.size, 0); assert.deepEqual(await s.cache.list(), []); assert.equal(await s.cache.getMeta('lastSession'), null);
  });
  it('ACCOUNT SWITCHING: nothing of account A remains once B signs in', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview'); assert.equal((await s.cache.list()).length, 1);
    w.cookie = null;                                   // A's cookie is gone (e.g. session expired) and B signs in on the same browser without a logout
    await s.session.login('b@x.io', 'pw');
    assert.equal(s.session.userId(), 'pb'); assert.deepEqual((await s.cache.list()).filter((e) => e.userId === 'pa'), []); assert.equal(await s.cache.get('pa', 'overview'), null);
    const seen = await load(s.data, 'overview', '/v1/web/overview'); assert.equal(seen.at(-1).data.v, 'B-data'); assert.ok(!seen.some((x) => x.data && x.data.v === 'A-data'), 'A\'s data was never shown to B');
  });
  it('REVOKED session on boot: signed out and every saved copy wiped', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview'); w.alive.clear();
    const s2 = createSession({ api: createApi({ fetchImpl: w.fetch, delays: [], locks: null }), cache: s.cache });
    assert.equal(await s2.boot(), 'anonymous'); assert.equal(s2.state().reason, 'session_ended'); assert.deepEqual(await s.cache.list(), []);
  });
  it('REVOKED while using the app (a request gets 401): signed out and wiped', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview'); w.alive.clear(); s.api.forget();
    const api = createApi({ fetchImpl: w.fetch, delays: [], locks: null, onAuthLost: () => s.session.authLost() }); const sess2 = createSession({ api, cache: s.cache }); await sess2.boot().catch(() => {});
    assert.equal(sess2.state().status, 'anonymous'); assert.deepEqual(await s.cache.list(), []);
  });
  it('SERVER DOWN on boot: offline mode with the last account and its saved data, NOT signed out, nothing erased', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview');
    w.down = true; const s2 = createSession({ api: createApi({ fetchImpl: w.fetch, delays: [], locks: null }), cache: s.cache });
    assert.equal(await s2.boot(), 'offline'); assert.equal(s2.userId(), 'pa'); assert.equal((await s.cache.list()).length, 1); assert.ok(w.alive.size === 1, 'the real session is untouched');
    const d2 = createData({ api: createApi({ fetchImpl: w.fetch, delays: [], locks: null }), cache: s.cache, session: s2, isOnline: () => true });
    const seen = await load(d2, 'overview', '/v1/web/overview'); const last = seen.at(-1); assert.equal(last.cached, true); assert.equal(last.data.v, 'A-data'); assert.ok(last.offline && typeof last.savedAt === 'number');
  });
  it('server down and nothing saved: "unreachable", not "signed out"', async () => { w.down = true; assert.equal(await s.session.boot(), 'unreachable'); });
  it('coming back online restores the real session (retry)', async () => {
    await s.session.login('a@x.io', 'pw'); w.down = true;
    const s2 = createSession({ api: createApi({ fetchImpl: w.fetch, delays: [], locks: null }), cache: s.cache }); await s2.boot(); assert.equal(s2.state().status, 'offline');
    w.down = false; assert.equal(await s2.retry(), 'authenticated');
  });
  it('a server error (500) on boot is also not a sign-out', async () => {
    await s.session.login('a@x.io', 'pw'); const f = async () => res(500, {}); const s2 = createSession({ api: createApi({ fetchImpl: f, delays: [], locks: null }), cache: s.cache }); assert.equal(await s2.boot(), 'offline');
  });
  it('OFFLINE LOGOUT: local data is wiped at once and the server sign-out is completed on the next visit BEFORE the cookie can restore the session', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview');
    w.down = true; await s.session.logout(); assert.equal(s.session.state().status, 'anonymous'); assert.deepEqual((await s.cache.list()), []); assert.equal(await s.cache.getMeta('pendingLogout'), true);
    w.down = false; assert.equal(w.alive.size, 1, 'the cookie session is still alive on the server');
    const s2 = createSession({ api: createApi({ fetchImpl: w.fetch, delays: [], locks: null }), cache: s.cache }); assert.equal(await s2.boot(), 'anonymous'); assert.equal(w.alive.size, 0); assert.equal(await s.cache.getMeta('pendingLogout'), null);
  });
  it('saved copies are replaced by fresh data, and a failed refresh keeps the copy', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview'); w.views.pa = { v: 'A-new' };
    let seen = await load(s.data, 'overview', '/v1/web/overview'); assert.equal(seen.at(-1).data.v, 'A-new'); assert.equal(seen.at(-1).cached, false); assert.equal(seen[0].cached, true, 'the saved copy is shown first, labelled');
    w.down = true; seen = await load(s.data, 'overview', '/v1/web/overview'); const last = seen.at(-1); assert.equal(last.cached, true); assert.equal(last.data.v, 'A-new'); assert.ok(last.error instanceof ApiError);
    assert.equal((await s.cache.get('pa', 'overview')).data.v, 'A-new', 'not erased by the failure');
  });
  it('a 404 does not fall back to a saved copy of something that is gone', async () => {
    await s.session.login('a@x.io', 'pw'); await s.cache.put('pa', 'gone', { v: 1 }); const seen = await load(s.data, 'gone', '/v1/web/nothing'); assert.equal(seen.at(-1).data, undefined); assert.equal(seen.at(-1).error.status, 404);
  });
  it('SLOW server on boot (cold start): the last account\'s saved copies are shown after a moment, and the real session takes over when the server answers', async () => {
    await s.session.login('a@x.io', 'pw'); await load(s.data, 'overview', '/v1/web/overview');
    let release; const gate = new Promise((r) => { release = r; });
    const slowFetch = async (url, init) => { if (url.endsWith('/session/refresh')) await gate; return w.fetch(url, init); };
    const s2 = createSession({ api: createApi({ fetchImpl: slowFetch, delays: [], locks: null }), cache: s.cache, slowMs: 20 });
    assert.equal(await s2.boot(), 'offline'); assert.equal(s2.state().reason, 'slow'); assert.equal(s2.userId(), 'pa');
    release(); await new Promise((r) => setTimeout(r, 30)); assert.equal(s2.state().status, 'authenticated');
  });
  it('a slow server whose answer is "session revoked" ends the session once it answers, and wipes the copies', async () => {
    await s.session.login('a@x.io', 'pw'); await s.cache.put('pa', 'k', 1); w.alive.clear();
    let release; const gate = new Promise((r) => { release = r; });
    const s2 = createSession({ api: createApi({ fetchImpl: async (u, i) => { if (u.endsWith('/refresh')) await gate; return w.fetch(u, i); }, delays: [], locks: null }), cache: s.cache, slowMs: 10 });
    await s2.boot(); release(); await new Promise((r) => setTimeout(r, 30)); assert.equal(s2.state().status, 'anonymous'); assert.deepEqual(await s.cache.list(), []);
  });
  it('a device that is offline does not wait through cold-start retries', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true }); let n = 0;
    const api = createApi({ fetchImpl: async () => { n += 1; throw new TypeError('offline'); }, delays: [50, 50, 50], locks: null });
    const t = Date.now(); await assert.rejects(api.refresh()); assert.equal(n, 1); assert.ok(Date.now() - t < 40); delete globalThis.navigator;
  });
});
