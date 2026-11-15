import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, STRONG, type TestEnv } from './helpers';

describe('profile', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('shows the Petali ID, email, creation date and the other account information', async () => {
    const a = await env.register('profile@example.com');
    const r = await env.call('GET', '/v1/account', { token: a.tokens.accessToken });
    assert.equal(r.status, 200);
    const u = r.json.user;
    assert.equal(u.petaliId, a.user.petaliId); assert.equal(u.email, 'profile@example.com'); assert.equal(u.createdAt, a.user.createdAt);
    assert.equal(u.emailVerified, false); assert.equal(u.displayName, null); assert.equal(u.deletionRequestedAt, null);
    assert.ok(u.updatedAt && u.passwordChangedAt);
  });
  it('edits and clears the display name', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    const set = await env.call('PATCH', '/v1/account/profile', { token: t, body: { displayName: '  Milan  ' } });
    assert.equal(set.status, 200); assert.equal(set.json.user.displayName, 'Milan');
    assert.equal((await env.call('GET', '/v1/account', { token: t })).json.user.displayName, 'Milan');
    const clear = await env.call('PATCH', '/v1/account/profile', { token: t, body: { displayName: null } });
    assert.equal(clear.json.user.displayName, null);
    assert.equal((await env.call('PATCH', '/v1/account/profile', { token: t, body: {} })).status, 200, 'an empty patch changes nothing');
  });
  it('validates the display name and refuses fields that are not editable', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    for (const body of [{ displayName: '' }, { displayName: '   ' }, { displayName: 'x'.repeat(51) }, { displayName: 'bad\u0000name' }, { displayName: 5 },
      { petaliId: 'PTL-AAAA-AAAA-AAAA' }, { email: 'x@y.co' }, { emailVerified: true }, { createdAt: '2000-01-01T00:00:00Z' }]) {
      assert.equal((await env.call('PATCH', '/v1/account/profile', { token: t, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await env.call('GET', '/v1/account', { token: t })).json.user.petaliId, a.user.petaliId);
  });
  it('keeps markup in a display name as plain text (clients render it as text)', async () => {
    const a = await env.register();
    const r = await env.call('PATCH', '/v1/account/profile', { token: a.tokens.accessToken, body: { displayName: '<img src=x onerror=alert(1)>' } });
    assert.equal(r.json.user.displayName, '<img src=x onerror=alert(1)>');
  });
});

describe('email management', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ LOGIN_LOCK_THRESHOLD: '3' }); });
  after(async () => { await env.close(); });

  it('changes the email with the current password; login then uses the new address', async () => {
    const a = await env.register('old-address@example.com');
    const r = await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: 'New-Address@Example.com', currentPassword: a.password } });
    assert.equal(r.status, 200); assert.equal(r.json.user.email, 'New-Address@Example.com'); assert.equal(r.json.user.emailVerified, false);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: 'old-address@example.com', password: a.password } })).status, 401);
    const l = await env.call('POST', '/v1/auth/login', { body: { email: 'new-address@example.com', password: a.password } });
    assert.equal(l.status, 200); assert.equal(l.json.user.petaliId, a.user.petaliId);
  });
  it('needs the right password', async () => {
    const a = await env.register();
    const r = await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: 'x-wrongpw@example.com', currentPassword: 'wrong password here' } });
    assert.equal(r.status, 403); assert.equal(r.json.error.code, 'invalid_password');
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).json.user.email, a.email);
  });
  it('refuses an address that another account uses, or that is already yours', async () => {
    const a = await env.register(); const b = await env.register('taken-by-b@example.com');
    const taken = await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: 'TAKEN-BY-B@example.com', currentPassword: a.password } });
    assert.equal(taken.status, 409); assert.equal(taken.json.error.code, 'email_taken');
    const same = await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: a.email.toUpperCase(), currentPassword: a.password } });
    assert.equal(same.status, 400); assert.equal(same.json.error.code, 'email_unchanged');
    assert.ok(b);
  });
  it('validates the new address', async () => {
    const a = await env.register();
    for (const e of ['not-an-email', '', 'a@b']) assert.equal((await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: e, currentPassword: a.password } })).status, 400);
  });
  it('signs the other sessions out but keeps the current one', async () => {
    const a = await env.register();
    const other = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: `moved-${Date.now()}@example.com`, currentPassword: a.password } });
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 200);
    assert.equal((await env.call('GET', '/v1/account', { token: other.json.tokens.accessToken })).status, 401);
  });
  it('repeated wrong passwords are throttled (a stolen access token cannot be used to guess the password)', async () => {
    const a = await env.register();
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) codes.push((await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: 'guess@example.com', currentPassword: `guess number ${i} xx` } })).status);
    assert.deepEqual(codes, [403, 403, 403, 429]);
    const right = await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: 'guess@example.com', currentPassword: a.password } });
    assert.equal(right.status, 429, 'still paused even with the right password');
  });
});

