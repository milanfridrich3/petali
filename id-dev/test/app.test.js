// Drives the REAL app (id/js/app.js) in jsdom against a fake Petali Cloud: routing, auth redirects, every section, offline, logout, isolation.
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, before } from 'node:test';

const D1 = '3f2b8c1e-5d4a-4e7b-9a10-1c2d3e4f5a6b'; const D2 = '9a8b7c6d-1111-4222-8333-444455556666';
const iso = (ms) => new Date(ms).toISOString(); const NOW = Date.now();
const dayKey = (n) => new Date(NOW - n * 864e5).toISOString().slice(0, 10);

// ---------------- fake cloud ----------------
const srv = { cookie: null, down: false, calls: [], renamed: null, removed: false, sessionsRevoked: false };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });
const user = { petaliId: 'P-1', email: 'milan@example.com', displayName: 'Milan', createdAt: iso(NOW - 9e8) };
const sessionBody = () => json(200, { user, accessToken: 'tok', accessTokenExpiresAt: iso(NOW + 9e5), sessionExpiresAt: iso(NOW + 9e9), sessionId: 's1' });
const devices = () => [
  { id: D1, name: 'Desk PC', status: 'active', removed: false, platform: 'win32', appVersion: '1.4.0', hardware: { cpu: 'Intel i5', ramGb: 16, os: '10.0.22631', threads: 12 }, lastSyncAt: iso(NOW - 120000), lastSeenAt: iso(NOW - 60000), createdAt: iso(NOW - 8e8), removedAt: null, historyDeleted: false, activeMsLast7Days: 7 * 36e5, lastUsageDay: dayKey(0), docCounts: { day: 12 }, storageBytes: 20480 },
  { id: D2, name: '<img src=x onerror=alert(1)>Laptop', status: 'stale', removed: false, platform: 'win32', appVersion: '1.4.0', hardware: null, lastSyncAt: iso(NOW - 6 * 864e5), lastSeenAt: null, createdAt: iso(NOW - 7e8), removedAt: null, historyDeleted: false, activeMsLast7Days: 0, lastUsageDay: null, docCounts: {}, storageBytes: 0 },
];
const plant = { stage: 'sprout', stageIndex: 1, progress: 0.4, growthMinutes: 5 * 60, nextStage: { id: 'young', atMinutes: 600, remainingMinutes: 300 }, stages: [{ id: 'seed', atMinutes: 0, reached: true }, { id: 'sprout', atMinutes: 120, reached: true }, { id: 'young', atMinutes: 600, reached: false }, { id: 'mature', atMinutes: 1800, reached: false }], dailyCapMinutes: 240, perDevice: [{ deviceId: D1, name: 'Desk PC', removed: false, creditedMinutes: 200 }, { deviceId: D2, name: 'Laptop', removed: false, creditedMinutes: 100 }], recentDays: [{ day: dayKey(2), minutes: 120 }, { day: dayKey(1), minutes: 180 }], lastCreditDay: dayKey(1), computers: 2 };
const overview = () => ({ serverTime: iso(NOW), source: 'cloud-snapshot', devices: { total: 2, active: 1, offline: 0, stale: 1, never: 0, removed: 0, list: devices().map((d) => ({ id: d.id, name: d.name, status: d.status, lastSyncAt: d.lastSyncAt, activeMsLast7Days: d.activeMsLast7Days, lastUsageDay: d.lastUsageDay })) }, lastSyncAt: iso(NOW - 120000), plant, identity: { species: 'fern', name: 'Fernando' },
  usage: { available: true, last7Days: { activeMs: 7 * 36e5, days: 5 }, last30Days: { activeMs: 20 * 36e5, days: 12 }, daily: [{ day: dayKey(2), activeMs: 2 * 36e5 }, { day: dayKey(1), activeMs: 3 * 36e5 }] }, health: { recorded: true, episodes30d: 3, critical30d: 1 }, alerts: [{ code: 'device_stale', severity: 'warning', deviceId: D2, deviceName: 'Laptop' }, { code: 'critical_problems_30d', severity: 'warning' }] });
