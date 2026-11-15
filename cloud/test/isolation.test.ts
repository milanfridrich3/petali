import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';

// Account isolation: what one signed-in user can reach is decided ONLY by the verified token, never by
// identifiers the client sends.
describe('account isolation', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('each account sees only its own profile, settings, sessions and security events', async () => {
    const a = await env.register('iso-a@example.com'); const b = await env.register('iso-b@example.com');
    await env.call('PATCH', '/v1/account/profile', { token: a.tokens.accessToken, body: { displayName: 'Alice' } });
    await env.call('PATCH', '/v1/account/settings', { token: a.tokens.accessToken, body: { language: 'cs' } });
    const pb = await env.call('GET', '/v1/account', { token: b.tokens.accessToken });
    assert.equal(pb.json.user.email, 'iso-b@example.com'); assert.equal(pb.json.user.displayName, null);
    assert.equal((await env.call('GET', '/v1/account/settings', { token: b.tokens.accessToken })).json.settings.language, null);
    const sb = await env.call('GET', '/v1/account/sessions', { token: b.tokens.accessToken });
    assert.deepEqual(sb.json.sessions.map((s: any) => s.id), [b.tokens.sessionId]);
    const eb = await env.call('GET', '/v1/account/security-events', { token: b.tokens.accessToken });
    assert.ok(!JSON.stringify(eb.json).includes('settings_changed'));
  });
  it('cannot end another account\'s session: it behaves as if it does not exist', async () => {
    const a = await env.register(); const b = await env.register();
    const r = await env.call('DELETE', `/v1/account/sessions/${a.tokens.sessionId}`, { token: b.tokens.accessToken });
    assert.equal(r.status, 404); assert.equal(r.json.error.code, 'session_not_found');
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 200, 'A is untouched');
  });
  it('ignores identifiers in bodies, paths and queries: the account is always the token\'s', async () => {
    const a = await env.register(); const b = await env.register();
    const bId = (await env.pool.query('SELECT id FROM users WHERE email_normalized = $1', [b.email])).rows[0].id;
    for (const body of [{ userId: bId, displayName: 'Hacked' }, { petaliId: b.user.petaliId, displayName: 'Hacked' }]) {
      assert.equal((await env.call('PATCH', '/v1/account/profile', { token: a.tokens.accessToken, body })).status, 400);
    }
    assert.equal((await env.call('GET', `/v1/account?userId=${bId}&petaliId=${b.user.petaliId}`, { token: a.tokens.accessToken })).json.user.petaliId, a.user.petaliId);
    assert.equal((await env.call('GET', `/v1/account/${bId}`, { token: a.tokens.accessToken })).status, 404);
    assert.equal((await env.call('GET', `/v1/account/${b.user.petaliId}/settings`, { token: a.tokens.accessToken })).status, 404);
    assert.equal((await env.call('GET', '/v1/account', { token: b.tokens.accessToken })).json.user.displayName, null);
  });
  it('cannot change another account\'s email or password by any route', async () => {
    const a = await env.register(); const b = await env.register(undefined, 'a completely different passphrase');
    assert.equal((await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: b.email, currentPassword: a.password } })).status, 409);
    assert.equal((await env.call('PUT', '/v1/account/password', { token: a.tokens.accessToken, body: { currentPassword: b.password, newPassword: 'attacker chosen passphrase' } })).status, 403, 'B\'s password is not A\'s');
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: b.email, password: b.password } })).status, 200);
  });
  it('a refresh token only ever works for its own session', async () => {
    const a = await env.register(); const b = await env.register();
    const r = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    assert.equal(r.json.user.petaliId, a.user.petaliId); assert.notEqual(r.json.user.petaliId, b.user.petaliId);
  });
  it('every authenticated query is scoped by user_id (no cross-account rows reachable)', async () => {
    const a = await env.register(); const b = await env.register();
    await env.call('PATCH', '/v1/account/settings', { token: a.tokens.accessToken, body: { securityAlerts: false } });
    await env.call('PATCH', '/v1/account/settings', { token: b.tokens.accessToken, body: { language: 'en' } });
    assert.deepEqual((await env.call('GET', '/v1/account/settings', { token: a.tokens.accessToken })).json.settings, { language: null, securityAlerts: false });
    assert.deepEqual((await env.call('GET', '/v1/account/settings', { token: b.tokens.accessToken })).json.settings, { language: 'en', securityAlerts: true });
  });
  it('revoke-all-others never touches another account', async () => {
    const a = await env.register(); const b = await env.register();
    await env.call('DELETE', '/v1/account/sessions', { token: a.tokens.accessToken });
    assert.equal((await env.call('GET', '/v1/account', { token: b.tokens.accessToken })).status, 200);
  });
});
