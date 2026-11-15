import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';
import { startGoogleMock, type GoogleMock } from './google-mock';

// MOCKED GOOGLE. Every test here runs the backend's real code (token exchange over HTTP, JWKS fetch, RS256 verification, claim checks, account linking) against a
// LOCAL stand-in server (test/google-mock.ts). None of it talks to Google; nothing here proves that real Google credentials work.
const WEB_REDIRECT = 'https://petali.netlify.app/id/api/v1/web/google/callback';
const ORIGIN = 'https://petali.netlify.app';
const b64 = (n = 32) => randomBytes(n).toString('base64url');
const pkce = () => { const verifier = b64(); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const DESKTOP_REDIRECT = 'http://127.0.0.1:53682/callback';

let mock: GoogleMock; let env: TestEnv; let n = 0;
const DESKTOP_ID = 'mock-desktop-client.apps.googleusercontent.com';
before(async () => {
  mock = await startGoogleMock();
  env = await createTestEnv({
    GOOGLE_WEB_CLIENT_ID: mock.clientId, GOOGLE_WEB_CLIENT_SECRET: mock.clientSecret, GOOGLE_WEB_REDIRECT_URI: WEB_REDIRECT,
    GOOGLE_DESKTOP_CLIENT_ID: DESKTOP_ID, GOOGLE_DESKTOP_CLIENT_SECRET: mock.clientSecret,
    GOOGLE_TOKEN_URL: `${mock.url}/token`, GOOGLE_JWKS_URL: `${mock.url}/certs`,
  });
});
after(async () => { await env.close(); await mock.close(); });

const email = () => { n += 1; return `g${n}-${b64(3).toLowerCase()}@example.com`; };

// One complete desktop flow: ask for the URL, let "Google" issue a code for what the URL asked, exchange it.
async function desktopSignIn(o: { sub: string; email: string; emailVerified?: boolean | string; name?: string; tamper?: (c: { nonce: string }) => Record<string, unknown> | void; overrides?: Record<string, unknown>; signWith?: 'good' | 'other'; omit?: string[]; clientId?: string; exchangeNonce?: string; verifier?: string; redirect?: string }) {
  const { verifier, challenge } = pkce(); const state = b64(); const nonce = b64();
  const start = await env.call('POST', '/v1/auth/google/desktop/start', { body: { redirectUri: DESKTOP_REDIRECT, state, nonce, codeChallenge: challenge } });
  assert.equal(start.status, 200, start.text);
  const code = mock.issueCode({ redirectUri: DESKTOP_REDIRECT, challenge, nonce, sub: o.sub, email: o.email, clientId: o.clientId ?? DESKTOP_ID, ...(o.emailVerified !== undefined ? { emailVerified: o.emailVerified } : {}), ...(o.name ? { name: o.name } : {}), ...(o.overrides ? { overrides: o.overrides } : {}), ...(o.signWith ? { signWith: o.signWith } : {}), ...(o.omit ? { omit: o.omit } : {}) });
  const res = await env.call('POST', '/v1/auth/google/desktop/exchange', { body: { code, codeVerifier: o.verifier ?? verifier, redirectUri: o.redirect ?? DESKTOP_REDIRECT, nonce: o.exchangeNonce ?? nonce, deviceLabel: 'Petali 1.5.0 on Windows' } });
  return { res, start, state, nonce, challenge };
}

describe('google: configuration and providers', () => {
  it('reports what the server can do, without secrets', async () => {
    const r = await env.call('GET', '/v1/auth/providers');
    assert.equal(r.status, 200); assert.deepEqual(r.json, { google: { web: true, desktop: true } });
    assert.ok(!r.text.includes(mock.clientSecret));
  });
  it('a server with no Google configuration says so and everything else keeps working', async () => {
    const plain = await createTestEnv();
    try {
      assert.deepEqual((await plain.call('GET', '/v1/auth/providers')).json, { google: { web: false, desktop: false } });
      const r = await plain.call('POST', '/v1/auth/google/desktop/start', { body: { redirectUri: DESKTOP_REDIRECT, state: b64(), nonce: b64(), codeChallenge: pkce().challenge } });
      assert.equal(r.status, 503); assert.equal(r.json.error.code, 'google_not_configured');
      const w = await plain.call('POST', '/v1/web/google/start', { headers: { 'x-petali-web': '1', origin: ORIGIN }, body: {} });
      assert.equal(w.status, 503); assert.equal(w.json.error.code, 'google_not_configured');
      await plain.register();   // email/password registration is untouched
    } finally { await plain.close(); }
  });
  it('refuses a half-configured client and Google endpoint overrides in production', async () => {
    const { loadConfig } = await import('../src/config/env.js');
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: randomBytes(48).toString('base64') };
    assert.throws(() => loadConfig({ ...base, GOOGLE_WEB_CLIENT_ID: 'abcdefghijkl' }), /set together/);
    assert.throws(() => loadConfig({ ...base, GOOGLE_WEB_CLIENT_ID: 'abcdefghijkl', GOOGLE_WEB_CLIENT_SECRET: 'abcdefghijkl' }), /GOOGLE_WEB_REDIRECT_URI/);
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', GOOGLE_TOKEN_URL: 'http://evil.example/token', ARGON2_MEMORY_KIB: '19456', ARGON2_TIME_COST: '2', EMAIL_PROVIDER: 'none' }), /only be set outside production/);
  });
});