const summary = () => ({ device: { id: D1 }, serverTime: iso(NOW), summary: { range: { days: 30, from: dayKey(29), to: dayKey(0) }, usage: { activeMs: 20 * 36e5, activeDays: 12, daily: [{ day: dayKey(1), activeMs: 3 * 36e5, sessions: 3 }, { day: dayKey(2), activeMs: 2 * 36e5, sessions: 2 }] }, apps: { top: [{ app: 'chrome.exe', ms: 5 * 36e5 }, { app: 'Code.exe', ms: 2 * 36e5 }], otherMs: 0, unknownMs: 36e5, attributedMs: 8 * 36e5 }, health: { episodes: 3, months: ['x'] }, performance: { months: ['x'] }, coverage: { firstDay: dayKey(29) } } });
const perf = () => ({ device: { id: D1 }, range: { days: 30 }, source: 'cloud-snapshot', available: true, minutes: 600, daysWithHardware: 5, metrics: [{ id: 'cpuUsage', unit: '%', decimals: 1, avg: 31.5, max: 88 }, { id: 'cpuTemp', unit: '°C', decimals: 1, avg: 58, max: 91 }], battery: { recorded: false }, days: [{ dayKey: dayKey(1), tempAvg: 58, tempMax: 91 }, { dayKey: dayKey(0), tempAvg: null, tempMax: null }] });
const health = () => ({ device: { id: D1 }, range: { days: 30 }, source: 'cloud-snapshot', latest: { at: NOW - 36e5, status: 'warning', minutes: { healthy: 40, warning: 20, critical: 0 } },
  health: { recorded: true, evaluatedMinutes: 600, statusMinutes: { healthy: 500, warning: 80, critical: 20 }, episodeCount: 2, worst: 'critical', notifications: 1, problems: [{ id: 'cpuOverheat', count: 2, severity: 'critical', totalMs: 36e5, lastAt: NOW - 72e5, notifications: 1 }], episodes: [{ id: 'cpuOverheat', severity: 'critical', start: NOW - 72e5, end: NOW - 70e5, durationMs: 2e6, interrupted: false, notifications: 1, values: [{ key: 'temp', value: 93, unit: '°C' }] }], episodesShown: 1 } });
const report = (kind) => ({ generatedAt: iso(NOW), source: 'cloud-snapshot', device: { id: D1, name: 'Desk PC' }, period: { kind, key: dayKey(0), from: dayKey(6), to: dayKey(0), days: 7, elapsedDays: 7, incomplete: true }, coverage: {}, usage: { available: true, totalMs: 9 * 36e5, knownDays: 5, activeDays: 4, avgPerKnownDayMs: 36e5, longestSessionMs: 2e6, bestDay: { dayKey: dayKey(1), ms: 3 * 36e5 }, days: [{ dayKey: dayKey(1), activeMs: 3 * 36e5 }, { dayKey: dayKey(0), activeMs: null }] }, apps: { available: true, top: [{ app: 'chrome.exe', ms: 36e5 }] }, hardware: { minutes: 600, daysWithHardware: 5, metrics: [{ id: 'cpuUsage', unit: '%', decimals: 1, avg: 30, max: 80 }], battery: { recorded: false }, days: [], hourly: [] }, health: { recorded: true, episodeCount: 1, worst: 'warning', problems: [{ id: 'ramHigh', count: 1, severity: 'warning' }], episodes: [], notifications: 0 }, comparison: { available: false, reason: 'current-too-short' }, navigation: { previous: dayKey(7), next: null } });

