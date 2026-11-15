// Phase 7 tests for Petali ID (web): Continue with Google (UI side), chart column highlighting, account features on the Settings page, navigation entry.
// Google here is MOCKED: these tests prove what the page does with the server's answers, not that real Google sign-in works.
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://petali.example/id/login', pretendToBeVisual: true });
for (const k of ['window', 'document', 'history', 'location', 'Element', 'HTMLElement', 'Node']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.indexedDB = new IDBFactory();
const { ApiError } = await import('../../id/js/api.js');
const { authView, googleButton, GOOGLE_REASONS, describeAuthError } = await import('../../id/js/views-auth.js');
const { barChart, lineChart } = await import('../../id/js/ui.js');
const { settingsView } = await import('../../id/js/views-more.js');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

describe('Continue with Google (web UI)', () => {
  const mkCtx = (googleStart) => ({ api: { googleStart }, session: { state: () => ({}), login: async () => ({}), register: async () => ({}) } });
  it('is clearly visible on the login AND the register page, above the email form, with the email option kept', () => {
    for (const mode of ['login', 'register']) {
      const v = authView(mkCtx(async () => ({})), { mode, next: '/id', search: new URLSearchParams() });
      const b = v.el.querySelector('#google-btn'); assert.ok(b, `${mode}: button`); assert.equal(txt(b), 'Continue with Google'); assert.equal(b.type, 'button');
      assert.ok(b.querySelector('svg.g-logo'), 'Google logo'); assert.ok(v.el.querySelector('form #email') && v.el.querySelector('form #password'), 'email/password form is still there');
      assert.ok(b.compareDocumentPosition(v.el.querySelector('form')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'button comes before the form');
    }
  });
  it('asks the server for the URL and opens it; the page never builds a Google URL itself', async () => {
    const seen = []; let went = null;
    const b = googleButton(mkCtx(async (n) => { seen.push(n); return { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }; }), { next: '/id/computers', show: () => {}, go: (u) => { went = u; } });
    b.click(); await tick(5);
    assert.deepEqual(seen, ['/id/computers']); assert.equal(went, 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });
  it('refuses to navigate anywhere that is not Google, and recovers', async () => {
    let went = null; const shown = [];
    const b = googleButton(mkCtx(async () => ({ authUrl: 'https://evil.example/phish' })), { next: '/id', show: (t) => shown.push(t), go: (u) => { went = u; } });
    b.click(); await tick(5);
    assert.equal(went, null); assert.equal(b.disabled, false); assert.ok(shown.some((t) => t && t.length));
  });
  it('a server without Google, an outage and a rate limit each get an honest message and the button works again', async () => {
    for (const [err, re] of [[new ApiError('x', { status: 503, code: 'google_not_configured' }), /not set up on this server yet/], [new ApiError('x', { status: 0, code: 'network_error' }), /Cannot reach the Petali server/], [new ApiError('x', { status: 429, code: 'rate_limited', retryAfter: 30 }), /Too many attempts/]]) {
      const shown = []; const b = googleButton(mkCtx(async () => { throw err; }), { next: '/id', show: (t) => shown.push(t), go: () => {} });
      b.click(); await tick(5); assert.match(shown.at(-1), re); assert.equal(b.disabled, false); assert.equal(txt(b), 'Continue with Google');
    }
  });
  it('shows what happened when Google sends the browser back (?google=...) and cleans the address bar', () => {
    for (const reason of Object.keys(GOOGLE_REASONS)) {
      history.replaceState({}, '', `/id/login?google=${reason}`);
      const v = authView(mkCtx(async () => ({})), { mode: 'login', next: '/id', search: new URLSearchParams(location.search) });
      const m = v.el.querySelector('.g-error'); assert.equal(m.hidden, false, reason); assert.equal(m.textContent, GOOGLE_REASONS[reason]); assert.equal(location.search, '', `${reason}: reason removed from the URL`);
    }
    const v = authView(mkCtx(async () => ({})), { mode: 'login', next: '/id', search: new URLSearchParams('google=<img src=x onerror=alert(1)>') });
    assert.equal(v.el.querySelector('.g-error').hidden, true, 'an unknown reason shows nothing (and never as markup)');
    assert.match(GOOGLE_REASONS.cancelled, /cancelled/i); assert.match(GOOGLE_REASONS.needs_verification, /confirm/i);
    assert.match(describeAuthError(new ApiError('x', { status: 503, code: 'google_not_configured' })), /not set up/);
  });
  it('the web app keeps its security rules: no Google secrets or client ids in the page code, CSP unchanged', () => {
    for (const f of ['id/js/views-auth.js', 'id/js/api.js', 'id/index.html']) assert.ok(!/client_secret|GOOGLE_[A-Z_]*SECRET|apps\.googleusercontent\.com/.test(read(f)), f);
    const toml = read('netlify.toml'); assert.ok(toml.includes("connect-src 'self'") && toml.includes("script-src 'self'") && !toml.includes('accounts.google.com'), 'the page never talks to Google itself');
  });
});

describe('chart column highlighting', () => {
  const rect = (svg, host) => { svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: svg.getAttribute('width') * 1, height: 150 }); Object.defineProperty(host, 'clientWidth', { value: Number(svg.getAttribute('width')), configurable: true }); };
  const ev = (type, init) => { const e = new dom.window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, init); return e; };
  const mk = () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({ label: `Day ${i + 1}`, short: String(i + 1), value: i === 4 ? null : (i + 1) * 3 }));
    const host = barChart(bars, { unitLabel: (v) => `${v} h`, ariaLabel: 'Active hours' }); document.body.append(host);
    const svg = host.querySelector('svg'); rect(svg, host); return { host, svg, bars };
  };
  const colX = (svg, i) => (6 + (i + 0.5) * ((svg.getAttribute('width') - 12) / 10));
  it('hover highlights the column under the pointer and dims the others; leaving restores everything', () => {
    const { svg } = mk(); const band = svg.querySelector('.chart-band'); const bars = [...svg.querySelectorAll('.bar, .bar-none')];
    assert.ok(!band.classList.contains('on')); assert.ok(!svg.classList.contains('has-active'));
    svg.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: colX(svg, 2) }));
    assert.ok(band.classList.contains('on')); assert.ok(svg.classList.contains('has-active'));
    const w = (svg.getAttribute('width') - 12) / 10; assert.ok(Math.abs(Number(band.getAttribute('x')) - (6 + 2 * w)) < 0.01, 'the band sits exactly on column 3'); assert.ok(Math.abs(Number(band.getAttribute('width')) - w) < 0.01);
    assert.deepEqual(bars.map((b, i) => b.classList.contains('is-active') ? i : -1).filter((i) => i >= 0), [2], 'only the hovered bar is active');
    svg.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: colX(svg, 7) }));
    assert.equal(bars.filter((b) => b.classList.contains('is-active')).length, 1); assert.ok(bars[7].classList.contains('is-active'));
    svg.dispatchEvent(ev('pointerleave', { pointerType: 'mouse' }));
    assert.ok(!band.classList.contains('on')); assert.ok(!svg.classList.contains('has-active')); assert.equal(svg.querySelectorAll('.is-active').length, 0);
    assert.equal(svg.parentElement.querySelector('.chart-tip').hidden, true);
  });
  it('a column without data can be highlighted too (and says so), and a pointer outside the plot highlights nothing', () => {
    const { svg, host } = mk(); const tip = host.querySelector('.chart-tip');
    svg.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: colX(svg, 4) })); assert.ok(svg.querySelector('.chart-band').classList.contains('on')); assert.match(txt(tip), /Day 5.*No data/);
    svg.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: 2 })); assert.ok(!svg.querySelector('.chart-band').classList.contains('on'));
  });
  it('touch: a tap selects the column and shows its value, tapping it again or anywhere else clears it; the finger lifting does not', () => {
    const { svg, host } = mk(); const band = svg.querySelector('.chart-band'); const tip = host.querySelector('.chart-tip');
    svg.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: colX(svg, 6) })); svg.dispatchEvent(ev('pointerleave', { pointerType: 'touch' }));
    assert.ok(band.classList.contains('on'), 'stays after the finger leaves'); assert.equal(tip.hidden, false); assert.match(txt(tip), /Day 7.*21 h/);
    svg.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: colX(svg, 1) })); assert.match(txt(tip), /Day 2.*6 h/);
    svg.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: colX(svg, 1) })); assert.ok(!band.classList.contains('on'), 'tapping the selected column again clears it');
    svg.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: colX(svg, 3) })); assert.ok(band.classList.contains('on'));
    document.body.dispatchEvent(ev('pointerdown', { pointerType: 'touch' })); assert.ok(!band.classList.contains('on'), 'tapping outside clears it');
  });
  it('keyboard: arrows, Home, End and Escape work on the focused chart; blur clears', () => {
    const { svg, host } = mk(); const band = svg.querySelector('.chart-band'); const key = (k) => svg.dispatchEvent(ev('keydown', { key: k }));
    assert.equal(svg.getAttribute('tabindex'), '0'); key('Home'); assert.match(txt(host.querySelector('.chart-tip')), /Day 1/); key('ArrowRight'); key('ArrowRight'); assert.match(txt(host.querySelector('.chart-tip')), /Day 3/);
    key('End'); assert.match(txt(host.querySelector('.chart-tip')), /Day 10/); key('Escape'); assert.ok(!band.classList.contains('on'));
    key('Home'); svg.dispatchEvent(ev('blur', {})); assert.ok(!band.classList.contains('on'));
  });
  it('existing data, labels and native tooltips are untouched, and the interaction changes no size or position', () => {
    const { svg, host, bars } = mk(); const before = { w: svg.getAttribute('width'), h: svg.getAttribute('height'), vb: svg.getAttribute('viewBox'), kids: svg.children.length, hostKids: host.children.length };
    const titles = [...svg.querySelectorAll('.bar title, .bar-none title')].map((t) => t.textContent); assert.deepEqual(titles, bars.map((b) => `${b.label}: ${typeof b.value === 'number' ? `${b.value} h` : 'no data'}`));
    assert.equal(svg.getAttribute('role'), 'img'); assert.equal(svg.getAttribute('aria-label'), 'Active hours');
    const rects = () => [...svg.querySelectorAll('.bar')].map((r) => ['x', 'y', 'width', 'height'].map((a) => r.getAttribute(a)).join(','));
    const geo = rects();
    for (let i = 0; i < 10; i += 1) svg.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: colX(svg, i) })); svg.dispatchEvent(ev('pointerleave', { pointerType: 'mouse' }));
    assert.deepEqual(rects(), geo, 'no bar moved or resized'); assert.deepEqual({ w: svg.getAttribute('width'), h: svg.getAttribute('height'), vb: svg.getAttribute('viewBox'), kids: svg.children.length, hostKids: host.children.length }, before, 'same size, same number of nodes');
    assert.ok([...svg.querySelectorAll('text.axis')].length > 0, 'axis labels are still drawn');
  });
  it('line charts (health history, performance) get the same interaction: guide line, focus dot and readout', () => {
    const pts = Array.from({ length: 8 }, (_, i) => ({ label: `Month ${i + 1}`, short: `M${i + 1}`, avg: 20 + i * 5, max: 40 + i * 5 }));
    const host = lineChart(pts, { unit: '%', ariaLabel: 'CPU' }); document.body.append(host); const svg = host.querySelector('svg'); rect(svg, host);
    const x = (i) => 6 + (i / 7) * (svg.getAttribute('width') - 12);
    svg.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: x(3) + 2 }));
    assert.ok(svg.querySelector('.chart-guide').classList.contains('on')); const f = svg.querySelector('.chart-focus'); assert.ok(f.classList.contains('on')); assert.ok(Math.abs(Number(f.getAttribute('cx')) - x(3)) < 0.5);
    assert.match(txt(host.querySelector('.chart-tip')), /Month 4.*35%.*average.*55%.*peak/); assert.equal(svg.querySelectorAll('circle.dot title').length, 8, 'native tooltips on the dots are kept');
    svg.dispatchEvent(ev('pointerleave', { pointerType: 'mouse' })); assert.ok(!svg.querySelector('.chart-guide').classList.contains('on')); assert.ok(!f.classList.contains('on'));
  });
  it('Day and Night themes both define the highlight (same tokens as the desktop Statistics band) and nothing changes layout', () => {
    const css = read('id/css/app.css');
    assert.match(css, /\.chart \.chart-band\{fill:color-mix\(in srgb,var\(--ink\) 7%,transparent\)/, 'the desktop .sv-band recipe: 7% of the ink colour, which differs per theme');
    assert.match(css, /html\.night\{--ink:#e5f0ea/); assert.match(css, /--ink:#17312c/);
    const rules = css.slice(css.indexOf('Phase 7: chart column highlighting'));
    assert.ok(!/(^|[;{}])\s*(width|height|margin|padding|top|left|display)\s*:/.test(rules.split('.chart-tip{')[0].replace(/\.chart-wrap\{position:relative\}/, '')), 'no sizing property on the highlight states');
    assert.match(rules, /\.chart-tip\{position:absolute/, 'the readout is absolutely positioned: it cannot push the layout');
  });
});

describe('Settings: the account features the desktop app already had', () => {
  const mkCtx = ({ user, events = [], settings = { securityAlerts: true } }) => {
    const calls = []; const mem = { theme: 'auto' };
    return { calls, language: 'en', onlineNow: () => true, installInfo: { isStandalone: () => false, isIos: () => false, canPrompt: () => false, prompt() {} },
      theme: { getSchedule: () => ({ from: '22:00', to: '06:00' }), hasCustomSchedule: () => false, getMode: () => mem.theme, setMode: (m) => { mem.theme = m; } },
      cache: { del: async () => {}, wipeAll: async () => {} },
      session: { state: () => ({ status: 'authenticated', user }), userId: () => user.petaliId, logout: async () => {}, updateUser: (u) => calls.push(['updateUser', u]) },
      api: { forget() {}, get: async (p) => { calls.push(['GET', p]); if (p === '/v1/account') return { user }; if (p === '/v1/account/sessions') return { sessions: [{ id: 's1', current: true, deviceLabel: 'Petali Web', lastUsedAt: new Date().toISOString() }] }; if (p === '/v1/account/settings') return { settings }; if (p.startsWith('/v1/account/security-events')) return { events }; throw new Error(p); },
        patch: async (p, b) => { calls.push(['PATCH', p, b]); return { user }; }, put: async (p, b) => { calls.push(['PUT', p, b]); return { user }; }, post: async (p, b) => { calls.push(['POST', p, b]); return { user: { ...user, deletionRequestedAt: new Date().toISOString() } }; }, del: async (p) => { calls.push(['DELETE', p]); return { user }; } } };
  };
  const base = { petaliId: 'PTL-ABCD-EFGH-JKMN', email: 'a@example.com', emailVerified: true, displayName: 'Ann', createdAt: '2026-10-01T10:00:00Z', hasPassword: true, deletionRequestedAt: null };
  const open = async (ctx) => { const v = settingsView(ctx); document.body.append(v.el); await tick(30); return v; };
  it('a password account shows Petali ID with Copy, sign-in method, security alerts, change email, change password, activity and deletion', async () => {
    const ctx = mkCtx({ user: base, events: [{ type: 'login', detail: 'google (linked)', ipAddress: '1.2.3.4', createdAt: '2026-11-01T10:00:00Z' }, { type: 'password_changed', detail: null, ipAddress: null, createdAt: '2026-11-02T10:00:00Z' }] });
    const v = await open(ctx); const t = txt(v.el);
    for (const s of ['PTL-ABCD-EFGH-JKMN', 'Copy', 'Email and password', 'Security alerts', 'Change email', 'Change password', 'Recent activity', 'Signed in with Google', 'Password changed', 'Delete account', 'Request deletion']) assert.ok(t.includes(s), `missing: ${s}`);
    v.el.querySelector('#sec-alerts').checked = false; v.el.querySelector('#sec-alerts').dispatchEvent(new dom.window.Event('change')); await tick(5);
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'PATCH'), ['PATCH', '/v1/account/settings', { securityAlerts: false }]);
  });
  it('change email sends the current password and the new address; deletion needs the password and can be cancelled', async () => {
    const ctx = mkCtx({ user: base }); const v = await open(ctx);
    v.el.querySelector('#em1').value = ' new@example.com '; v.el.querySelector('#em2').value = 'secret-pass-1';
    [...v.el.querySelectorAll('button')].find((b) => txt(b) === 'Change email').click(); await tick(5);
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'PUT'), ['PUT', '/v1/account/email', { newEmail: 'new@example.com', currentPassword: 'secret-pass-1' }]);
    [...v.el.querySelectorAll('button')].find((b) => txt(b) === 'Request deletion').click(); await tick(5); assert.ok(!ctx.calls.some((c) => c[0] === 'POST'), 'no request without a password');
    v.el.querySelector('#del-pw').value = 'secret-pass-1'; [...v.el.querySelectorAll('button')].find((b) => txt(b) === 'Request deletion').click(); await tick(5);
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'POST'), ['POST', '/v1/account/deletion-request', { password: 'secret-pass-1' }]);
    const pend = await open(mkCtx({ user: { ...base, deletionRequestedAt: '2026-11-10T10:00:00Z' } })); const c2 = [...pend.el.querySelectorAll('button')].find((b) => txt(b) === 'Cancel the request'); assert.ok(c2);
  });
  it('a Google-created account sees what is true: signs in with Google, no password forms, no deletion form that could never work', async () => {
    const v = await open(mkCtx({ user: { ...base, hasPassword: false } })); const t = txt(v.el);
    assert.ok(t.includes('Google') && t.includes('has no Petali password')); assert.ok(!v.el.querySelector('#pw0') && !v.el.querySelector('#em1') && !v.el.querySelector('#del-pw'));
    assert.ok(t.includes('Security alerts') && t.includes('Recent activity') && t.includes('Signed-in sessions'), 'everything that works without a password is still there');
  });
});

