import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { runMaintenance } from '../src/db/maintenance';
import { createTestEnv, STRONG, type TestEnv } from './helpers';

describe('HTTP behaviour, error handling and headers', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('health and readiness', async () => {
    assert.deepEqual((await env.call('GET', '/healthz')).json, { status: 'ok' });
    const h = await env.call('GET', '/v1/health');
    assert.equal(h.json.status, 'ok'); assert.equal(h.json.apiVersion, '1'); assert.equal(h.headers.get('x-petali-api-version'), '1');
    const r = await env.call('GET', '/v1/ready');
    assert.equal(r.json.status, 'ready'); assert.equal(r.json.schemaVersion, 4);
  });
  it('API responses are versioned under /v1 and are never cached', async () => {
    assert.equal((await env.call('GET', '/account')).status, 404, 'unversioned paths do not exist');
    assert.equal((await env.call('GET', '/v2/health')).status, 404);
    const r = await env.call('GET', '/v1/health');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
  it('unknown routes answer with the standard JSON error, not an HTML page', async () => {
    const r = await env.call('GET', '/v1/nope');
    assert.equal(r.status, 404); assert.equal(r.json.error.code, 'route_not_found'); assert.ok(r.json.error.requestId);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
  });
  it('malformed JSON is a 400 and an oversized body a 413', async () => {
    const bad = await env.call('POST', '/v1/auth/login', { raw: '{"email": "a@b.co", ', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'invalid_json');
    const big = await env.call('POST', '/v1/auth/login', { raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(40_000) }), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413); assert.equal(big.json.error.code, 'payload_too_large');
  });
  it('a body that is not declared as JSON is not parsed', async () => {
    const r = await env.call('POST', '/v1/auth/login', { raw: JSON.stringify({ email: 'a@b.co', password: 'x' }), headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 400); assert.equal(r.json.error.code, 'validation_failed');
  });
  it('sends security headers and does not advertise the framework', async () => {
    const r = await env.call('GET', '/v1/health');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('strict-transport-security'));
    assert.ok(r.headers.get('content-security-policy'));
  });
  it('sends no CORS headers: web pages on other sites cannot read the API', async () => {
    const r = await env.call('GET', '/v1/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
  it('echoes a sane X-Request-Id and replaces a hostile one', async () => {
    const ok = await env.call('GET', '/v1/health', { headers: { 'x-request-id': 'abc-12345678' } });
    assert.equal(ok.headers.get('x-request-id'), 'abc-12345678');
    const bad = await env.call('GET', '/v1/health', { headers: { 'x-request-id': 'x\ty<script>' } });
    assert.match(bad.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });
  it('an unexpected failure gives a generic 500 with no internals, and is logged with details', async () => {
    const a = await env.register();
    const original = env.pool.query.bind(env.pool);
    (env.pool as any).query = (text: any, ...rest: any[]) => (typeof text === 'string' && text.includes('FROM users WHERE id') ? Promise.reject(new Error('boom: secret-internal-detail /var/db')) : (original as any)(text, ...rest));
    try {
      const r = await env.call('GET', '/v1/account', { token: a.tokens.accessToken });
      assert.equal(r.status, 500); assert.equal(r.json.error.code, 'internal_error');
      assert.ok(!r.text.includes('secret-internal-detail') && !r.text.includes('/var/db') && !r.text.includes('stack'));
      assert.ok(env.logLines.some((l) => l.includes('secret-internal-detail')), 'the server log has it');
    } finally { (env.pool as any).query = original; }
  });
});

describe('logging never contains credentials', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('passwords, access tokens and refresh tokens never reach the log', async () => {
    const pw = 'Log-Canary-Passphrase-7781'; const pw2 = 'Log-Canary-New-Passphrase-4412';
    const a = await env.register('logcheck@example.com', pw);
    const l = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: pw } });
    await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: 'Log-Canary-Wrong-9901' } });
    const rf = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: l.json.tokens.refreshToken } });
    await env.call('PUT', '/v1/account/password', { token: rf.json.tokens.accessToken, body: { currentPassword: pw, newPassword: pw2 } });
    await env.call('POST', '/v1/auth/logout', { token: rf.json.tokens.accessToken, body: { refreshToken: rf.json.tokens.refreshToken } });
    await env.call('GET', '/v1/account', { token: 'bogus.token.value-that-is-long-enough' });
    const log = env.logLines.join('');
    assert.ok(log.length > 200, 'something was logged');
    for (const secret of [pw, pw2, 'Log-Canary-Wrong-9901', a.tokens.accessToken, a.tokens.refreshToken, l.json.tokens.accessToken, l.json.tokens.refreshToken, rf.json.tokens.accessToken, rf.json.tokens.refreshToken, 'bogus.token.value']) {
      assert.ok(!log.includes(secret), `leaked: ${secret.slice(0, 18)}`);
    }
    assert.ok(!/authorization/i.test(log) && !/"password"/.test(log), 'no header or body dump');
  });
  it('request log lines are structured JSON with route pattern, status and request id', async () => {
    await env.call('GET', '/v1/health');
    const last = JSON.parse(env.logLines.filter((l) => l.includes('"route"')).pop() as string);
    assert.equal(last.method, 'GET'); assert.equal(last.route, '/v1/health'); assert.equal(last.status, 200); assert.ok(last.requestId && typeof last.ms === 'number');
  });
  it('query strings are not logged', async () => {
    await env.call('GET', '/v1/health?token=querysecret123');
    assert.ok(!env.logLines.join('').includes('querysecret123'));
  });
});