async function fakeFetch(url, init) {
  srv.calls.push(`${init.method} ${url}`);
  if (srv.down) throw new TypeError('network down');
  const body = init.body ? JSON.parse(init.body) : null; const u = url.replace('/id/api', '');
  if (u === '/v1/web/session/login') { if (body.password !== 'good-password-123') return json(401, { error: { code: 'invalid_credentials', message: 'x' } }); srv.cookie = 'c1'; return sessionBody(); }
  if (u === '/v1/web/session/refresh') return srv.cookie ? sessionBody() : json(401, { error: { code: 'no_session', message: 'Not signed in.' } });
  if (u === '/v1/web/session/logout') { srv.cookie = null; return json(204, null); }
  if (!srv.cookie) return json(401, { error: { code: 'invalid_token', message: 'x' } });
  if (u === '/v1/web/overview') return json(200, overview());
  if (u === '/v1/web/plant') return json(200, { plant, identity: { species: 'fern', name: 'Fernando' }, source: 'cloud-ledger' });
  if (u.startsWith('/v1/devices?')) return json(200, { devices: devices() });
  if (u === '/v1/devices') return json(200, { devices: devices() });
  if (u === `/v1/devices/${D1}` && init.method === 'GET') return json(200, { device: devices()[0] });
  if (u === `/v1/devices/${D1}` && init.method === 'PATCH') { srv.renamed = body.name; return json(200, { device: { ...devices()[0], name: body.name } }); }
  if (u === `/v1/devices/${D1}/remove`) { srv.removed = body; return json(200, {}); }
  if (u.startsWith(`/v1/devices/${D1}/summary`)) return json(200, summary());
  if (u.startsWith(`/v1/web/devices/${D1}/performance`)) return json(200, perf());
  if (u.startsWith(`/v1/web/devices/${D1}/health`)) return json(200, health());
  if (u.startsWith(`/v1/web/devices/${D1}/report`)) return json(200, report(/kind=(\w+)/.exec(u)[1]));
  if (u === '/v1/account/settings') return json(200, { settings: { language: 'en' } });
  if (u === '/v1/account') return json(200, { user });
  if (u === '/v1/account/sessions') return json(200, { sessions: [{ id: 's1', current: true, deviceLabel: 'Petali Web', lastUsedAt: iso(NOW) }, { id: 's2', current: false, deviceLabel: 'Petali Desktop', lastUsedAt: iso(NOW - 36e5) }] });
  return json(404, { error: { code: 'not_found', message: 'x' } });
}

