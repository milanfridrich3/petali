import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import { loadConfig } from '../src/config/env';
import { createTestEnv, type TestEnv } from './helpers';

const SITE = 'https://petali.netlify.app';
const prod = (extra: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h:5432/d', JWT_ACCESS_SECRET: randomBytes(48).toString('base64'), ...extra });

describe('production configuration: CORS and binding', () => {
  it('defaults: CORS allows only https://petali.netlify.app; the server binds 0.0.0.0 in production and honours PORT', () => {
    const c = prod({ PORT: '10000' });
    assert.deepEqual(c.corsOrigins, [SITE]); assert.equal(c.host, '0.0.0.0'); assert.equal(c.port, 10000);
  });
  it('preview origins are explicit additions, never wildcards', () => {
    assert.deepEqual(prod({ CORS_PREVIEW_ORIGINS: 'https://deploy-preview-7--petali.netlify.app' }).corsOrigins, [SITE, 'https://deploy-preview-7--petali.netlify.app']);
    for (const bad of ['*', 'https://*.netlify.app', 'https://petali.netlify.app/', 'https://petali.netlify.app/id', 'petali.netlify.app', 'http://petali.netlify.app', 'https://localhost:3000', 'https://127.0.0.1']) {
      assert.throws(() => prod({ CORS_ALLOWED_ORIGINS: bad }), /CORS_ALLOWED_ORIGINS|CORS_PREVIEW_ORIGINS/, bad);
      assert.throws(() => prod({ CORS_PREVIEW_ORIGINS: bad }), /CORS_/, bad);
    }
  });
  it('outside production a local origin is accepted (development and tests only)', () => {
    assert.deepEqual(loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@h/d', JWT_ACCESS_SECRET: randomBytes(48).toString('base64'), CORS_ALLOWED_ORIGINS: 'http://localhost:8888' }).corsOrigins, ['http://localhost:8888']);
  });
});

describe('production behaviour: /health, CORS, safe errors, rate limit, logs', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ CORS_PREVIEW_ORIGINS: 'https://deploy-preview-7--petali.netlify.app', RATE_LIMIT_GENERAL_MAX: '12' }); });
  after(async () => { await env.close(); });

  it('GET /health is public, succeeds, reports only the service name and version, and exposes no environment, path or database detail', async () => {
    const r = await env.call('GET', '/health');
    assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['service', 'serviceVersion', 'status']); assert.equal(r.json.status, 'ok'); assert.equal(r.json.serviceVersion, '1.6.0');
    assert.ok(!/postgres|DATABASE|JWT|secret|\/home|\/app|node_modules|NODE_ENV|schema/i.test(r.text), r.text);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const v1 = await env.call('GET', '/v1/health'); assert.equal(v1.status, 200); assert.equal(v1.json.serviceVersion, '1.6.0');
  });

  it('CORS: the production site and a listed preview origin are allowed; anything else gets no CORS headers; credentials are never allowed', async () => {
    for (const o of [SITE, 'https://deploy-preview-7--petali.netlify.app']) {
      const r = await env.call('GET', '/v1/health', { headers: { Origin: o } });
      assert.equal(r.headers.get('access-control-allow-origin'), o); assert.equal(r.headers.get('access-control-allow-credentials'), null); assert.match(r.headers.get('vary') ?? '', /Origin/);
    }
    for (const o of ['https://evil.example', 'https://petali.netlify.app.evil.example', 'http://petali.netlify.app', 'null', 'https://other--petali.netlify.app']) {
      const r = await env.call('GET', '/v1/health', { headers: { Origin: o } });
      assert.equal(r.headers.get('access-control-allow-origin'), null, o);
    }
    const none = await env.call('GET', '/v1/health'); assert.equal(none.headers.get('access-control-allow-origin'), null);
  });

  it('CORS preflight: answered for allowed origins (methods and headers listed, no credentials), refused with 403 for others', async () => {
    const ok = await env.call('OPTIONS', '/v1/auth/login', { headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-origin'), SITE); assert.match(ok.headers.get('access-control-allow-methods') ?? '', /POST/); assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    const no = await env.call('OPTIONS', '/v1/auth/login', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(no.status, 403); assert.equal(no.headers.get('access-control-allow-origin'), null); assert.ok(!no.text.includes('petali.netlify.app'), 'the allow-list is not revealed');
  });

  it('errors are safe for users: no stack trace, no SQL, no internal path; malformed input gets a clean 4xx', async () => {
    for (const [m, p, body] of [['POST', '/v1/auth/login', '{bad json'], ['GET', '/v1/nope', undefined], ['POST', '/v1/auth/register', '{"email":1}']] as const) {
      const r = await env.call(m, p, body !== undefined ? { raw: body, headers: { 'content-type': 'application/json' } } : {});
      assert.ok(r.status >= 400 && r.status < 500, `${p} ${r.status}`); assert.ok(r.json && r.json.error && typeof r.json.error.code === 'string');
      assert.ok(!/stack|at \w+ \(|node_modules|\/home\/|SELECT |syntax error/i.test(r.text), r.text);
    }
  });

  it('the public endpoints are rate limited (429 with the standard error, Retry-After)', async () => {
    let limited: Awaited<ReturnType<TestEnv['call']>> | null = null;
    for (let i = 0; i < 40 && !limited; i += 1) { const r = await env.call('GET', '/health'); if (r.status === 429) limited = r; }
    assert.ok(limited, 'a burst of /health requests is limited'); assert.equal(limited!.json.error.code, 'rate_limited');
  });

  it('logs never contain the text a person typed, passwords, tokens or e-mail addresses', async () => {
    const e2 = await createTestEnv();
    try {
      const email = `log-${randomBytes(4).toString('hex')}@example.com`;
      const bad = await e2.call('POST', '/v1/auth/register', { body: { email, password: 'correct-horse-77', displayName: 'k0kot Secret-Name' } });
      assert.equal(bad.status, 422);
      const ok = await e2.call('POST', '/v1/auth/register', { body: { email, password: 'correct-horse-77', displayName: 'Plain Name' } });
      assert.equal(ok.status, 201);
      const all = e2.logLines.join('');
      for (const s of ['k0kot', 'Secret-Name', 'correct-horse-77', ok.json.tokens.accessToken, ok.json.tokens.refreshToken, 'Plain Name']) assert.ok(!all.includes(s), `log must not contain ${s.slice(0, 8)}…`);
    } finally { await e2.close(); }
  });
});
