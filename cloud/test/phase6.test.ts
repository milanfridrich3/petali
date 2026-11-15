import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config/env';
import { createMailer, MailError, type Mailer, type MailMessage } from '../src/lib/mailer';
import { verificationEmail } from '../src/lib/email-templates';
import { passwordProblem, PASSWORD_MIN } from '../src/modules/auth/passwords';
import { createTestEnv, type TestEnv } from './helpers';

// Backend integration tests for Phase 6. They use REAL PostgreSQL and the REAL mailer code path. The email PROVIDER is a local HTTP stand-in that
// speaks the same API (POST /emails). This proves our integration (request shape, auth header, error handling); it is NOT proof that a real
// inbox received a message: that needs the real provider credentials and is listed as manual verification in the report.
type Sent = { auth: string | undefined; body: any };
async function providerStandIn(behaviour: { status: number }) {
  const received: Sent[] = [];
  const server: Server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { received.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null }); res.writeHead(behaviour.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'x' })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { received, url, behaviour, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const tokenOf = (m: MailMessage) => { const x = /verify\?token=([^\s"&<]+)/.exec(m.text); assert.ok(x, 'no link in the email'); return decodeURIComponent(x[1] as string); };

describe('password minimum is 7 characters (Phase 6)', () => {
  it('rejects 6, accepts 7, keeps the other rules', () => {
    assert.equal(PASSWORD_MIN, 7);
    assert.match(passwordProblem('abc12!')!, /at least 7/);
    assert.equal(passwordProblem('abc123!'), null);
    assert.ok(passwordProblem('aaaaaaa'));              // still too repetitive
    for (const w of ['1234567', '12345678', 'qwerty123', 'iloveyou', 'password']) assert.ok(passwordProblem(w), w);   // the deny-list now covers 7-9 characters too
    assert.ok(passwordProblem('       '));             // still only spaces
    assert.match(passwordProblem('a'.repeat(129))!, /at most 128/);
  });
  let env: TestEnv; before(async () => { env = await createTestEnv(); }); after(async () => { await env.close(); });
  it('the API rejects a 6-character password and accepts a 7-character one (desktop and web registration)', async () => {
    for (const [path, headers] of [['/v1/auth/register', {}], ['/v1/web/session/register', { origin: 'https://petali.netlify.app', 'x-petali-web': '1' }]] as const) {
      const tag = path.includes('web') ? 'w' : 'd';
      const bad = await env.call('POST', path, { headers: { ...headers }, body: { email: `six-${tag}@example.com`, password: 'qz7!Kp' } });
      assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'weak_password');
      const ok = await env.call('POST', path, { headers: { ...headers }, body: { email: `seven-${tag}@example.com`, password: 'qz7!Kpa' } });
      assert.equal(ok.status, 201, ok.text);
    }
  });
  it('login never enforces the minimum (an existing account always gets in) and the password change uses the same rule', async () => {
    const a = await env.register('keep@example.com', 'correct horse battery staple');
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200);
    const t = a.tokens.accessToken;
    assert.equal((await env.call('PUT', '/v1/account/password', { token: t, body: { currentPassword: a.password, newPassword: 'abc12!' } })).status, 400);
    assert.equal((await env.call('PUT', '/v1/account/password', { token: t, body: { currentPassword: a.password, newPassword: 'abc123!' } })).status, 200);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: 'abc123!' } })).status, 200);
  });
  it('an existing password of 10+ characters still works after the change (compatibility)', async () => {
    const a = await env.register('old@example.com', 'ten-chars-1!');
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200);
  });
});

