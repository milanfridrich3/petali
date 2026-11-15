import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, STRONG, type TestEnv } from './helpers';

describe('registration', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('creates an account and signs it in', async () => {
    const r = await env.call('POST', '/v1/auth/register', { body: { email: 'New.User@Example.com', password: STRONG, displayName: 'Nova' } });
    assert.equal(r.status, 201);
    assert.match(r.json.user.petaliId, /^PTL-/);
    assert.equal(r.json.user.email, 'New.User@Example.com');
    assert.equal(r.json.user.displayName, 'Nova');
    assert.equal(r.json.user.emailVerified, false);
    assert.ok(!Number.isNaN(Date.parse(r.json.user.createdAt)));
    assert.equal(r.json.tokens.tokenType, 'Bearer');
    assert.ok(r.json.tokens.accessToken && r.json.tokens.refreshToken.startsWith('ptr_'));
    assert.ok(!('id' in r.json.user) && !('password' in r.json.user) && !('passwordHash' in r.json.user), 'no internal fields in the response');
    assert.equal((await env.call('GET', '/v1/account', { token: r.json.tokens.accessToken })).status, 200);
  });
  it('stores only an argon2id hash, never the password', async () => {
    const a = await env.register('hash-check@example.com', 'my very own passphrase');
    const row = (await env.pool.query('SELECT password_hash FROM users WHERE email_normalized = $1', [a.email])).rows[0];
    assert.match(row.password_hash, /^\$argon2id\$v=19\$m=2048,t=1,p=1\$/);
    assert.ok(!row.password_hash.includes('my very own passphrase'));
    const dump = JSON.stringify((await env.pool.query('SELECT * FROM users')).rows) + JSON.stringify((await env.pool.query('SELECT * FROM sessions')).rows);
    assert.ok(!dump.includes('my very own passphrase'));
    assert.ok(!dump.includes(a.tokens.refreshToken), 'the refresh token is stored only as a hash');
  });
  it('hashes the same password differently for different accounts (salted)', async () => {
    await env.register('salt1@example.com', 'identical passphrase one');
    await env.register('salt2@example.com', 'identical passphrase one');
    const rows = (await env.pool.query(`SELECT password_hash FROM users WHERE email_normalized IN ('salt1@example.com','salt2@example.com')`)).rows;
    assert.notEqual(rows[0].password_hash, rows[1].password_hash);
  });
  it('sets creation timestamps', async () => {
    const a = await env.register();
    const row = (await env.pool.query('SELECT created_at, updated_at, password_changed_at FROM users WHERE email_normalized = $1', [a.email])).rows[0];
    assert.ok(Math.abs(row.created_at.getTime() - Date.now()) < 60_000);
    assert.ok(row.updated_at && row.password_changed_at);
  });
  it('creates the default account settings row together with the account', async () => {
    const a = await env.register();
    const s = await env.call('GET', '/v1/account/settings', { token: a.tokens.accessToken });
    assert.deepEqual(s.json.settings, { language: null, securityAlerts: true });
  });
  it('rejects a duplicate email, whatever the case or spacing', async () => {
    await env.register('dupe@example.com');
    for (const e of ['dupe@example.com', 'DUPE@EXAMPLE.COM', '  Dupe@Example.com  ']) {
      const r = await env.call('POST', '/v1/auth/register', { body: { email: e, password: STRONG } });
      assert.equal(r.status, 409, e); assert.equal(r.json.error.code, 'email_taken');
    }
  });
  it('simultaneous registrations of one email produce exactly one account', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => env.call('POST', '/v1/auth/register', { body: { email: 'race@example.com', password: STRONG } })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 5);
    assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM users WHERE email_normalized = 'race@example.com'`)).rows[0].n, 1);
  });
  it('validates the email address', async () => {
    for (const e of ['', 'plain', 'a@', '@b.com', 'a b@c.com', 'a@b', 'x'.repeat(250) + '@e.com', 'a@@b.com']) {
      const r = await env.call('POST', '/v1/auth/register', { body: { email: e, password: STRONG } });
      assert.equal(r.status, 400, `"${e.slice(0, 20)}"`); assert.equal(r.json.error.code, 'validation_failed');
    }
  });
  it('validates the password (length, common, repetitive, equal to email)', async () => {
    const cases: Array<[string, string]> = [['short', 'weak_password'], ['password123', 'weak_password'], ['aaaaaaaaaaaa', 'weak_password'], ['          ', 'weak_password'], ['pw-is-email@example.com', 'weak_password']];
    for (const [pw, code] of cases) {
      const r = await env.call('POST', '/v1/auth/register', { body: { email: 'pw-is-email@example.com', password: pw } });
      assert.equal(r.status, 400, pw); assert.equal(r.json.error.code, code);
    }
    const tooLong = await env.call('POST', '/v1/auth/register', { body: { email: 'long@example.com', password: 'x1'.repeat(70) } });
    assert.equal(tooLong.status, 400);
    const ok = await env.call('POST', '/v1/auth/register', { body: { email: 'unicode@example.com', password: 'pässwörd 🌱 with spaces' } });
    assert.equal(ok.status, 201, 'spaces and non-ASCII are allowed');
  });
  it('rejects missing fields, wrong types and unknown fields (no mass assignment)', async () => {
    for (const body of [{}, { email: 'a@b.co' }, { password: STRONG }, { email: 5, password: STRONG }, { email: 'a@b.co', password: ['x'] }, [], 'str', null]) {
      const r = await env.call('POST', '/v1/auth/register', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const extra = await env.call('POST', '/v1/auth/register', { body: { email: 'extra@example.com', password: STRONG, petaliId: 'PTL-AAAA-AAAA-AAAA', emailVerified: true, id: 'x' } });
    assert.equal(extra.status, 400);
    assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM users WHERE email_normalized = 'extra@example.com'`)).rows[0].n, 0);
  });
  it('validation errors never echo the submitted password', async () => {
    const r = await env.call('POST', '/v1/auth/register', { body: { email: 'bad', password: 'SuperSecretValue-123' } });
    assert.ok(!r.text.includes('SuperSecretValue-123'));
  });
});