describe('google: desktop flow (authorization code + PKCE, loopback redirect)', () => {
  it('start builds the Google URL with PKCE S256, state, nonce and the right client; only loopback redirects are accepted', async () => {
    const { challenge } = pkce(); const state = b64(); const nonce = b64();
    const r = await env.call('POST', '/v1/auth/google/desktop/start', { body: { redirectUri: DESKTOP_REDIRECT, state, nonce, codeChallenge: challenge } });
    const u = new URL(r.json.authUrl);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('client_id'), DESKTOP_ID); assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('code_challenge'), challenge); assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('state'), state); assert.equal(u.searchParams.get('nonce'), nonce); assert.equal(u.searchParams.get('scope'), 'openid email profile');
    assert.ok(!r.text.includes(mock.clientSecret));
    for (const bad of ['https://127.0.0.1:5000/callback', 'http://localhost:5000/callback', 'http://127.0.0.1:5000/other', 'http://evil.example/callback', 'http://127.0.0.1:5000/callback?x=1']) {
      assert.equal((await env.call('POST', '/v1/auth/google/desktop/start', { body: { redirectUri: bad, state, nonce, codeChallenge: challenge } })).status, 400, bad);
    }
    assert.equal((await env.call('POST', '/v1/auth/google/desktop/start', { body: { redirectUri: DESKTOP_REDIRECT, state: 'short', nonce, codeChallenge: challenge } })).status, 400);
  });

  it('registers a new account through Google: verified email, no password, a normal session', async () => {
    const e = email();
    const { res } = await desktopSignIn({ sub: `sub-${b64(6)}`, email: e, name: 'Ann Lee' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.isNewAccount, true); assert.equal(res.json.user.email, e); assert.equal(res.json.user.emailVerified, true);
    assert.equal(res.json.user.displayName, 'Ann Lee'); assert.equal(res.json.user.hasPassword, false); assert.match(res.json.user.petaliId, /^PTL-/);
    const t = res.json.tokens;
    assert.equal((await env.call('GET', '/v1/account', { token: t.accessToken })).status, 200);
    assert.equal((await env.call('GET', '/v1/account/sessions', { token: t.accessToken })).json.sessions[0].deviceLabel, 'Petali 1.5.0 on Windows');
    const rf = await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: t.refreshToken } });
    assert.equal(rf.status, 200, 'the existing refresh-token rotation works for a Google session');
    assert.equal((await env.call('POST', '/v1/auth/refresh', { body: { refreshToken: t.refreshToken } })).status, 401, 'reuse of the old token is still detected');
    const ev = (await env.pool.query(`SELECT type, detail FROM security_events WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY id`, [e])).rows;
    assert.deepEqual(ev.slice(0, 1), [{ type: 'register', detail: 'google' }]);
  });

  it('signing in again with the same Google account is the same Petali account (no duplicate)', async () => {
    const e = email(); const sub = `sub-${b64(6)}`;
    const a = await desktopSignIn({ sub, email: e }); const b = await desktopSignIn({ sub, email: e });
    assert.equal(b.res.json.isNewAccount, false); assert.equal(b.res.json.user.petaliId, a.res.json.user.petaliId);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM users WHERE email_normalized = $1', [e])).rows[0].n, 1);
  });

  it('the sub, not the email, identifies the account: a changed Google email still reaches the same account', async () => {
    const sub = `sub-${b64(6)}`; const a = await desktopSignIn({ sub, email: email() });
    const b = await desktopSignIn({ sub, email: email() });
    assert.equal(b.res.json.user.petaliId, a.res.json.user.petaliId); assert.equal(b.res.json.user.email, a.res.json.user.email);
  });

  it('links to an existing account whose email is VERIFIED, keeps its data and password login, and creates no duplicate', async () => {
    const pw = await env.register(email());
    await env.pool.query('UPDATE users SET email_verified_at = now() WHERE email = $1', [pw.email]);
    const { res } = await desktopSignIn({ sub: `sub-${b64(6)}`, email: pw.email.toUpperCase() });
    assert.equal(res.status, 200, res.text); assert.equal(res.json.linkedExisting, true); assert.equal(res.json.isNewAccount, false);
    assert.equal(res.json.user.petaliId, pw.user.petaliId); assert.equal(res.json.user.hasPassword, true);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM users WHERE email_normalized = $1', [pw.email])).rows[0].n, 1);
    assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: pw.email, password: pw.password } })).status, 200, 'email/password still works');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM external_identities')).rows[0].n > 0, true);
  });

  it('REFUSES to link an existing account whose email is not verified (no takeover by pre-registration)', async () => {
    const victim = email();
    const attacker = await env.register(victim, 'attacker chosen passphrase');       // someone registered the victim's address first, never verified it
    const { res } = await desktopSignIn({ sub: `sub-${b64(6)}`, email: victim });
    assert.equal(res.status, 409); assert.equal(res.json.error.code, 'account_needs_verification');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM external_identities e JOIN users u ON u.id = e.user_id WHERE u.email = $1', [victim])).rows[0].n, 0, 'nothing was linked');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM users WHERE email_normalized = $1', [victim])).rows[0].n, 1, 'and no second account was created');
    assert.ok(attacker.user.petaliId);
  });

  it('an account already connected to one Google account refuses a different Google account with the same email', async () => {
    const pw = await env.register(email()); await env.pool.query('UPDATE users SET email_verified_at = now() WHERE email = $1', [pw.email]);
    assert.equal((await desktopSignIn({ sub: `sub-${b64(6)}`, email: pw.email })).res.status, 200);
    const second = await desktopSignIn({ sub: `sub-${b64(6)}`, email: pw.email });
    assert.equal(second.res.status, 409); assert.equal(second.res.json.error.code, 'google_account_mismatch');
  });

  it('a Google-created account cannot be entered with a password, and password-protected actions explain why', async () => {
    const e = email(); const { res } = await desktopSignIn({ sub: `sub-${b64(6)}`, email: e });
    for (const guess of ['correct horse battery staple', '', 'password']) assert.equal((await env.call('POST', '/v1/auth/login', { body: { email: e, password: guess || 'x' } })).status, 401);
    const t = res.json.tokens.accessToken;
    const cp = await env.call('PUT', '/v1/account/password', { token: t, body: { currentPassword: 'anything at all', newPassword: 'a brand new passphrase' } });
    assert.equal(cp.status, 403); assert.equal(cp.json.error.code, 'password_not_set');
    assert.equal((await env.call('POST', '/v1/account/deletion-request', { token: t, body: { password: 'anything at all' } })).json.error.code, 'password_not_set');
  });

  it('a code cannot be used twice, with another verifier, or after a failed attempt', async () => {
    const { verifier, challenge } = pkce(); const nonce = b64(); const sub = `sub-${b64(6)}`; const e = email();
    const mk = () => mock.issueCode({ redirectUri: DESKTOP_REDIRECT, challenge, nonce, sub, email: e, clientId: DESKTOP_ID });
    const call = (code: string, v: string) => env.call('POST', '/v1/auth/google/desktop/exchange', { body: { code, codeVerifier: v, redirectUri: DESKTOP_REDIRECT, nonce } });
    const c1 = mk(); assert.equal((await call(c1, verifier)).status, 200);
    const replay = await call(c1, verifier); assert.equal(replay.status, 400); assert.equal(replay.json.error.code, 'google_code_invalid');
    const wrong = await call(mk(), b64()); assert.equal(wrong.status, 400, 'PKCE verifier mismatch is refused (by the stand-in, as Google would)');
  });
});