describe('email configuration', () => {
  const good = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'k3Jd8sLq0Zx7VbN2mQw9TgHy5RuPc1AeFo4Ki6Dj', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  it('defaults to "no provider": nothing is sent and nothing is claimed', () => { const c = loadConfig(good); assert.equal(c.email.provider, 'none'); assert.equal(c.email.enforceFrom, null); });
  it('requires a key and a sender when a provider is chosen, validates the link origin and the enforce date', () => {
    assert.throws(() => loadConfig({ ...good, EMAIL_PROVIDER: 'resend' }), /EMAIL_API_KEY/);
    assert.throws(() => loadConfig({ ...good, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'abcdefghij' }), /EMAIL_FROM/);
    assert.throws(() => loadConfig({ ...good, EMAIL_VERIFY_BASE_URL: 'https://x.example/path/' }), /origin/);
    assert.throws(() => loadConfig({ ...good, EMAIL_VERIFICATION_ENFORCE_FROM: 'soon' }), /ISO/);
    assert.throws(() => loadConfig({ ...good, NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'abcdefghij', EMAIL_FROM: 'Petali <a@b.cz>', EMAIL_VERIFY_BASE_URL: 'http://x.example', ARGON2_MEMORY_KIB: '19456', ARGON2_TIME_COST: '2' }), /https/);
  });
});

describe('mailer', () => {
  const log = { warn() {}, error() {}, info() {}, debug() {} } as any;
  const msg: MailMessage = { to: 'a@example.com', subject: 's', text: 't', html: '<p>h</p>' };
  it('is honest when unconfigured', async () => {
    const m = createMailer(loadConfig({ DATABASE_URL: 'x', JWT_ACCESS_SECRET: 'k3Jd8sLq0Zx7VbN2mQw9TgHy5RuPc1AeFo4Ki6Dj', NODE_ENV: 'test' } as any).email, log);
    assert.equal(m.configured, false); await assert.rejects(m.send(msg), (e: MailError) => e.code === 'not_configured');
  });
  it('sends through the provider API with the key only in the Authorization header, and reports rejection and unreachability', async () => {
    const p = await providerStandIn({ status: 200 });
    try {
      const cfg = loadConfig({ DATABASE_URL: 'x', JWT_ACCESS_SECRET: 'k3Jd8sLq0Zx7VbN2mQw9TgHy5RuPc1AeFo4Ki6Dj', NODE_ENV: 'test', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'key-abcdefgh', EMAIL_FROM: 'Petali <no-reply@example.com>', EMAIL_API_URL: p.url } as any).email;
      const m = createMailer(cfg, log);
      await m.send(msg);
      assert.equal(p.received[0]!.auth, 'Bearer key-abcdefgh'); assert.deepEqual(p.received[0]!.body.to, ['a@example.com']); assert.equal(p.received[0]!.body.from, 'Petali <no-reply@example.com>');
      assert.ok(!JSON.stringify(p.received[0]!.body).includes('key-abcdefgh'));
      p.behaviour.status = 422; await assert.rejects(m.send(msg), (e: MailError) => e.code === 'provider_rejected' && e.providerStatus === 422);
      await assert.rejects(createMailer({ ...cfg, apiUrl: 'http://127.0.0.1:9' }, log).send(msg), (e: MailError) => e.code === 'provider_unreachable');
    } finally { await p.close(); }
  });
});

describe('email template', () => {
  it('has branding, the link, the expiry and escapes the display name', () => {
    const e = verificationEmail({ displayName: '<b>Eve</b>', link: 'https://x.example/id/verify?token=abc&x=1', ttlHours: 24 });
    assert.match(e.html, /Petali ID/); assert.match(e.html, /24 hours/); assert.ok(!e.html.includes('<b>Eve</b>')); assert.match(e.html, /&amp;x=1/);
    assert.match(e.text, /https:\/\/x\.example\/id\/verify\?token=abc&x=1/); assert.match(e.subject, /Petali ID/);
  });
});