describe('navigation entry on the website', () => {
  const html = read('index.html');
  it('the top navigation says Petali ID, links to /id/, is styled apart from the other links, and has hover / focus / active states', () => {
    const m = /<a href="\/id\/" class="nav-id"[^>]*>([\s\S]*?)<\/a>/.exec(html); assert.ok(m, 'nav-id link'); assert.match(m[1].replace(/<[^>]+>/g, '').trim(), /^Petali ID$/);
    assert.ok(!/class="nav-open"/.test(html) && !/>Open Petali</.test(html), 'the old "Open Petali" entry is gone');
    for (const sel of ['a.nav-id{', 'a.nav-id:hover', 'a.nav-id:focus-visible', 'a.nav-id:active']) assert.ok(html.includes(sel), sel);
    const nav = html.slice(html.indexOf('id="navLinks"'), html.indexOf('</nav>')); assert.ok(nav.indexOf('nav-id') > nav.indexOf('feedback.html') && nav.indexOf('nav-id') < nav.indexOf('#download'), 'sits right before Download');
    assert.match(html, /max-width:960px\)\{\s*\.nav-links a\.nav-id\{width:100%/, 'full-width in the mobile menu');
    assert.equal((html.match(/href="\/id\/"/g) || []).length, 2);
  });
});
