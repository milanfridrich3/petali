// Production readiness of the Netlify site (https://petali.netlify.app): configuration, routing, headers, no development leftovers, HTTPS-only API,
// and the error / recovery behaviour of the API client. Static checks of the files that are deployed; nothing is deployed or contacted.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { createApi, ApiError } from '../../id/js/api.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const toml = read('netlify.toml');
const blocks = (kind) => toml.split(`[[${kind}]]`).slice(1).map((b) => b.split(/\n\[/)[0]);
const field = (b, k) => (new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, 'm').exec(b) || [])[1];
const redirects = blocks('redirects').map((b) => ({ from: field(b, 'from'), to: field(b, 'to'), status: Number(field(b, 'status')), force: /force\s*=\s*true/.test(b) }));
const headerFor = (path) => blocks('headers').find((b) => field(b, 'for') === path) || '';
const walk = (d) => readdirSync(d).flatMap((n) => { if (['node_modules', '.git', 'id-dev', 'screenshots'].includes(n)) return []; const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('Netlify: API proxy and SPA fallback', () => {
  it('the API proxy is the FIRST rule, forced, and points at the production Render backend over HTTPS', () => {
    const r = redirects[0]; assert.equal(r.from, '/id/api/*'); assert.equal(r.to, 'https://petali-v2.onrender.com/:splat'); assert.equal(r.status, 200); assert.equal(r.force, true);
  });
  it('every direct navigation to an internal route is answered with the app (SPA fallback); real files win; no redirect loop rule exists', () => {
    const fb = redirects.find((r) => r.from === '/id/*'); assert.equal(fb.to, '/id/index.html'); assert.equal(fb.status, 200); assert.equal(fb.force, false, 'not forced: real files are served first');
    assert.ok(redirects.some((r) => r.from === '/id' && r.to === '/id/index.html' && r.status === 200));
    for (const r of redirects) assert.ok(!(r.status === 301 && /^\/id\/?$/.test(r.from)), `no /id <-> /id/ redirect: ${r.from}`);
    for (const f of ['id/index.html', 'id/sw.js', 'id/manifest.webmanifest', 'support-config.json']) assert.ok(existsSync(join(ROOT, f)), f);
  });
  it('the backend sources, build tools and developer tests are not served', () => {
    for (const p of ['/cloud/*', '/tools/*', '/id-dev/*']) { const r = redirects.find((x) => x.from === p); assert.ok(r && r.status === 404 && r.force, p); }
  });
  it('the build step only generates the support configuration, with a pinned Node version and nothing secret', () => {
    assert.match(toml, /\[build\][\s\S]*command = "node tools\/generate-support-config\.mjs"[\s\S]*publish = "\."/); assert.match(toml, /NODE_VERSION = "22"/);
    assert.ok(!/(secret|token|password|api[_-]?key)\s*=/i.test(toml), 'no secret in netlify.toml');
  });
});

describe('Netlify: security headers', () => {
  it('the whole site gets HSTS, nosniff, a referrer policy, a permissions policy and frame protection', () => {
    const h = headerFor('/*'); assert.match(h, /Strict-Transport-Security = "max-age=31536000/); assert.match(h, /X-Content-Type-Options = "nosniff"/); assert.match(h, /Referrer-Policy = "strict-origin-when-cross-origin"/); assert.match(h, /Permissions-Policy/); assert.match(h, /X-Frame-Options = "DENY"/);
  });
  it('Petali ID has a strict Content-Security-Policy: own scripts only, no eval, no inline script, same-origin API, no framing, and nothing in the support page needs more', () => {
    const csp = field(headerFor('/id/*'), 'Content-Security-Policy'); assert.ok(csp);
    assert.match(csp, /default-src 'self'/); assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /connect-src 'self'(;|$)/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'none'/);
    assert.ok(!/unsafe-eval|unsafe-inline.*script|script-src[^;]*\*/.test(csp), csp); assert.ok(!/http:/.test(csp));
    for (const f of walk(join(ROOT, 'id/js')).filter((p) => /support/.test(p))) assert.ok(!/\.style\.|setAttribute\('style'|innerHTML|eval\(|new Function/.test(readFileSync(f, 'utf8')), `${relative(ROOT, f)} must work under the CSP`);
  });
  it('the support configuration is never cached', () => { const h = headerFor('/support-config.json'); assert.match(h, /Cache-Control = "no-store"/); });
  it('the service worker is never served from a stale cache', () => { assert.match(headerFor('/id/sw.js'), /Cache-Control = "no-cache|max-age=0/); });
});

describe('production build: no development leftovers, HTTPS only', () => {
  const served = walk(ROOT).filter((p) => /\.(js|mjs|html|json|webmanifest|css)$/.test(p) && !/\/(cloud|tools)\//.test(p) && !/package(-lock)?\.json$/.test(p));
  it('no localhost / loopback / plain-http API address is shipped', () => {
    for (const f of served) { const s = readFileSync(f, 'utf8').replace(/http:\/\/www\.w3\.org\/[^'"\s)]+/g, ''); assert.ok(!/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')), `${relative(ROOT, f)} mentions a local address`); }
  });
  it('the API base is the same-origin HTTPS proxy path; no absolute http(s) API URL is built in the app code', () => {
    assert.match(read('id/js/api.js'), /base = '\/id\/api'/);
    for (const f of walk(join(ROOT, 'id/js'))) assert.ok(!/['"`]https?:\/\/[^'"`]*(onrender|petali-v2)/.test(readFileSync(f, 'utf8')), relative(ROOT, f));
    assert.ok(!/http:\/\//.test(read('id/index.html').replace(/http:\/\/www\.w3\.org\/\S+/g, '')));
  });
  it('no debug output, test accounts, debug endpoints or developer panels in the shipped app code', () => {
    for (const f of walk(join(ROOT, 'id/js')).concat([join(ROOT, 'id/sw.js')])) { const s = readFileSync(f, 'utf8'); assert.ok(!/console\.(log|debug|trace)|debugger;|\/v1\/debug|\/debug\b|test@example|demo@|devtools|window\.__/i.test(s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), relative(ROOT, f)); }
  });
  it('the site publishes no environment file and no secret-looking value', () => {
    for (const f of walk(ROOT)) { assert.ok(!/(^|\/)\.env($|\.)/.test(relative(ROOT, f)) || /\.env\.example$/.test(f), relative(ROOT, f)); }
    for (const f of served) assert.ok(!/(sk_live|-----BEGIN [A-Z ]*PRIVATE KEY|re_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30})/.test(readFileSync(f, 'utf8')), relative(ROOT, f));
  });
  it('the frontend has no environment variable that needs a secret: the only build input is SUPPORT_* (public recipient details)', () => { assert.ok(!/process\.env/.test(read('id/js/api.js'))); });
});

describe('production error states and recovery (API client)', () => {
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => { if (body === undefined) throw new SyntaxError('bad json'); return body; } });
  const mk = (fetchImpl, extra = {}) => createApi({ fetchImpl, locks: null, delays: [1, 1, 1], ...extra });

  it('API unavailable (network error): a clear error, nothing thrown raw, and a retry after recovery succeeds', async () => {
    let up = false; const api = mk(async () => { if (!up) throw new TypeError('Failed to fetch'); return json(200, { ok: true }); });
    await assert.rejects(() => api.get('/v1/health', { auth: false, retry: false }), (e) => e instanceof ApiError && /reach/i.test(e.message));
    up = true; assert.deepEqual(await api.get('/v1/health', { auth: false }), { ok: true });
  });
  it('timeout: a hanging server ends in a friendly "did not answer in time" error, then works again', async () => {
    let hang = true; const api = mk((url, init) => (hang ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) : Promise.resolve(json(200, { ok: 1 }))), { timeoutMs: 30 });
    await assert.rejects(() => api.get('/v1/health', { auth: false, retry: false }), (e) => e instanceof ApiError && /in time/i.test(e.message));
    hang = false; assert.deepEqual(await api.get('/v1/health', { auth: false }), { ok: 1 });
  });
  it('invalid response (not JSON / empty body on a JSON endpoint): reported as an error, not a crash', async () => {
    const api = mk(async () => json(200, undefined));
    await assert.rejects(() => api.get('/v1/health', { auth: false, retry: false }), (e) => e instanceof ApiError && e.code === 'invalid_response' && e.transient);
    await assert.rejects(() => api.login('a@b.cz', 'x'), (e) => e instanceof ApiError && e.code === 'invalid_response');   // the session endpoints too: no TypeError on a null body
    await assert.rejects(() => mk(async () => json(200, undefined)).get('/v1/account'), (e) => e instanceof ApiError && e.transient, 'an unusable refresh answer is a transient error, not a crash and not a sign-out');
  });
  it('server error and cold start (502/503/504): a transient error, never a sign-out; the retry recovers', async () => {
    let n = 0; const api = mk(async () => (n++ < 1 ? json(503, { error: { code: 'unavailable', message: 'Starting up.' } }) : json(200, { ok: 2 })));
    assert.deepEqual(await api.get('/v1/health', { auth: false }), { ok: 2 });
  });
  it('offline mode: the navigator being offline raises the error at once (no waiting around)', async () => {
    const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    try { let calls = 0; const api = mk(async () => { calls += 1; throw new TypeError('offline'); }); const t0 = Date.now(); await assert.rejects(() => api.get('/v1/health', { auth: false }), (e) => e instanceof ApiError); assert.ok(Date.now() - t0 < 1500); assert.ok(calls <= 1); }
    finally { if (was) Object.defineProperty(globalThis, 'navigator', was); else delete globalThis.navigator; }
  });
  it('API error responses keep their code and a safe message (no stack, no internals)', async () => {
    const api = mk(async () => json(422, { error: { code: 'inappropriate_text', message: 'This text contains words that are not allowed. Please choose another.', requestId: 'r1' } }));
    await assert.rejects(() => api.post('/v1/account/profile', { displayName: 'x' }, { auth: false }), (e) => e.code === 'inappropriate_text' && !/\bstack\b|\bat \w+ \(/.test(e.message));
  });
});