describe('registration, verification, resend, expiry (real PostgreSQL, provider stand-in)', () => {
  let env: TestEnv; let p: Awaited<ReturnType<typeof providerStandIn>>; const mails: MailMessage[] = [];
  const WEBH = { origin: 'https://petali.netlify.app', 'x-petali-web': '1' };
  before(async () => {
    p = await providerStandIn({ status: 200 });
    const base = { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'key-abcdefgh', EMAIL_FROM: 'Petali <no-reply@example.com>', EMAIL_API_URL: p.url, EMAIL_VERIFY_BASE_URL: 'https://petali.netlify.app', EMAIL_VERIFICATION_ENFORCE_FROM: new Date(Date.now() - 1000).toISOString() };
    env = await createTestEnv(base);
  });
  after(async () => { await env.close(); await p.close(); });
  const lastToken = () => { const b = p.received[p.received.length - 1]!.body; return tokenOf({ to: b.to[0], subject: b.subject, text: b.text, html: b.html }); };

  it('registration really calls the provider with a verification link and reports sent:true', async () => {
    const n = p.received.length;
    const r = await env.call('POST', '/v1/auth/register', { body: { email: 'new@example.com', password: 'abc123!', displayName: 'Nia' } });
    assert.equal(r.status, 201); assert.deepEqual(r.json.emailVerification, { sent: true, required: true });
    assert.equal(r.json.user.emailVerified, false);
    assert.equal(p.received.length, n + 1); assert.deepEqual(p.received[n]!.body.to, ['new@example.com']);
    assert.match(p.received[n]!.body.text, /^Hi Nia,/); assert.match(p.received[n]!.body.html, /https:\/\/petali\.netlify\.app\/id\/verify\?token=/);
    assert.ok(!r.text.includes('key-abcdefgh') && !r.text.includes(lastToken()));       // neither the key nor the token is ever in an API response
  });
  it('an unverified new account is blocked from sync, computers and web views, but can sign in, read its account and resend', async () => {
    const a = await env.register('blocked@example.com', 'abc123!'); const t = a.tokens.accessToken;
    for (const path of ['/v1/devices', '/v1/web/overview', '/v1/web/plant']) { const r = await env.call('GET', path, { token: t }); assert.equal(r.status, 403, path); assert.equal(r.json.error.code, 'email_not_verified'); }
    assert.equal((await env.call('POST', '/v1/sync/devices/register', { token: t, body: { clientDeviceId: '11111111-1111-4111-8111-111111111111', name: 'PC' } })).status, 403);
    assert.equal((await env.call('GET', '/v1/account', { token: t })).status, 200);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: a.email, password: a.password } })).status, 200);
  });
  it('a valid link verifies the account (and only then), unlocks it, and a second use is harmless', async () => {
    const a = await env.register('verify@example.com', 'abc123!'); const t = a.tokens.accessToken; const token = lastToken();
    assert.equal((await env.call('GET', '/v1/web/overview', { token: t })).status, 403);
    const v = await env.call('POST', '/v1/auth/verify-email', { body: { token } });
    assert.equal(v.status, 200); assert.equal(v.json.status, 'verified');
    assert.equal((await env.call('GET', '/v1/account', { token: t })).json.user.emailVerified, true);
    assert.notEqual((await env.call('GET', '/v1/web/overview', { token: t })).status, 403);
    assert.equal((await env.call('POST', '/v1/auth/verify-email', { body: { token } })).json.status, 'already_verified');
  });
  it('invalid, tampered and expired links are refused with clear codes and verify nothing', async () => {
    const a = await env.register('badlink@example.com', 'abc123!'); const token = lastToken();
    for (const bad of ['x'.repeat(40), token.slice(0, -3) + 'abc', token.split('.').slice(0, 2).join('.') + '.']) { const r = await env.call('POST', '/v1/auth/verify-email', { body: { token: bad } }); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'verification_invalid'); }
    env.clock.advance(25 * 3_600_000);
    const r = await env.call('POST', '/v1/auth/verify-email', { body: { token } }); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'verification_expired');
    const row = await env.pool.query('SELECT email_verified_at FROM users WHERE email_normalized = $1', [a.email]); assert.equal(row.rows[0].email_verified_at, null);
  });
  it('resend: needs sign-in, sends a new working email, is rate limited per minute, and refuses once verified', async () => {
    const a = await env.register('resend@example.com', 'abc123!'); const t = a.tokens.accessToken;
    assert.equal((await env.call('POST', '/v1/auth/resend-verification', { body: {} })).status, 401);
    const early = await env.call('POST', '/v1/auth/resend-verification', { token: t, body: {} }); assert.equal(early.status, 429); assert.equal(early.json.error.code, 'resend_too_soon');
    env.clock.advance(61_000); const n = p.received.length;
    assert.equal((await env.call('POST', '/v1/auth/resend-verification', { token: t, body: {} })).status, 200); assert.equal(p.received.length, n + 1);
    assert.equal((await env.call('POST', '/v1/auth/verify-email', { body: { token: lastToken() } })).json.status, 'verified');
    env.clock.advance(61_000);
    const again = await env.call('POST', '/v1/auth/resend-verification', { token: t, body: {} }); assert.equal(again.status, 409); assert.equal(again.json.error.code, 'already_verified');
  });
  it('a failing provider is reported as a failure, never as success; registration still succeeds', async () => {
    p.behaviour.status = 500;
    try {
      const r = await env.call('POST', '/v1/web/session/register', { headers: WEBH, body: { email: 'fail@example.com', password: 'abc123!' } });
      assert.equal(r.status, 201); assert.equal(r.json.emailVerification.sent, false); assert.equal(r.json.emailVerification.reason, 'delivery_failed');
      env.clock.advance(61_000);
      const rs = await env.call('POST', '/v1/auth/resend-verification', { token: r.json.accessToken, body: {} }); assert.equal(rs.status, 502); assert.equal(rs.json.error.code, 'email_delivery_failed');
    } finally { p.behaviour.status = 200; }
  });
  it('changing the email un-verifies the account, sends a new link, and old links stop working', async () => {
    const a = await env.register('before@example.com', 'abc123!'); const oldToken = lastToken();
    await env.call('POST', '/v1/auth/verify-email', { body: { token: oldToken } });
    const ch = await env.call('PUT', '/v1/account/email', { token: a.tokens.accessToken, body: { newEmail: 'after@example.com', currentPassword: a.password } });
    assert.equal(ch.status, 200); assert.equal(ch.json.user.emailVerified, false); assert.equal(ch.json.emailVerification.sent, true);
    assert.deepEqual(p.received[p.received.length - 1]!.body.to, ['after@example.com']);
    const old = await env.call('POST', '/v1/auth/verify-email', { body: { token: oldToken } }); assert.equal(old.status, 400);
    assert.equal((await env.call('POST', '/v1/auth/verify-email', { body: { token: lastToken() } })).json.status, 'verified');
  });
});