describe('password management', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('changes the password: the old one stops working, the new one works', async () => {
    const a = await env.register();
    const r = await env.call('PUT', '/v1/account/password', { token: a.tokens.accessToken, body: { currentPassword: a.password, newPassword: 'a fresh new passphrase' } });
    assert.equal(r.status, 200);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 401);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: 'a fresh new passphrase' } })).status, 200);
  });
  it('ends all other sessions, keeps the current one', async () => {
    const a = await env.register();
    const s2 = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    const s3 = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    const r = await env.call('PUT', '/v1/account/password', { token: a.tokens.accessToken, body: { currentPassword: a.password, newPassword: 'yet another passphrase' } });
    assert.equal(r.json.otherSessionsSignedOut, 2);
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 200);
    assert.equal((await env.call('GET', '/v1/account', { token: s2.json.tokens.accessToken })).status, 401);
    assert.equal((await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: s3.json.tokens.refreshToken } })).status, 401);
  });
  it('checks the current password and applies the password policy to the new one', async () => {
    const a = await env.register();
    const t = a.tokens.accessToken;
    assert.equal((await env.call('PUT', '/v1/account/password', { token: t, body: { currentPassword: 'wrong wrong wrong', newPassword: 'some new passphrase' } })).status, 403);
    for (const pw of ['short', 'password123', a.password]) assert.equal((await env.call('PUT', '/v1/account/password', { token: t, body: { currentPassword: a.password, newPassword: pw } })).status, 400, pw);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200, 'unchanged after failures');
  });
  it('updates password_changed_at', async () => {
    const a = await env.register();
    const before = (await env.pool.query('SELECT password_changed_at FROM users WHERE email_normalized = $1', [a.email])).rows[0].password_changed_at;
    await new Promise((r) => setTimeout(r, 20));
    await env.call('PUT', '/v1/account/password', { token: a.tokens.accessToken, body: { currentPassword: a.password, newPassword: 'changed passphrase 1' } });
    const after = (await env.pool.query('SELECT password_changed_at FROM users WHERE email_normalized = $1', [a.email])).rows[0].password_changed_at;
    assert.ok(after > before);
  });
});

describe('cloud account settings', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('has defaults, merges partial updates and persists', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    assert.deepEqual((await env.call('GET', '/v1/account/settings', { token: t })).json.settings, { language: null, securityAlerts: true });
    const r1 = await env.call('PATCH', '/v1/account/settings', { token: t, body: { language: 'cs' } });
    assert.deepEqual(r1.json.settings, { language: 'cs', securityAlerts: true });
    const r2 = await env.call('PATCH', '/v1/account/settings', { token: t, body: { securityAlerts: false } });
    assert.deepEqual(r2.json.settings, { language: 'cs', securityAlerts: false });
    const r3 = await env.call('PATCH', '/v1/account/settings', { token: t, body: { language: null } });
    assert.deepEqual(r3.json.settings, { language: null, securityAlerts: false });
    assert.deepEqual((await env.call('GET', '/v1/account/settings', { token: t })).json.settings, { language: null, securityAlerts: false });
    assert.equal(r3.json.schemaVersion, 1);
  });
  it('rejects unknown keys and bad values', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    for (const body of [{ language: 'fr' }, { language: 5 }, { securityAlerts: 'yes' }, { theme: 'dark' }, { __proto__: { x: 1 }, isAdmin: true }, { dashboardLayout: {} }]) {
      assert.equal((await env.call('PATCH', '/v1/account/settings', { token: t, body })).status, 400, JSON.stringify(body));
    }
  });
  it('stays valid even if the stored JSON holds junk (read path normalizes)', async () => {
    const a = await env.register();
    await env.pool.query(`UPDATE account_settings SET settings = '{"language":"xx","securityAlerts":"maybe","zzz":1}'::jsonb WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`, [a.email]);
    assert.deepEqual((await env.call('GET', '/v1/account/settings', { token: a.tokens.accessToken })).json.settings, { language: null, securityAlerts: true });
  });
});

