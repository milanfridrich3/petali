import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTestEnv, STRONG, type TestEnv } from './helpers';

// Release 1.5.0 has no email service (Resend is not connected). These tests pin the intended product behaviour on REAL PostgreSQL with the
// production-default configuration (no email provider, no verification enforcement): accounts are fully usable, stay explicitly unverified
// in the backend, show the same status on every login/session, and the API never pretends an email was sent.
const WEB = { origin: 'https://petali.netlify.app', 'x-petali-web': '1' };

describe('release without an email service', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('desktop registration succeeds, is unverified, and says no email was sent', async () => {
    const r = await env.call('POST', '/v1/auth/register', { body: { email: 'rel-d@example.com', password: STRONG } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.user.emailVerified, false);
    assert.equal(r.json.emailVerification.sent, false);
    assert.equal(r.json.emailVerification.required, false);
    assert.equal(r.json.emailVerification.reason, 'not_configured');
    const row = await env.pool.query('SELECT email_verified_at FROM users WHERE email = $1', ['rel-d@example.com']);
    assert.equal(row.rows[0].email_verified_at, null, 'the backend keeps the account unverified');
  });

  it('web registration behaves the same', async () => {
    const r = await env.call('POST', '/v1/web/session/register', { headers: WEB, body: { email: 'rel-w@example.com', password: STRONG } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.user.emailVerified, false);
    assert.equal(r.json.emailVerification.sent, false);
  });

  it('an unverified account can use devices, sync, web data and account settings (nothing is blocked)', async () => {
    const a = await env.register('rel-use@example.com');
    const t = a.tokens.accessToken;
    for (const path of ['/v1/account', '/v1/devices', '/v1/web/overview', '/v1/web/plant']) {
      const r = await env.call('GET', path, { token: t });
      assert.equal(r.status, 200, `${path}: ${r.text}`);
    }
    const d = await env.call('POST', '/v1/sync/devices/register', { token: t, body: { clientDeviceId: randomUUID(), name: 'PC', platform: 'win32' } });
    assert.equal(d.status, 200, d.text);
  });

  it('the status stays "not verified" across logins, refresh and a second device', async () => {
    const a = await env.register('rel-same@example.com');
    const l1 = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    const l2 = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    assert.equal(l1.status, 200); assert.equal(l2.status, 200);
    assert.equal(l1.json.user.emailVerified, false); assert.equal(l2.json.user.emailVerified, false);
    const ref = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: l2.json.tokens.refreshToken } });
    assert.equal(ref.status, 200, ref.text);
    for (const tk of [l1.json.tokens.accessToken, ref.json.tokens.accessToken]) {
      assert.equal((await env.call('GET', '/v1/account', { token: tk })).json.user.emailVerified, false);
    }
  });

  it('asking for a new confirmation link is refused honestly (503), never a fake success', async () => {
    const a = await env.register('rel-resend@example.com');
    const r = await env.call('POST', '/v1/auth/resend-verification', { token: a.tokens.accessToken });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.error.code, 'email_not_configured');
  });

  it('a made-up confirmation token does not verify anything', async () => {
    const a = await env.register('rel-bogus@example.com');
    const r = await env.call('POST', '/v1/auth/verify-email', { body: { token: 'x'.repeat(43) } });
    assert.ok(r.status >= 400 && r.status < 500, r.text);
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).json.user.emailVerified, false);
  });
});