describe('accounts created before the enforcement date are never locked out', () => {
  let env: TestEnv; before(async () => { env = await createTestEnv({ EMAIL_VERIFICATION_ENFORCE_FROM: new Date(Date.now() + 3_600_000).toISOString() }); }); after(async () => { await env.close(); });
  it('an unverified account that exists before the enforcement instant keeps full access', async () => {
    const a = await env.register('legacy@example.com', 'abc123!');
    for (const path of ['/v1/devices', '/v1/web/overview']) assert.notEqual((await env.call('GET', path, { token: a.tokens.accessToken })).status, 403, path);
    assert.equal(a.user.emailVerified, false);
  });
});

describe('unconfigured server (the current production state) and enforcement off', () => {
  let env: TestEnv; before(async () => { env = await createTestEnv(); }); after(async () => { await env.close(); });
  it('registration says plainly that no email was sent, and nothing is blocked while enforcement is off', async () => {
    const r = await env.call('POST', '/v1/auth/register', { body: { email: 'plain@example.com', password: 'abc123!' } });
    assert.equal(r.status, 201); assert.deepEqual(r.json.emailVerification, { sent: false, required: false, reason: 'not_configured' });
    assert.notEqual((await env.call('GET', '/v1/devices', { token: r.json.tokens.accessToken })).status, 403);
    const rs = await env.call('POST', '/v1/auth/resend-verification', { token: r.json.tokens.accessToken, body: {} }); assert.equal(rs.status, 503); assert.equal(rs.json.error.code, 'email_not_configured');
  });
  it('the health endpoint reports the 1.5.0 service version', async () => { assert.equal((await env.call('GET', '/v1/health')).json.serviceVersion, '1.5.0'); });
});