describe('login', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ LOGIN_LOCK_THRESHOLD: '4' }); });
  after(async () => { await env.close(); });

  it('signs in with the right credentials (email is case-insensitive) and returns the same Petali ID', async () => {
    const a = await env.register('Login.Case@example.com');
    const r = await env.call('POST', '/v1/auth/login', { body: { email: 'login.case@EXAMPLE.com', password: a.password } });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.petaliId, a.user.petaliId);
    assert.notEqual(r.json.tokens.sessionId, a.tokens.sessionId, 'every sign-in is its own session');
  });
  it('wrong password and unknown email give the same answer', async () => {
    const a = await env.register();
    const wrong = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: 'definitely not it' } });
    const unknown = await env.call('POST', '/v1/auth/login', { body: { email: 'nobody-here@example.com', password: 'definitely not it' } });
    assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
    assert.equal(wrong.json.error.code, 'invalid_credentials'); assert.equal(unknown.json.error.code, 'invalid_credentials');
    assert.equal(wrong.json.error.message, unknown.json.error.message);
  });
  it('rejects malformed login bodies', async () => {
    for (const body of [{}, { email: 'a@b.co' }, { email: 'a@b.co', password: '' }, { email: 'a@b.co', password: 'x'.repeat(500) }, { email: 'a@b.co', password: 'x', admin: true }]) {
      const r = await env.call('POST', '/v1/auth/login', { body });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    }
  });
  it('pauses an email after repeated failures, even for the correct password, then recovers', async () => {
    const a = await env.register();
    for (let i = 0; i < 4; i += 1) assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: 'wrong wrong wrong' } })).status, 401);
    const locked = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    assert.equal(locked.status, 429); assert.equal(locked.json.error.code, 'too_many_attempts');
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    await env.pool.query(`UPDATE login_throttle SET locked_until = now() - interval '1 second'`);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200);
    const key = createHash('sha256').update(`throttle:login:${a.email}`).digest('hex');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM login_throttle WHERE key_hash = $1', [key])).rows[0].n, 0, 'a successful sign-in clears the counter');
  });
  it('throttles unknown emails exactly like real ones (nothing reveals which accounts exist)', async () => {
    const email = 'ghost-account@example.com';
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await env.call('POST', '/v1/auth/login', { body: { email, password: 'wrong wrong wrong' } })).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 429]);
  });
  it('the lock grows with continued failures', async () => {
    const email = 'escalate@example.com';
    for (let i = 0; i < 4; i += 1) await env.call('POST', '/v1/auth/login', { body: { email, password: 'wrong wrong wrong' } });
    const r1 = Number((await env.call('POST', '/v1/auth/login', { body: { email, password: 'x' } })).headers.get('retry-after'));
    await env.pool.query(`UPDATE login_throttle SET locked_until = now() - interval '1 second', updated_at = now()`);
    await env.call('POST', '/v1/auth/login', { body: { email, password: 'wrong wrong wrong' } });   // 5th failure
    const r2 = Number((await env.call('POST', '/v1/auth/login', { body: { email, password: 'x' } })).headers.get('retry-after'));
    assert.ok(r2 > r1, `${r2} > ${r1}`);
  });
  it('records failed and successful sign-ins in the security log of that account only', async () => {
    const a = await env.register(); const b = await env.register();
    await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: 'wrong wrong wrong' } });
    await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    const ev = await env.call('GET', '/v1/account/security-events', { token: a.tokens.accessToken });
    const types = ev.json.events.map((e: any) => e.type);
    assert.ok(types.includes('login_failed') && types.includes('login') && types.includes('register'));
    const evB = await env.call('GET', '/v1/account/security-events', { token: b.tokens.accessToken });
    assert.ok(!evB.json.events.some((e: any) => e.type === 'login_failed'));
  });
  it('upgrades a hash made with weaker settings when the user signs in', async () => {
    const a = await env.register();
    const weak = (await import('argon2')).default;
    const old = await weak.hash(a.password, { type: weak.argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 });
    await env.pool.query('UPDATE users SET password_hash = $2 WHERE email_normalized = $1', [a.email, old]);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200);
    const now = (await env.pool.query('SELECT password_hash FROM users WHERE email_normalized = $1', [a.email])).rows[0].password_hash;
    assert.match(now, /m=2048,t=1/);
  });
});

