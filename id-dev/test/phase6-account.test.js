// Phase 6 regression tests for the Petali ID account experience: password rule, verification page and strip, resend, register form, computers.
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { describe, it, before, beforeEach } from 'node:test';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://petali.example/id/' });
for (const k of ['window', 'document', 'history', 'location', 'Element', 'HTMLElement', 'Node']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
globalThis.indexedDB = new IDBFactory();
const { PASSWORD_MIN, PASSWORD_MAX, passwordProblem } = await import('../../id/js/auth-rules.js');
const { ApiError } = await import('../../id/js/api.js');
const { authView, verifyView, verificationNotice, resendButton, RESEND_TEXT, forgetRecentVerification } = await import('../../id/js/views-auth.js');
const { matchRoute, safeReturnPath } = await import('../../id/js/router.js');
const { computersView, rememberCurrentComputer, currentComputerId, shownStatus } = await import('../../id/js/views-main.js');
const { createCache } = await import('../../id/js/cache.js');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();

describe('password rule (client copy; the server is authoritative)', () => {
  it('6 characters are rejected, 7 accepted, counting characters not UTF-16 units', () => {
    assert.equal(PASSWORD_MIN, 7); assert.match(passwordProblem('abc12!'), /at least 7/); assert.equal(passwordProblem('abc123!'), null);
    assert.ok(passwordProblem('🌿🌿🌿🌿🌿🌿')); assert.equal(passwordProblem('🌿🌿🌿🌿🌿🌿🌿'), null);
    assert.ok(passwordProblem('       ')); assert.ok(passwordProblem('x'.repeat(PASSWORD_MAX + 1))); assert.ok(passwordProblem(''));
  });
  it('the register form carries the same rule, the login form never applies it', () => {
    const mkCtx = () => ({ session: { state: () => ({}), register: async () => ({}), login: async () => ({}) }, });
    const reg = authView(mkCtx(), { mode: 'register', next: '/id' }); const pw = reg.el.querySelector('#password');
    assert.equal(pw.getAttribute('minlength'), '7'); assert.match(txt(reg.el), /At least 7 characters/);
    const login = authView(mkCtx(), { mode: 'login', next: '/id' }); assert.equal(login.el.querySelector('#password').getAttribute('minlength'), '1');
  });
  it('a 6-character password is stopped with a clear message and never sent; a 7-character one is sent', async () => {
    const calls = []; const ctx = { session: { state: () => ({}), register: async (e, p, n) => { calls.push([e, p]); return { emailVerification: { sent: true, required: false } }; } }, };
    const v = authView(ctx, { mode: 'register', next: '/id' }); const f = v.el.querySelector('form');
    v.el.querySelector('#email').value = 'a@example.com'; v.el.querySelector('#password').value = 'abc12!'; f.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick();
    assert.equal(calls.length, 0); const err = v.el.querySelector('.form-error'); assert.equal(err.hidden, false); assert.match(err.textContent, /at least 7/i); assert.equal(v.el.querySelector('#password').getAttribute('aria-invalid'), 'true');
    v.el.querySelector('#password').value = 'abc123!'; f.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick();
    assert.deepEqual(calls, [['a@example.com', 'abc123!']]);
  });
  it('the server\'s weak-password answer is shown when it disagrees with the client', async () => {
    const ctx = { session: { state: () => ({}), register: async () => { throw new ApiError('That password is too weak. Use at least 7 characters and nothing common.', { status: 400, code: 'weak_password' }); } }, };
    const v = authView(ctx, { mode: 'register', next: '/id' }); v.el.querySelector('#email').value = 'a@example.com'; v.el.querySelector('#password').value = '1234567'; v.el.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick();
    assert.match(v.el.querySelector('.form-error').textContent, /too weak/);
  });
});

describe('what the UI says about the registration email is only what really happened', () => {
  it('sent / server not configured / delivery failed / nothing known', () => {
    assert.equal(verificationNotice({ sent: true }, 'a@b.cz').kind, 'ok'); assert.match(verificationNotice({ sent: true }, 'a@b.cz').text, /a@b\.cz/);
    { const n = verificationNotice({ sent: false, reason: 'not_configured' }, 'a@b.cz'); assert.equal(n.kind, 'ok'); assert.ok(!/we sent/i.test(n.text), n.text); }   /* 1.5.0 has no email service: expected state, not a failure */
    for (const info of [{ sent: false, reason: 'delivery_failed' }, { sent: false }]) { const n = verificationNotice(info, 'a@b.cz'); assert.equal(n.kind, 'warn'); assert.ok(!/we sent/i.test(n.text), n.text); }
    assert.match(verificationNotice({ sent: false, reason: 'not_configured' }).text, /no confirmation message was sent/); assert.equal(verificationNotice(undefined), null);
  });
});

describe('/id/verify page', () => {
  beforeEach(() => forgetRecentVerification());
  const mkCtx = ({ post, authed = false, get } = {}) => { const calls = []; return { calls, api: { post: async (p, b, o) => { calls.push(['POST', p, b, o]); return post(p, b); }, get: async (p) => { calls.push(['GET', p]); return get ? get(p) : { user: { emailVerified: true } }; } }, session: { state: () => ({ status: authed ? 'authenticated' : 'anonymous' }), updateUser: (u) => calls.push(['updateUser', u.emailVerified]) } }; };
  const open = async (ctx, token = 'x'.repeat(40)) => { history.replaceState({}, '', `/id/verify?token=${token}`); const v = verifyView(ctx, { search: new URLSearchParams(location.search) }); await tick(20); return v; };
  it('verifies, removes the token from the address bar, and refreshes the signed-in user', async () => {
    const ctx = mkCtx({ authed: true, post: async () => ({ status: 'verified', email: 'a@b.cz' }) }); const v = await open(ctx);
    assert.equal(location.search, ''); assert.equal(location.pathname, '/id/verify'); assert.match(txt(v.el), /Email confirmed/); assert.deepEqual(ctx.calls[0].slice(0, 3), ['POST', '/v1/auth/verify-email', { token: 'x'.repeat(40) }]); assert.equal(ctx.calls[0][3].auth, false);
    assert.ok(ctx.calls.some((c) => c[0] === 'updateUser' && c[1] === true)); assert.equal(v.el.querySelector('a.btn').getAttribute('href'), '/id/');
  });
  it('refreshing the signed-in user re-renders the route without the token: the success is still shown (real-browser regression)', async () => {
    let second = null; const ctx = mkCtx({ authed: true, post: async () => ({ status: 'verified', email: 'a@b.cz' }) });
    ctx.session.updateUser = (u) => { ctx.calls.push(['updateUser', u.emailVerified]); second = verifyView(ctx, { search: new URLSearchParams('') }); };   // what app.js does on a state change
    const first = await open(ctx, 'w'.repeat(40)); await tick(20);
    assert.ok(second, 'the app re-created the view'); assert.match(txt(second.el), /Email confirmed/); assert.ok(!/incomplete/.test(txt(second.el))); assert.match(txt(first.el), /Email confirmed/);
  });
  it('an already confirmed link says so', async () => { const v = await open(mkCtx({ post: async () => ({ status: 'already_verified' }) })); assert.match(txt(v.el), /Already confirmed/); assert.equal(v.el.querySelector('a.btn').getAttribute('href'), '/id/login'); });
  it('expired: says so and offers a new link (signed in) or sign-in (signed out)', async () => {
    const err = () => { throw new ApiError('expired', { status: 400, code: 'verification_expired' }); };
    const a = await open(mkCtx({ authed: true, post: err })); assert.match(txt(a.el), /link has expired/); assert.ok([...a.el.querySelectorAll('button')].some((b) => /Send a new link/.test(b.textContent)));
    const b = await open(mkCtx({ authed: false, post: err })); assert.match(txt(b.el), /Sign in to Petali ID, then ask for a new link/); assert.ok(![...b.el.querySelectorAll('button')].length);
  });
  it('invalid and malformed links never claim success', async () => {
    const bad = await open(mkCtx({ post: async () => { throw new ApiError('no', { status: 400, code: 'verification_invalid' }); } })); assert.match(txt(bad.el), /not valid/); assert.ok(!/confirmed/i.test(txt(bad.el)));
    history.replaceState({}, '', '/id/verify'); const none = verifyView(mkCtx(), { search: new URLSearchParams('') }); await tick(10); assert.match(txt(none.el), /incomplete/);
  });
  it('a network failure is retried (cold start), then says nothing was changed and offers Try again, which works once the server is back', async () => {
    let up = false; let n = 0; const ctx = mkCtx({ post: async () => { n += 1; if (!up) throw new ApiError('down', { status: 0, code: 'network_error' }); return { status: 'verified' }; } });
    const v = verifyView(ctx, { search: new URLSearchParams('token=' + 'y'.repeat(40)), delays: [1, 1, 1] }); await tick(60);
    assert.equal(n, 4); assert.match(txt(v.el), /Cannot confirm right now/); assert.match(txt(v.el), /Nothing was changed/); assert.ok(!/confirmed/i.test(txt(v.el).replace('Cannot confirm', '')));
    up = true; [...v.el.querySelectorAll('button')].find((b) => /Try again/.test(b.textContent)).click(); await tick(30); assert.match(txt(v.el), /Email confirmed/);
  });
  it('a rate-limited or timed-out answer is treated as temporary, not as an invalid link', async () => {
    const v = verifyView(mkCtx({ post: async () => { throw new ApiError('slow', { status: 429, code: 'rate_limited' }); } }), { search: new URLSearchParams('token=' + 'q'.repeat(40)), delays: [1, 1, 1] }); await tick(30);
    assert.match(txt(v.el), /Cannot confirm right now/); assert.ok(!/not valid/.test(txt(v.el)));
  });
});

describe('resend button', () => {
  const press = async (post, get) => { let outcome = null; const ctx = { api: { post, get: get || (async () => ({ user: { emailVerified: true } })) }, session: { updateUser() {} } }; const b = resendButton(ctx, { onDone: (k, t) => { outcome = [k, t]; } }); b.click(); await tick(10); return { b, outcome }; };
  it('success is reported only after the server answered 200, and the button stays disabled for a minute', async () => { const { b, outcome } = await press(async () => ({ sent: true })); assert.equal(outcome[0], 'ok'); assert.equal(b.disabled, true); });
  it('each failure gets its own honest message and re-enables the button', async () => {
    for (const code of ['resend_too_soon', 'email_not_configured', 'email_delivery_failed']) { const { b, outcome } = await press(async () => { throw new ApiError('x', { status: 429, code }); }); assert.equal(outcome[0], 'bad'); assert.equal(outcome[1], RESEND_TEXT[code]); assert.equal(b.disabled, false); }
    const { outcome } = await press(async () => { throw new ApiError('x', { status: 0, code: 'network_error' }); }); assert.match(outcome[1], /Nothing was sent/);
  });
});

describe('routes', () => {
  it('/id/verify is public and reachable while signed in; it is never a "return to" target', () => {
    const r = matchRoute('/id/verify'); assert.equal(r.name, 'verify'); assert.equal(r.public, true); assert.equal(r.always, true); assert.equal(safeReturnPath('/id/verify?token=abc'), null);
  });
});

describe('computers: current computer marker and management', () => {
  const U = 'user-1'; const D1 = '3f2b8c1e-5d4a-4e7b-9a10-1c2d3e4f5a6b'; const D2 = '9a8b7c6d-1111-4222-8333-444455556666';
  let cache; before(() => { cache = createCache(); });
  const ctxFor = (userId) => ({ cache, session: { userId: () => userId } });
  it('remembers the computer the desktop app opened the page from (this account only) and ignores anything that is not a computer id', async () => {
    await rememberCurrentComputer(ctxFor(U), new URLSearchParams(`current=${D1}`)); assert.equal(await currentComputerId(ctxFor(U)), D1);
    assert.equal(await currentComputerId(ctxFor('someone-else')), null);                        // another account never sees it
    await rememberCurrentComputer(ctxFor(U), new URLSearchParams('current=<script>')); assert.equal(await currentComputerId(ctxFor(U)), D1);   // junk is ignored
    await rememberCurrentComputer(ctxFor(U), new URLSearchParams(`current=${D2.toUpperCase()}`)); assert.equal(await currentComputerId(ctxFor(U)), D2);
  });
  it('the list marks only that computer, lists the rest, and links every row to its own management page', async () => {
    await rememberCurrentComputer(ctxFor(U), new URLSearchParams(`current=${D1}`));
    const devices = { devices: [{ id: D2, name: 'Laptop', status: 'stale', removed: false, hardware: { cpu: 'i5' }, lastSyncAt: new Date().toISOString() }, { id: D1, name: 'Desk PC', status: 'active', removed: false, lastSyncAt: null }, { id: 'gone', name: 'Old', status: 'removed', removed: true }] };
    const ctx = { cache, session: { userId: () => U }, data: { watch: (key, path, cb) => { setTimeout(() => cb({ data: devices, loading: false, cached: false }), 0); return { stop() {}, reload() {} }; } } };
    const v = computersView(ctx, { search: new URLSearchParams('') }); await tick(30);
    const rows = [...v.el.querySelectorAll('a.row-computer')]; assert.equal(rows.length, 3);
    assert.equal(v.el.querySelectorAll('.pill-this').length, 1); assert.match(txt(rows[0]), /Desk PC.*This computer/);       // the current one is listed first
    assert.equal(rows[0].getAttribute('href'), `/id/computers/${D1}`); assert.ok(rows.every((r) => /^\/id\/computers\//.test(r.getAttribute('href'))));
    assert.match(txt(v.el), /2 computers/); assert.match(txt(v.el), /Removed computers/); assert.match(txt(v.el), /Never synchronised/);
  });
  it('a computer that never uploaded anything is not shown as "Syncing now"', () => { assert.equal(shownStatus({ status: 'active', lastSyncAt: null }), 'never'); assert.equal(shownStatus({ status: 'active', lastSyncAt: '2026-11-12T10:00:00Z' }), 'active'); assert.equal(shownStatus({ status: 'offline', lastSyncAt: null }), 'offline'); });
  it('an empty account gets a clear empty state, not a blank page', async () => {
    const ctx = { cache, session: { userId: () => 'empty-user' }, data: { watch: (k, p, cb) => { setTimeout(() => cb({ data: { devices: [] }, loading: false }), 0); return { stop() {}, reload() {} }; } } };
    const v = computersView(ctx, { search: new URLSearchParams('') }); await tick(30); assert.match(txt(v.el), /No computers connected/); assert.ok(v.el.querySelector('a[href="/#download"]'));
  });
});

describe('version metadata is 1.5.0 everywhere an application version is defined', () => {
  const root = new URL('../../../', import.meta.url); const read = (p) => readFileSync(new URL(p, root), 'utf8'); const has = (p) => existsSync(new URL(p, root));
  it('Petali ID: version.js, service worker cache name, and the web build', async () => { assert.equal((await import('../../id/js/version.js')).APP_VERSION, '1.5.0'); assert.match(read('landing-page-and-petali-id/id/sw.js'), /const VERSION = 'v4-1\.5\.0'/); });
  it('desktop, helper, backend (checked when those sources are next to the web project)', () => {
    if (!has('app-and-cloud/package.json')) return;
    assert.equal(JSON.parse(read('app-and-cloud/package.json')).version, '1.5.0');
    const lock = JSON.parse(read('app-and-cloud/package-lock.json')); assert.equal(lock.version, '1.5.0'); assert.equal(lock.packages[''].version, '1.5.0');
    assert.match(read('app-and-cloud/sensor-helper/PetaliSensorHelper.csproj'), /<Version>1\.5\.0<\/Version>/);
    assert.equal(JSON.parse(read('app-and-cloud/cloud/package.json')).version, '1.5.0'); assert.match(read('app-and-cloud/cloud/src/http/app.ts'), /SERVICE_VERSION = '1\.5\.0'/);
    const b = JSON.parse(read('app-and-cloud/package.json')).build; assert.equal(b.appId, 'com.milanfridrich.petali'); assert.equal(b.productName, 'Petali'); assert.match(b.nsis.artifactName, /\$\{version\}/);   // unrelated metadata untouched
  });
  it('no dependency, Electron or Node version was changed by the version bump', () => {
    if (!has('app-and-cloud/package.json')) return; const p = JSON.parse(read('app-and-cloud/package.json'));
    assert.match(p.devDependencies.electron, /^[\^~]?3[0-9]\./); assert.ok(p.dependencies.systeminformation);
  });
});

describe('the registration notice is recorded BEFORE the session is adopted (so the first banner already says what happened)', () => {
  it('session.register calls beforeAdopt with the server answer before any state change', async () => {
    const { createSession } = await import('../../id/js/session.js'); const order = [];
    const api = { register: async () => ({ user: { petaliId: 'P', email: 'e@x.cz' }, accessToken: 't', accessTokenExpiresAt: new Date(Date.now() + 9e5).toISOString(), emailVerification: { sent: true } }), forget() {}, hasToken: () => true };
    const cache = { setMeta: async () => {}, getMeta: async () => null, wipeAll: async () => {}, del: async () => {} };
    const s = createSession({ api, cache, beforeAdopt: (r) => order.push(['before', r.emailVerification.sent]), onChange: (st) => order.push(['change', st.status]) });
    await s.register('e@x.cz', 'abc123!'); assert.deepEqual(order[0], ['before', true]); assert.ok(order.some((o) => o[0] === 'change' && o[1] === 'authenticated'));
  });
});

describe('the signed-out header (real-browser regression: it used to print the text "null" and show an empty tab bar)', () => {
  it('app.js never passes null to Element.append in the header, and a hidden tab bar is really hidden', () => {
    const app = readFileSync(new URL('../../id/js/app.js', import.meta.url), 'utf8'); assert.ok(!/\) : null\);\s*\n\s*clear\(shell\.nav\)/.test(app)); assert.match(app, /\.\.\.\(authed && st\.user \?/);
    assert.match(readFileSync(new URL('../../id/css/app.css', import.meta.url), 'utf8'), /\.tabbar\[hidden\]\{display:none\}/);
  });
});