describe('session management', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('lists the account\'s active sessions and marks the current one', async () => {
    const a = await env.register(undefined, STRONG, { deviceLabel: 'Petali 1.5.0 on Windows (PC-1)' });
    const second = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password, deviceLabel: 'Laptop' } });
    const r = await env.call('GET', '/v1/account/sessions', { token: a.tokens.accessToken });
    assert.equal(r.json.sessions.length, 2);
    const cur = r.json.sessions.filter((s: any) => s.current);
    assert.equal(cur.length, 1); assert.equal(cur[0].id, a.tokens.sessionId); assert.equal(cur[0].deviceLabel, 'Petali 1.5.0 on Windows (PC-1)');
    assert.ok(r.json.sessions.some((s: any) => s.id === second.json.tokens.sessionId && s.deviceLabel === 'Laptop'));
    assert.ok(!JSON.stringify(r.json).includes('refresh'), 'no token material in the list');
  });
  it('does not list ended sessions', async () => {
    const a = await env.register();
    const s2 = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    await env.call('POST', '/v1/auth/logout', { token: s2.json.tokens.accessToken, body: {} });
    assert.equal((await env.call('GET', '/v1/account/sessions', { token: a.tokens.accessToken })).json.sessions.length, 1);
  });
  it('revokes one other session, which then stops working', async () => {
    const a = await env.register();
    const s2 = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    const r = await env.call('DELETE', `/v1/account/sessions/${s2.json.tokens.sessionId}`, { token: a.tokens.accessToken });
    assert.equal(r.status, 200); assert.equal(r.json.signedOutCurrent, false);
    assert.equal((await env.call('GET', '/v1/account', { token: s2.json.tokens.accessToken })).status, 401);
    assert.equal((await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: s2.json.tokens.refreshToken } })).status, 401);
    assert.equal((await env.call('DELETE', `/v1/account/sessions/${s2.json.tokens.sessionId}`, { token: a.tokens.accessToken })).status, 404, 'already ended');
  });
  it('can end its own session, and says so', async () => {
    const a = await env.register();
    const r = await env.call('DELETE', `/v1/account/sessions/${a.tokens.sessionId}`, { token: a.tokens.accessToken });
    assert.equal(r.json.signedOutCurrent, true);
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 401);
  });
  it('revokes all other sessions at once', async () => {
    const a = await env.register();
    const others = await Promise.all([1, 2, 3].map(() => env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })));
    const r = await env.call('DELETE', '/v1/account/sessions', { token: a.tokens.accessToken });
    assert.equal(r.json.revoked, 3);
    for (const o of others) assert.equal((await env.call('GET', '/v1/account', { token: o.json.tokens.accessToken })).status, 401);
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 200);
  });
  it('rejects a malformed session id', async () => {
    const a = await env.register();
    assert.equal((await env.call('DELETE', '/v1/account/sessions/not-a-uuid', { token: a.tokens.accessToken })).status, 400);
    assert.equal((await env.call('DELETE', '/v1/account/sessions/..%2F..%2Fx', { token: a.tokens.accessToken })).status, 400);
  });
});

describe('account deletion preparation and security activity', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('records a deletion request (password required), shows it, and can cancel it; nothing is erased', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    assert.equal((await env.call('POST', '/v1/account/deletion-request', { token: t, body: { password: 'wrong wrong wrong' } })).status, 403);
    const r = await env.call('POST', '/v1/account/deletion-request', { token: t, body: { password: a.password } });
    assert.equal(r.status, 200); assert.ok(r.json.user.deletionRequestedAt);
    const first = r.json.user.deletionRequestedAt;
    const again = await env.call('POST', '/v1/account/deletion-request', { token: t, body: { password: a.password } });
    assert.equal(again.json.user.deletionRequestedAt, first, 'asking twice does not restart anything');
    assert.equal((await env.call('GET', '/v1/account', { token: t })).json.user.deletionRequestedAt, first);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200, 'the account still works');
    const c = await env.call('DELETE', '/v1/account/deletion-request', { token: t });
    assert.equal(c.json.user.deletionRequestedAt, null);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM users WHERE email_normalized = $1', [a.email])).rows[0].n, 1);
  });
  it('lists recent security activity, newest first, capped by limit', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    await env.call('PATCH', '/v1/account/settings', { token: t, body: { language: 'en' } });
    await env.call('PUT', '/v1/account/password', { token: t, body: { currentPassword: a.password, newPassword: 'activity passphrase 1' } });
    const r = await env.call('GET', '/v1/account/security-events?limit=2', { token: t });
    assert.equal(r.json.events.length, 2);
    assert.equal(r.json.events[0].type, 'password_changed'); assert.equal(r.json.events[1].type, 'settings_changed');
    assert.equal((await env.call('GET', '/v1/account/security-events?limit=banana', { token: t })).status, 200);
    assert.ok((await env.call('GET', '/v1/account/security-events?limit=9999', { token: t })).json.events.length <= 50);
  });
});