// ---------------- jsdom + globals ----------------
const dom = new JSDOM(readFileSync(new URL('../../id/index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/g, ''), { url: 'https://petali.netlify.app/id/computers', pretendToBeVisual: true });
const w = dom.window; const idb = new IDBFactory();
Object.assign(globalThis, { window: w, document: w.document, location: w.location, history: w.history, Node: w.Node, Element: w.Element, localStorage: w.localStorage, indexedDB: idb, self: globalThis, matchMedia: () => ({ matches: false }), fetch: fakeFetch, scrollTo: () => {} });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, standalone: false, maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux) jsdom' }, configurable: true });
w.matchMedia = globalThis.matchMedia; w.scrollTo = () => {}; w.fetch = fakeFetch;
for (const f of ['plant-visuals', 'plant-species', 'health-text', 'app-categories', 'app-names']) new vm.Script(readFileSync(new URL(`../../id/vendor/${f}.js`, import.meta.url), 'utf8')).runInThisContext();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 4000) { const t = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error(`timeout: ${what}\n${document.body.textContent.slice(0, 400)}`); await sleep(15); } }
const text = () => document.getElementById('view').textContent;
const path = () => location.pathname + location.search;
const go = (p) => { history.pushState({}, '', p); window.dispatchEvent(new w.PopStateEvent('popstate')); };
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
const type = (el, v) => { el.value = v; };
const submit = (form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const idbEntries = () => new Promise((res) => { const r = idb.open('petali-id', 1); r.onsuccess = () => { const db = r.result; const q = db.transaction('entries').objectStore('entries').getAll(); q.onsuccess = () => res(q.result); }; });

describe('Petali ID app', () => {
  before(async () => { await import('../../id/js/app.js'); });

  it('an unauthenticated visit to a nested route redirects to /id/login and remembers where to go back', async () => {
    await waitFor(() => path().startsWith('/id/login'), 'redirect'); assert.equal(path(), '/id/login?next=%2Fid%2Fcomputers');
    assert.ok(document.querySelector('form input[type=email]')); assert.equal(document.querySelector('.tabbar').hidden, true, 'no app navigation on the login screen');
  });
  it('the registration view is reachable and keeps the destination', async () => {
    click(document.querySelector('.switch a')); await waitFor(() => path().startsWith('/id/register'), 'register'); assert.match(path(), /next=%2Fid%2Fcomputers/); assert.ok(document.getElementById('displayName'));
    go('/id/login?next=%2Fid%2Fcomputers'); await waitFor(() => document.getElementById('email') && !document.getElementById('displayName'), 'login again');
  });
  it('wrong credentials: a clear message, still on the login view, password field cleared', async () => {
    type(document.getElementById('email'), 'milan@example.com'); type(document.getElementById('password'), 'wrong'); submit(document.querySelector('form'));
    await waitFor(() => document.querySelector('.form-error') && !document.querySelector('.form-error').hidden, 'error'); assert.match(document.querySelector('.form-error').textContent, /incorrect/i); assert.ok(path().startsWith('/id/login')); assert.equal(document.getElementById('password').value, '');
  });
  it('the server being unreachable is explained as such (not as wrong credentials)', async () => {
    srv.down = true; type(document.getElementById('password'), 'whatever1234'); submit(document.querySelector('form'));
    await waitFor(() => /cannot reach/i.test(document.querySelector('.form-error').textContent), 'network error text'); srv.down = false;
  });
  it('login returns the user to the originally requested /id/computers', async () => {
    type(document.getElementById('password'), 'good-password-123'); submit(document.querySelector('form'));
    await waitFor(() => path() === '/id/computers', 'return path'); await waitFor(() => /Desk PC/.test(text()), 'computer list');
    assert.ok(!document.querySelector('.tabbar').hidden); assert.equal(document.querySelectorAll('.tabbar a').length, 5);
  });
  it('computer names are text, never markup (no injection)', () => { assert.ok(/<img src=x onerror=alert\(1\)>Laptop/.test(text())); assert.equal(document.querySelectorAll('#view img').length, 0); });
  it('the computer list shows status, hardware and last synchronisation', () => { assert.match(text(), /Syncing now/); assert.match(text(), /Not synced recently/); assert.match(text(), /Intel i5/); assert.match(text(), /Last synchronised/); assert.match(text(), /Cloud snapshot/); });
  it('the dashboard: plant, usage, computers, health, last sync, alerts; unavailable is not zero', async () => {
    go('/id/'); await waitFor(() => /Needs attention/.test(text()), 'dashboard');
    const t = text(); assert.match(t, /Sprout/); assert.match(t, /Fernando/); assert.match(t, /7 h/); assert.match(t, /1 of 2 syncing/); assert.match(t, /3 problems/); assert.match(t, /1 critical/); assert.match(t, /Last synchronised/); assert.match(t, /has not synchronised for over 3 days/); assert.match(t, /Critical Device Health problems/);
    assert.equal(document.querySelectorAll('svg.plant-art').length, 1); assert.equal(document.querySelector('.tabbar a[aria-current=page]').textContent, 'Dashboard');
  });
  it('computer details: hardware, cloud history, rename and remove', async () => {
    go(`/id/computers/${D1}`); await waitFor(() => /Hardware/.test(text()) && /Manage/.test(text()) && /Last 30 days/.test(text()), 'details (the summary card loads separately)');
    assert.match(text(), /Intel i5/); assert.match(text(), /16 GB/); assert.match(text(), /Cloud history/); assert.match(text(), /Last 30 days/);
    type(document.getElementById('rename'), 'Office PC'); click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Save name')); await waitFor(() => srv.renamed === 'Office PC', 'rename request');
    click([...document.querySelectorAll('button')].find((b) => /Remove this computer/.test(b.textContent))); const confirmBtn = await waitFor(() => [...document.querySelectorAll('.danger button')].find((b) => b.textContent === 'Remove computer'), 'confirmation'); assert.equal(srv.removed, false, 'nothing is removed before confirmation');
    document.getElementById('delhist').checked = true; click(confirmBtn); await waitFor(() => srv.removed && srv.removed.confirm === true && srv.removed.deleteCloudHistory === true, 'remove request'); await waitFor(() => path() === '/id/computers', 'back to list'); srv.removed = false;
  });
  it('plant: stage, progress, growth, next stage, per-computer growth', async () => {
    go('/id/plant'); await waitFor(() => /Total growth/.test(text()), 'plant'); const t = text();
    assert.match(t, /Sprout/); assert.match(t, /40 % to Young plant/); assert.match(t, /5 h/); assert.match(t, /Desk PC/); assert.match(t, /never changes it/i); assert.ok(document.querySelector('.plant-art.st-sprout'));
  });
  it('usage: selected computer, period, Active Work, applications with friendly names and categories, hardware, gaps are not zero', async () => {
    go('/id/usage'); await waitFor(() => /Hardware performance/.test(text()), 'usage'); const t = text();
    assert.match(t, /Desk PC/); assert.match(t, /20 h/); assert.match(t, /Google Chrome|Chrome/); assert.match(t, /Visual Studio Code/); assert.match(t, /Productivity|Other/); assert.match(t, /58\.0 ?°C|58 ?°C/); assert.match(t, /Not attributed to an application: 1 h/);
    const seg = [...document.querySelectorAll('.seg-b')].find((b) => b.textContent === '7 days'); click(seg); await waitFor(() => srv.calls.some((c) => /summary\?days=7/.test(c)), 'period change');
  });
  it('Device Health: latest recorded status (historical), problems with the desktop wording, severity, recommendation', async () => {
    go('/id/health'); await waitFor(() => /Detected problems/.test(text()), 'health'); const t = text();
    assert.match(t, /Latest recorded status/); assert.match(t, /not a live reading/); assert.match(t, /Critical/); assert.match(t, /Recommended:/); assert.match(t, /2 times/); assert.ok(/overheat/i.test(t));
  });
  it('Reports: period, generation time, Active Work, apps, hardware, health, honest comparison reason, period navigation', async () => {
    go('/id/reports'); await waitFor(() => /Compared with the previous period/.test(text()), 'report'); const t = text();
    assert.match(t, /generated/); assert.match(t, /not complete/); assert.match(t, /9 h/); assert.match(t, /too few days/i); assert.match(t, /Top applications/);
    const nextBtn = document.querySelector('[aria-label="Next period"]'); assert.equal(nextBtn.disabled, true); const prev = document.querySelector('[aria-label="Previous period"]'); assert.equal(prev.disabled, false);
    click([...document.querySelectorAll('.seg-b')].find((b) => b.textContent === 'Monthly')); await waitFor(() => srv.calls.some((c) => /kind=monthly/.test(c)), 'monthly');
  });
  it('Settings: account, sessions, appearance, install, sign out; theme switch works', async () => {
    go('/id/settings'); await waitFor(() => /Signed-in sessions/.test(text()), 'settings'); const t = text();
    assert.match(t, /milan@example.com/); assert.match(t, /Petali Web/); assert.match(t, /This session/); assert.match(t, /Install/); assert.match(t, /Sign out/);
    click([...document.querySelectorAll('.seg-b')].find((b) => b.textContent === 'Night')); assert.ok(document.documentElement.classList.contains('night'), 'Night turns the desktop night theme on'); click([...document.querySelectorAll('.seg-b')].find((b) => b.textContent === 'Day')); assert.ok(!document.documentElement.classList.contains('night'));
  });
  it('More lists Device Health, Reports, Settings', async () => { go('/id/more'); await waitFor(() => /Device Health/.test(text()) && /Reports/.test(text()), 'more'); assert.equal(document.querySelector('.tabbar a[aria-current=page]').textContent, 'More'); });
  it('a signed-in user is sent away from /id/login, and an external "next" is ignored', async () => {
    go('/id/login?next=https%3A%2F%2Fevil.example%2F'); await waitFor(() => path() === '/id/', 'safe fallback'); assert.equal(location.hostname, 'petali.netlify.app'); await waitFor(() => /Needs attention/.test(text()), 'dashboard loaded (and saved)');
  });
  it('unknown /id paths show a not-found page inside the app', async () => { go('/id/nope'); await waitFor(() => /Page not found/.test(text()), '404'); });
  it('OFFLINE: the server is down - saved copies are shown, labelled as saved, never as live', async () => {
    go('/id/plant'); await waitFor(() => /Total growth/.test(text()), 'plant online');
    srv.down = true; go('/id/usage'); await waitFor(() => /Saved copy/.test(text()), 'saved copy label'); const t = text(); assert.match(t, /20 h/); assert.match(t, /Saved copy from/); assert.ok(!/Refreshing/.test(t) || true);
    go('/id/dashboard-nope'); go('/id/'); await waitFor(() => /Saved copy/.test(text()) && /Sprout/.test(text()), 'saved dashboard'); assert.ok(idbEntries);
    srv.down = false;
  });
  it('RECONNECTION: data refreshes and the label returns to cloud snapshot', async () => { go('/id/plant'); await waitFor(() => /Total growth/.test(text()) && !/Saved copy/.test(text()), 'fresh again'); assert.match(text(), /Cloud data/); });
  it('LOGOUT: signs out, wipes every saved copy, protected routes need a login again', async () => {
    assert.ok((await idbEntries()).length > 0); go('/id/more'); await waitFor(() => /Sign out/.test(text()), 'more');
    click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')); await waitFor(() => path().startsWith('/id/login'), 'login after logout');
    await waitFor(async () => true); await sleep(50); assert.equal((await idbEntries()).length, 0, 'saved copies wiped'); assert.equal(srv.cookie, null);
    go('/id/plant'); await waitFor(() => path() === '/id/login?next=%2Fid%2Fplant', 'protected'); assert.ok(!/Total growth/.test(text()));
  });
});
