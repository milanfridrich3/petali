import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApi, ApiError } from '../../id/js/api.js';

const json = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const session = (n = 1) => json(200, { user: { petaliId: 'p1' }, accessToken: `tok${n}`, accessTokenExpiresAt: new Date(Date.now() + 900000).toISOString() });
function make(handler, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls); };
  return { api: createApi({ fetchImpl, delays: [1, 1, 1], locks: null, ...extra }), calls };
}

describe('api client', () => {
  it('goes through the same-origin proxy, sends cookies same-origin and the CSRF header, never the refresh token', async () => {
    const { api, calls } = make((url) => (url.includes('/session/login') ? session() : json(200, { ok: 1 })));
    await api.login('a@b.c', 'pw');
    const c = calls[0]; assert.equal(c.url, '/id/api/v1/web/session/login'); assert.equal(c.init.credentials, 'same-origin'); assert.equal(c.init.headers['X-Petali-Web'], '1'); assert.equal(c.init.cache, 'no-store');
    await api.get('/v1/web/overview'); assert.equal(calls[1].url, '/id/api/v1/web/overview'); assert.equal(calls[1].init.headers.Authorization, 'Bearer tok1');
  });
  it('restores the access token from the cookie session when none is held, and renews it before it expires', async () => {
    let t = Date.now(); let n = 0;
    const { api, calls } = make((url) => (url.includes('/session/refresh') ? session(++n) : json(200, { ok: 1 })), { now: () => t });
    await api.get('/v1/web/overview'); assert.equal(calls.filter((c) => c.url.includes('refresh')).length, 1); assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer tok1');
    await api.get('/v1/web/overview'); assert.equal(calls.filter((c) => c.url.includes('refresh')).length, 1, 'still valid');
    t += 890000; await api.get('/v1/web/overview'); assert.equal(calls.filter((c) => c.url.includes('refresh')).length, 2); assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer tok2');
  });
  it('concurrent calls share one refresh', async () => {
    const { api, calls } = make((url) => (url.includes('/session/refresh') ? session() : json(200, {})));
    await Promise.all([api.get('/v1/a'), api.get('/v1/b'), api.get('/v1/c')]);
    assert.equal(calls.filter((c) => c.url.includes('refresh')).length, 1);
  });
  it('refresh is serialised through Web Locks when available', async () => {
    let used = null; const locks = { request: async (name, fn) => { used = name; return fn(); } };
    const { api } = make((url) => (url.includes('/session/refresh') ? session() : json(200, {})), { locks });
    await api.get('/v1/x'); assert.equal(used, 'petali-session-refresh');
  });
  it('an expired access token is renewed once and the request repeated', async () => {
    let first = true; let n = 0;
    const { api, calls } = make((url) => { if (url.includes('/session/refresh')) return session(++n); if (first) { first = false; return json(401, { error: { code: 'token_expired', message: 'x' } }); } return json(200, { ok: 1 }); });
    assert.deepEqual(await api.get('/v1/x'), { ok: 1 }); assert.equal(calls.filter((c) => c.url.includes('refresh')).length, 2);
  });
  it('a revoked session (401 on refresh) reports auth lost', async () => {
    let lost = null;
    const { api } = make(() => json(401, { error: { code: 'session_revoked', message: 'x' } }), { onAuthLost: (e) => { lost = e; } });
    await assert.rejects(api.get('/v1/x'), (e) => e instanceof ApiError && e.status === 401);
    assert.equal(lost.code, 'session_revoked');
  });
  it('a cold start (network error / 502 / 503 / 504) is retried with a notice and succeeds', async () => {
    let n = 0; let slow = 0;
    const { api } = make((url) => { if (url.includes('refresh')) return session(); n += 1; if (n === 1) throw new TypeError('fetch failed'); if (n === 2) return json(503, {}); if (n === 3) return json(504, {}); return json(200, { ok: 1 }); }, { onSlow: () => { slow += 1; } });
    assert.deepEqual(await api.get('/v1/x'), { ok: 1 }); assert.equal(slow, 3);
  });
  it('temporary failures are "transient" and NEVER reported as lost authentication', async () => {
    for (const mk of [() => { throw new TypeError('offline'); }, () => json(500, {}), () => json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '7' })]) {
      let lost = false;
      const { api } = make((url) => (url.includes('refresh') ? session() : mk()), { onAuthLost: () => { lost = true; }, delays: [] });
      await assert.rejects(api.get('/v1/x'), (e) => e instanceof ApiError && e.transient);
      assert.equal(lost, false);
    }
  });
  it('a refresh that fails transiently is not a sign-out either', async () => {
    let lost = false;
    const { api } = make(() => json(502, {}), { onAuthLost: () => { lost = true; }, delays: [] });
    await assert.rejects(api.refresh(), (e) => e.transient); assert.equal(lost, false);
  });
  it('writes are not retried blindly', async () => {
    let n = 0; const { api } = make((url) => { if (url.includes('refresh')) return session(); n += 1; return json(503, {}); });
    await assert.rejects(api.post('/v1/x', {})); assert.equal(n, 1);
  });
  it('times out hanging requests', async () => {
    const { api } = make((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), { timeoutMs: 20, delays: [] });
    await assert.rejects(api.login('a', 'b'), (e) => e.code === 'timeout' && e.transient);
  });
  it('API errors keep their code, message and request id', async () => {
    const { api } = make(() => json(401, { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.', requestId: 'r1' } }));
    await assert.rejects(api.login('a', 'b'), (e) => e.code === 'invalid_credentials' && e.requestId === 'r1' && !e.transient);
  });
  it('the access token is never written to browser storage', async () => {
    const stored = []; globalThis.localStorage = { setItem: (...a) => stored.push(a) }; globalThis.sessionStorage = { setItem: (...a) => stored.push(a) };
    const { api } = make(() => session()); await api.login('a', 'b'); assert.deepEqual(stored, []);
    delete globalThis.localStorage; delete globalThis.sessionStorage;
  });
});