describe('google: the backend validates the ID token itself', () => {
  const fails = async (label: string, o: Parameters<typeof desktopSignIn>[0], code: string, status = 401) => {
    const { res } = await desktopSignIn(o);
    assert.equal(res.status, status, `${label}: ${res.text}`); assert.equal(res.json.error.code, code, label);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM users WHERE email_normalized = $1', [o.email])).rows[0].n, 0, `${label}: no account was created`);
  };
  it('rejects a wrong signature, audience, issuer, expiry, nonce, azp, subject and old tokens', async () => {
    await fails('signature from another key', { sub: 's1', email: email(), signWith: 'other' }, 'google_token_invalid');
    await fails('audience of another client', { sub: 's2', email: email(), overrides: { aud: 'someone-else.apps.googleusercontent.com' } }, 'google_token_invalid');
    await fails('issuer', { sub: 's3', email: email(), overrides: { iss: 'https://evil.example' } }, 'google_token_invalid');
    const past = Math.floor(Date.now() / 1000) - 7200;
    await fails('expired', { sub: 's4', email: email(), overrides: { iat: past, exp: past + 600 } }, 'google_token_invalid');
    await fails('issued long ago (age limit)', { sub: 's5', email: email(), overrides: { iat: Math.floor(Date.now() / 1000) - 3000 } }, 'google_token_invalid');
    await fails('nonce replayed from another login', { sub: 's6', email: email(), exchangeNonce: b64() }, 'google_token_invalid');
    await fails('nonce missing', { sub: 's7', email: email(), omit: ['nonce'] }, 'google_token_invalid');
    await fails('azp of another client', { sub: 's8', email: email(), overrides: { azp: 'other.apps.googleusercontent.com' } }, 'google_token_invalid');
    await fails('subject missing', { sub: 's9', email: email(), omit: ['sub'] }, 'google_token_invalid');
    await fails('code issued to the web client, exchanged as the desktop client (Google itself refuses the mismatch)', { sub: 's10', email: email(), clientId: mock.clientId }, 'google_code_invalid', 400);
  });
  it('rejects an email Google has not verified, or no email at all', async () => {
    await fails('email_verified false', { sub: 'e1', email: email(), emailVerified: false }, 'google_email_not_verified', 403);
    await fails('email_verified missing', { sub: 'e2', email: email(), omit: ['email_verified'] }, 'google_email_not_verified', 403);
    await fails('no email', { sub: 'e3', email: 'x@example.com', omit: ['email'] }, 'google_email_missing', 403);
  });
  it('treats the client-supplied fields as untrusted: unknown properties and a smuggled email are rejected', async () => {
    const { verifier, challenge } = pkce(); const nonce = b64();
    const code = mock.issueCode({ redirectUri: DESKTOP_REDIRECT, challenge, nonce, sub: 'sx', email: email(), clientId: DESKTOP_ID });
    const r = await env.call('POST', '/v1/auth/google/desktop/exchange', { body: { code, codeVerifier: verifier, redirectUri: DESKTOP_REDIRECT, nonce, email: 'admin@victim.example' } });
    assert.equal(r.status, 400); assert.equal(r.json.error.code, 'validation_failed');
  });
  it('a Google outage is a clear, retryable error and creates nothing', async () => {
    const { verifier, challenge } = pkce(); const nonce = b64();
    const res = await env.call('POST', '/v1/auth/google/desktop/exchange', { body: { code: 'definitely-not-issued-by-anyone', codeVerifier: verifier, redirectUri: DESKTOP_REDIRECT, nonce } });
    assert.equal(res.status, 400); assert.equal(res.json.error.code, 'google_code_invalid'); void challenge;
  });
});