describe('access tokens and authorization', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '60' }); });
  after(async () => { await env.close(); });

  it('protected endpoints refuse requests without a token', async () => {
    for (const [m, p] of [['GET', '/v1/account'], ['GET', '/v1/account/settings'], ['GET', '/v1/account/sessions'], ['PATCH', '/v1/account/profile'], ['PUT', '/v1/account/password'], ['DELETE', '/v1/account/sessions']] as const) {
      const r = await env.call(m, p, m === 'GET' || m === 'DELETE' ? {} : { body: {} });
      assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.json.error.code, 'missing_token');
      assert.equal(r.headers.get('www-authenticate'), 'Bearer');
    }
  });
  it('refuses garbage, tampered, wrongly signed, "alg none" and wrong-audience tokens', async () => {
    const a = await env.register();
    const good = a.tokens.accessToken as string;
    const [h, p, s] = good.split('.') as [string, string, string];
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: '00000000-0000-4000-8000-000000000000' })).toString('base64url')}.${s}`;
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const none = `${noneHeader}.${p}.`;
    const wrongKey = await new SignJWT({ sid: a.tokens.sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject('00000000-0000-4000-8000-000000000000').setIssuer('petali-cloud').setAudience('petali-desktop').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode('x'.repeat(48)));
    const wrongAud = await new SignJWT({ sid: a.tokens.sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject('00000000-0000-4000-8000-000000000000').setIssuer('petali-cloud').setAudience('someone-else').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(env.config.jwtSecret));
    for (const t of ['garbage-token-value-12345', tampered, none, wrongKey, wrongAud, `${h}.${p}.${s}x`]) {
      const r = await env.call('GET', '/v1/account', { token: t });
      assert.equal(r.status, 401, t.slice(0, 24));
    }
    assert.equal((await env.call('GET', '/v1/account', { headers: { authorization: `Basic ${good}` } })).status, 401, 'only the Bearer scheme');
    assert.equal((await env.call('GET', '/v1/account', { token: good })).status, 200);
  });
  it('an access token expires', async () => {
    const a = await env.register();
    env.clock.advance(61_000);
    const r = await env.call('GET', '/v1/account', { token: a.tokens.accessToken });
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'token_expired');
    env.clock.advance(-61_000);
  });
  it('a token for a session that ended is refused immediately, before it expires', async () => {
    const a = await env.register();
    assert.equal((await env.call('POST', '/v1/auth/logout', { token: a.tokens.accessToken, body: {} })).status, 204);
    const r = await env.call('GET', '/v1/account', { token: a.tokens.accessToken });
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'session_revoked');
  });
  it('a token whose user and session do not belong together is refused', async () => {
    const a = await env.register(); const b = await env.register();
    const forged = await new SignJWT({ sid: b.tokens.sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject((await env.pool.query('SELECT id FROM users WHERE email_normalized = $1', [a.email])).rows[0].id)
      .setIssuer('petali-cloud').setAudience('petali-desktop').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(env.config.jwtSecret));
    assert.equal((await env.call('GET', '/v1/account', { token: forged })).status, 401);
  });
  it('a session past its absolute lifetime stops working', async () => {
    const a = await env.register();
    await env.pool.query(`UPDATE sessions SET max_expires_at = now() - interval '1 second' WHERE id = $1`, [a.tokens.sessionId]);
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 401);
  });
});

describe('refresh tokens and logout', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('rotates the refresh token on every use and issues a working access token', async () => {
    const a = await env.register();
    const r1 = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.json.tokens.refreshToken, a.tokens.refreshToken);
    assert.equal(r1.json.tokens.sessionId, a.tokens.sessionId, 'same session');
    assert.equal(r1.json.user.petaliId, a.user.petaliId);
    assert.equal((await env.call('GET', '/v1/account', { token: r1.json.tokens.accessToken })).status, 200);
    const r2 = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: r1.json.tokens.refreshToken } });
    assert.equal(r2.status, 200);
  });
  it('re-using an old refresh token ends the whole session (theft detection)', async () => {
    const a = await env.register();
    const r1 = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    const replay = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    assert.equal(replay.status, 401); assert.equal(replay.json.error.code, 'refresh_token_reused');
    const newest = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: r1.json.tokens.refreshToken } });
    assert.equal(newest.status, 401, 'the legitimate holder is cut off too');
    assert.equal((await env.call('GET', '/v1/account', { token: r1.json.tokens.accessToken })).status, 401);
    const ev = (await env.pool.query(`SELECT count(*)::int AS n FROM security_events WHERE type = 'refresh_reuse_detected'`)).rows[0].n;
    assert.ok(ev >= 1);
  });
  it('two simultaneous refreshes with the same token cannot both succeed', async () => {
    const a = await env.register();
    const [x, y] = await Promise.all([env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } }), env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } })]);
    assert.deepEqual([x.status, y.status].sort(), [200, 401]);
  });
  it('rejects unknown, malformed and empty refresh tokens', async () => {
    for (const t of ['ptr_' + 'A'.repeat(43), 'nonsense', 'ptr_short', '']) {
      const r = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: t } });
      assert.ok([400, 401].includes(r.status), t);
    }
    assert.equal((await env.call('POST', '/v1/auth/refresh', { body: {} })).status, 400);
  });
  it('a refresh token is bound to nothing but its session: an access token is not accepted in its place', async () => {
    const a = await env.register();
    const r = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.accessToken } });
    assert.ok(r.status === 400 || r.status === 401, `status ${r.status}`);
  });
  it('an idle session expires, and a session never outlives its absolute limit', async () => {
    const a = await env.register();
    await env.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [a.tokens.sessionId]);
    const r = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'session_expired');
    const b = await env.register();
    await env.pool.query(`UPDATE sessions SET max_expires_at = now() + interval '1 hour' WHERE id = $1`, [b.tokens.sessionId]);
    const ok = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: b.tokens.refreshToken } });
    assert.equal(ok.status, 200);
    assert.ok(Date.parse(ok.json.tokens.refreshTokenExpiresAt) <= Date.now() + 3_600_000 + 5_000, 'capped by the absolute lifetime');
  });
  it('logout with the access token ends that session and its refresh token', async () => {
    const a = await env.register();
    assert.equal((await env.call('POST', '/v1/auth/logout', { token: a.tokens.accessToken, body: {} })).status, 204);
    const r = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'session_revoked');
  });
  it('logout with only the refresh token works (expired access token), and is idempotent', async () => {
    const a = await env.register();
    env.clock.advance(3_600_000);
    assert.equal((await env.call('POST', '/v1/auth/logout', { token: a.tokens.accessToken, body: { refreshToken: a.tokens.refreshToken } })).status, 204);
    assert.equal((await env.call('POST', '/v1/auth/logout', { body: { refreshToken: a.tokens.refreshToken } })).status, 204);
    assert.equal((await env.call('POST', '/v1/auth/logout', { body: { refreshToken: 'ptr_' + 'B'.repeat(43) } })).status, 204);
    assert.equal((await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } })).status, 401);
    env.clock.advance(-3_600_000);
  });
  it('logout with nothing to identify the session is a bad request', async () => {
    assert.equal((await env.call('POST', '/v1/auth/logout', { body: {} })).status, 400);
  });
  it('logging out one session leaves the same account\'s other sessions alone', async () => {
    const a = await env.register();
    const second = await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } });
    await env.call('POST', '/v1/auth/logout', { token: a.tokens.accessToken, body: {} });
    assert.equal((await env.call('GET', '/v1/account', { token: second.json.tokens.accessToken })).status, 200);
  });
});

describe('account switching at the API level', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });
  it('signing out of account A and into account B gives B\'s data only; A\'s old credentials are dead', async () => {
    const a = await env.register('switch-a@example.com'); const b = await env.register('switch-b@example.com');
    await env.call('PATCH', '/v1/account/profile', { token: a.tokens.accessToken, body: { displayName: 'Alice' } });
    await env.call('POST', '/v1/auth/logout', { token: a.tokens.accessToken, body: {} });
    const login = await env.call('POST', '/v1/auth/login', { body: { email: b.email, password: b.password } });
    const me = await env.call('GET', '/v1/account', { token: login.json.tokens.accessToken });
    assert.equal(me.json.user.petaliId, b.user.petaliId); assert.equal(me.json.user.displayName, null);
    assert.equal((await env.call('GET', '/v1/account', { token: a.tokens.accessToken })).status, 401);
    assert.equal((await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } })).status, 401);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200, 'A can come back');
  });
});