describe('GET /v1/web/appearance (the desktop night schedule for Petali ID "Automatic")', () => {
  let env: TestEnv; before(async () => { env = await createTestEnv({ EMAIL_VERIFICATION_ENFORCE_FROM: new Date(Date.now() - 1000).toISOString() }); }); after(async () => { await env.close(); });
  const pushSchedule = async (token: string, data: unknown) => {
    const d = await env.call('POST', '/v1/sync/devices/register', { token, body: { clientDeviceId: randomUUID(), name: 'PC', platform: 'win32' } });
    assert.equal(d.status, 200, d.text);
    return env.call('POST', '/v1/sync/push', { token, body: { deviceId: d.json.device.id, epoch: d.json.device.epoch, ops: [{ kind: 'setting', key: 'ui.autoNight', scope: 'account', clientUpdatedAt: new Date().toISOString(), data }] } });
  };
  it('requires sign-in', async () => { assert.equal((await env.call('GET', '/v1/web/appearance')).status, 401); });
  it('returns null when the desktop never set a schedule', async () => {
    const a = await env.register('noappearance@example.com', 'abc123!');
    await env.call('POST', '/v1/auth/verify-email', { body: { token: 'x'.repeat(30) } });      // (noise: an invalid token changes nothing)
    const r = await env.call('GET', '/v1/web/appearance', { token: a.tokens.accessToken }); assert.equal(r.status, 200); assert.deepEqual(r.json, { autoNight: null });
    assert.equal((await env.call('GET', '/v1/web/overview', { token: a.tokens.accessToken })).status, 403);       // the look is readable before the gate; the data pages are not
  });
  it('returns the schedule the desktop synced, and is readable by an account whose email is not (any longer) verified', async () => {
    const a = await env.register('appearance@example.com', 'abc123!');
    await env.pool.query(`UPDATE users SET email_verified_at = now() WHERE email_normalized = 'appearance@example.com'`);     // the desktop can only sync once verified
    assert.equal((await pushSchedule(a.tokens.accessToken, { from: '20:00', to: '07:00' })).status, 200);
    await env.pool.query(`UPDATE users SET email_verified_at = NULL WHERE email_normalized = 'appearance@example.com'`);
    const r = await env.call('GET', '/v1/web/appearance', { token: a.tokens.accessToken }); assert.equal(r.status, 200); assert.deepEqual(r.json, { autoNight: { from: '20:00', to: '07:00' } });
  });
  it('never returns a malformed schedule (the client then uses 22:00-06:00)', async () => {
    for (const [i, bad] of [{ from: '25:00', to: '06:00' }, { from: '22:00', to: '22:00' }, { from: 5, to: 6 }, 'night', { from: '22:00' }].entries()) {
      const a = await env.register(`badsched${i}@example.com`, 'abc123!'); await env.pool.query(`UPDATE users SET email_verified_at = now() WHERE email_normalized = $1`, [`badsched${i}@example.com`]);
      await pushSchedule(a.tokens.accessToken, bad);
      assert.deepEqual((await env.call('GET', '/v1/web/appearance', { token: a.tokens.accessToken })).json, { autoNight: null }, JSON.stringify(bad));
    }
  });
});