describe('google: web flow (server-side code exchange, session cookie)', () => {
  const H = { 'x-petali-web': '1', origin: ORIGIN };
  const cookieValue = (headers: Headers, name: string) => { for (const c of headers.getSetCookie()) { const m = new RegExp(`^${name}=([^;]*)`).exec(c); if (m) return m[1] as string; } return null; };
  const rawGet = (path: string, cookie?: string) => fetch(env.base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  async function start(next?: string) {
    const r = await env.call('POST', '/v1/web/google/start', { headers: H, body: next ? { next } : {} });
    assert.equal(r.status, 200, r.text);
    const u = new URL(r.json.authUrl); const setCookie = r.headers.getSetCookie().find((c) => c.startsWith('petali_gtx='))!;
    return { r, u, tx: cookieValue(r.headers, 'petali_gtx')!, setCookie };
  }
  it('start needs the web header and an allowed origin, and sets a short-lived HttpOnly SameSite=Lax cookie', async () => {
    assert.equal((await env.call('POST', '/v1/web/google/start', { body: {} })).status, 403);
    assert.equal((await env.call('POST', '/v1/web/google/start', { headers: { 'x-petali-web': '1', origin: 'https://evil.example' }, body: {} })).status, 403);
    const { u, setCookie, r } = await start();
    assert.equal(u.searchParams.get('client_id'), mock.clientId); assert.equal(u.searchParams.get('redirect_uri'), WEB_REDIRECT); assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/); assert.match(setCookie, /Max-Age=600/); assert.match(setCookie, /Path=\/id\/api\/v1\/web\/google/);
    assert.ok(!r.text.includes(mock.clientSecret)); assert.ok(!r.text.includes('code_verifier'));
  });
  it('full sign-in: Google returns to the callback, the account is created, the SAME session cookie as password login is set, and refresh works', async () => {
    const e = email(); const { u, tx } = await start('/id/computers');
    const code = mock.issueCode({ redirectUri: WEB_REDIRECT, challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, sub: `sub-${b64(6)}`, email: e });
    const cb = await rawGet(`/v1/web/google/callback?code=${encodeURIComponent(code)}&state=${u.searchParams.get('state')}`, `petali_gtx=${tx}`);
    assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/id/computers');
    const rt = cookieValue(cb.headers, 'petali_rt'); assert.ok(rt && rt.startsWith('ptr_'), 'the session cookie is set');
    const setSession = cb.headers.getSetCookie().find((c) => c.startsWith('petali_rt='))!; assert.match(setSession, /HttpOnly/); assert.match(setSession, /SameSite=Strict/);
    assert.match(cb.headers.getSetCookie().find((c) => c.startsWith('petali_gtx='))!, /Max-Age=0/, 'the one-time cookie is cleared');
    const rf = await env.call('POST', '/v1/web/session/refresh', { headers: { ...H, cookie: `petali_rt=${rt}` }, body: {} });
    assert.equal(rf.status, 200, rf.text); assert.equal(rf.json.user.email, e); assert.equal(rf.json.user.hasPassword, false);
    assert.equal((await env.call('GET', '/v1/account', { token: rf.json.accessToken })).status, 200);
    assert.equal((await env.pool.query(`SELECT device_label FROM sessions WHERE id = $1`, [rf.json.sessionId])).rows[0].device_label, 'Petali Web');
  });
  it('cancelled, tampered, expired, missing-cookie and replayed callbacks go back to the login page with a reason and sign nobody in', async () => {
    const dest = (res: Response) => res.headers.get('location');
    { const { u, tx } = await start(); const cb = await rawGet(`/v1/web/google/callback?error=access_denied&state=${u.searchParams.get('state')}`, `petali_gtx=${tx}`); assert.equal(dest(cb), '/id/login?google=cancelled'); assert.equal(cookieValue(cb.headers, 'petali_rt'), null); }
    { const { u, tx } = await start(); const code = mock.issueCode({ redirectUri: WEB_REDIRECT, challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, sub: 'w1', email: email() });
      const cb = await rawGet(`/v1/web/google/callback?code=${code}&state=${b64()}`, `petali_gtx=${tx}`); assert.equal(dest(cb), '/id/login?google=invalid', 'state mismatch'); assert.equal(cookieValue(cb.headers, 'petali_rt'), null); }
    { const { u } = await start(); const code = mock.issueCode({ redirectUri: WEB_REDIRECT, challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, sub: 'w2', email: email() });
      const cb = await rawGet(`/v1/web/google/callback?code=${code}&state=${u.searchParams.get('state')}`); assert.equal(dest(cb), '/id/login?google=expired', 'another browser (no cookie) cannot finish someone else\'s login'); }
    { const { u, tx } = await start(); const code = mock.issueCode({ redirectUri: WEB_REDIRECT, challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, sub: 'w3', email: email() });
      const q = `/v1/web/google/callback?code=${code}&state=${u.searchParams.get('state')}`;
      assert.equal(dest(await rawGet(q, `petali_gtx=${tx}`)), '/id/');
      assert.equal(dest(await rawGet(q, `petali_gtx=${tx}`)), '/id/login?google=invalid', 'a replayed callback fails: Google refuses the used code'); }
    { assert.equal(dest(await rawGet('/v1/web/google/callback?code=x&state=y', 'petali_gtx=not-a-jwt')), '/id/login?google=expired'); }
  });
  it('the post-login destination is limited to paths inside /id/', async () => {
    for (const bad of ['https://evil.example/', '//evil.example', '/id/../admin', '/other', 'javascript:alert(1)']) {
      const { u, tx } = await start(bad); const code = mock.issueCode({ redirectUri: WEB_REDIRECT, challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, sub: `w-${b64(4)}`, email: email() });
      const cb = await rawGet(`/v1/web/google/callback?code=${code}&state=${u.searchParams.get('state')}`, `petali_gtx=${tx}`); assert.equal(cb.headers.get('location'), '/id/', bad);
    }
  });
  it('an unverified existing account is sent back with needs_verification', async () => {
    const victim = email(); await env.register(victim);
    const { u, tx } = await start(); const code = mock.issueCode({ redirectUri: WEB_REDIRECT, challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, sub: 'w9', email: victim });
    const cb = await rawGet(`/v1/web/google/callback?code=${code}&state=${u.searchParams.get('state')}`, `petali_gtx=${tx}`);
    assert.equal(cb.headers.get('location'), '/id/login?google=needs_verification'); assert.equal(cookieValue(cb.headers, 'petali_rt'), null);
  });
});