describe('rate limiting', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ RATE_LIMIT_LOGIN_MAX: '3', RATE_LIMIT_REGISTER_MAX: '2', RATE_LIMIT_SENSITIVE_MAX: '2', RATE_LIMIT_GENERAL_MAX: '40' }); });
  after(async () => { await env.close(); });

  it('limits login attempts per client and answers in the standard error format', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await env.call('POST', '/v1/auth/login', { body: { email: 'rl@example.com', password: 'wrong wrong wrong' } })).status);
    assert.deepEqual(codes.slice(0, 3), [401, 401, 401]);
    assert.deepEqual(codes.slice(3), [429, 429]);
    const r = await env.call('POST', '/v1/auth/login', { body: { email: 'rl@example.com', password: 'x' } });
    assert.equal(r.json.error.code, 'rate_limited'); assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
  it('limits registrations per client', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) codes.push((await env.call('POST', '/v1/auth/register', { body: { email: `rl${i}@example.com`, password: STRONG } })).status);
    assert.deepEqual(codes, [201, 201, 429, 429]);
  });
  it('limits password, email and deletion attempts on an account', async () => {
    const e2 = await createTestEnv({ RATE_LIMIT_SENSITIVE_MAX: '2' });
    try {
      const a = await e2.register();
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) codes.push((await e2.call('PUT', '/v1/account/password', { token: a.tokens.accessToken, body: { currentPassword: 'wrong wrong wrong', newPassword: 'whatever new passphrase' } })).status);
      assert.deepEqual(codes, [403, 403, 429, 429]);
    } finally { await e2.close(); }
  });
  it('has a general limit across the API', async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 60; i += 1) codes.add((await env.call('GET', '/v1/health')).status);
    assert.ok(codes.has(429));
  });
});

describe('maintenance', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });
  it('removes old events, long-dead sessions and stale throttles, and nothing else', async () => {
    const a = await env.register();
    const uid = (await env.pool.query('SELECT id FROM users WHERE email_normalized = $1', [a.email])).rows[0].id;
    await env.pool.query(`INSERT INTO security_events (user_id, type, created_at) VALUES ($1, 'login', now() - interval '91 days'), ($1, 'login', now() - interval '1 day')`, [uid]);
    await env.pool.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at, max_expires_at, revoked_at, revoked_reason) VALUES ($1, 'old1', now() - interval '60 days', now() - interval '60 days', now() - interval '45 days', 'logout')`, [uid]);
    await env.pool.query(`INSERT INTO login_throttle (key_hash, failures, updated_at) VALUES ('stale', 2, now() - interval '3 days'), ('fresh', 2, now())`);
    const r = await runMaintenance(env.pool);
    assert.equal(r.events, 1); assert.equal(r.sessions, 1); assert.equal(r.throttles, 1);
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 200, 'active session untouched');
    assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM login_throttle WHERE key_hash = 'fresh'`)).rows[0].n, 1);
  });
});
