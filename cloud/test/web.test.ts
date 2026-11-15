import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { loadConfig } from '../src/config/env';
import { accountPlant, STAGES } from '../src/modules/web/plant';
import { aggregateHardware, buildEpisodes, compare, healthSection, periodFor, usageSection, type HwMap } from '../src/modules/web/report-core';
import { createTestEnv, STRONG, type TestEnv } from './helpers';

const ORIGIN = 'https://petali.netlify.app';
const WEB = { origin: ORIGIN, 'x-petali-web': '1' };
const H = 3_600_000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const dayKey = (offset = 0) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const fixture = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const norm = (v: unknown) => JSON.parse(JSON.stringify(v));

const cookieOf = (headers: Headers) => (headers.getSetCookie?.() ?? []).find((c) => c.startsWith('petali_rt=')) ?? null;
const cookieValue = (setCookie: string | null) => (setCookie ? (/^petali_rt=([^;]*)/.exec(setCookie)?.[1] ?? '') : '');
const withCookie = (setCookie: string | null, extra: Record<string, string> = {}) => ({ ...WEB, cookie: `petali_rt=${cookieValue(setCookie)}`, ...extra });

type Dev = { id: string; epoch: number; token: string };
async function device(env: TestEnv, token: string, name = 'PC'): Promise<Dev> {
  const r = await env.call('POST', '/v1/sync/devices/register', { token, body: { clientDeviceId: randomUUID(), name, platform: 'win32', appVersion: '1.4.0', hardware: { cpu: 'Test CPU' } } });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.device.id, epoch: r.json.device.epoch, token };
}
const dev = (kind: string, key: string, data: unknown) => ({ kind, key, scope: 'device', clientUpdatedAt: iso(), data });
async function push(env: TestEnv, d: Dev, ops: unknown[]) { const r = await env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: d.id, epoch: d.epoch, ops } }); assert.equal(r.status, 200, r.text); for (const x of r.json.results) assert.ok(['applied', 'unchanged'].includes(x.outcome), JSON.stringify(x)); }
const dayDoc = (k: string, activeMs: number, n = 2) => ({ version: 1, dayKey: k, activeMs, sessions: Array.from({ length: n }, () => ({ start: 1, end: 2, activeMs: activeMs / n })) });
const bucket = (t: number, n: number, v: Record<string, unknown>) => ({ t, n, ...v });
const rollupMonth = (month: string, days: Record<string, { hw: any; hourly: any[] }>) => ({ version: 1, month, days });

describe('web: configuration', () => {
  const good = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'k'.repeat(10) + 'abcdefghijklmnopqrstuvwxyz0123456789' };
  it('has safe defaults and validates the web settings', () => {
    const c = loadConfig({ ...good, NODE_ENV: 'test' });
    assert.deepEqual(c.web.allowedOrigins, [ORIGIN]); assert.equal(c.web.cookieSecure, false); assert.equal(c.web.cookieName, 'petali_rt'); assert.equal(c.web.cookiePath, '/id/api/v1/web/session');
    const p = loadConfig({ ...good, NODE_ENV: 'production' });
    assert.equal(p.web.cookieSecure, true); assert.equal(p.web.cookieName, '__Secure-petali_rt');
    assert.throws(() => loadConfig({ ...good, NODE_ENV: 'production', WEB_COOKIE_SECURE: 'false' }), /Secure cookies/);
    assert.throws(() => loadConfig({ ...good, WEB_ALLOWED_ORIGINS: 'https://petali.netlify.app/' }), /not an origin/);
    assert.throws(() => loadConfig({ ...good, WEB_ALLOWED_ORIGINS: 'petali.netlify.app' }), /not an origin/);
    assert.throws(() => loadConfig({ ...good, WEB_COOKIE_PATH: 'id/api' }), /absolute URL path/);
    assert.deepEqual(loadConfig({ ...good, WEB_ALLOWED_ORIGINS: 'https://a.example, http://localhost:8888' }).web.allowedOrigins, ['https://a.example', 'http://localhost:8888']);
  });
});

describe('web: cookie session', () => {
  let env: TestEnv; const email = `web-${randomUUID().slice(0, 8)}@example.com`;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('register: HttpOnly SameSite=Strict cookie scoped to the session path, access token in the body, NO refresh token anywhere in the body', async () => {
    const r = await env.call('POST', '/v1/web/session/register', { headers: WEB, body: { email, password: STRONG, displayName: 'Web Tester' } });
    assert.equal(r.status, 201, r.text);
    const c = cookieOf(r.headers) as string;
    assert.ok(c, 'cookie set'); assert.match(c, /; HttpOnly/); assert.match(c, /; SameSite=Strict/); assert.match(c, /; Path=\/id\/api\/v1\/web\/session/); assert.match(c, /; Max-Age=\d+/);
    assert.doesNotMatch(c, /Domain=/);
    assert.ok(r.json.accessToken && r.json.accessTokenExpiresAt && r.json.sessionId && r.json.user.email === email);
    assert.equal(r.json.refreshToken, undefined); assert.equal(r.json.tokens, undefined);
    assert.ok(!r.text.includes(cookieValue(c)), 'the refresh token is not in the body');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
  it('production cookies are Secure and use the __Secure- prefix', async () => {
    const prod = await createTestEnv({ WEB_COOKIE_SECURE: 'true' });
    try {
      const r = await prod.call('POST', '/v1/web/session/register', { headers: WEB, body: { email: `p-${randomUUID().slice(0, 6)}@example.com`, password: STRONG } });
      const c = (r.headers.getSetCookie() as string[])[0] as string;
      assert.match(c, /^__Secure-petali_rt=/); assert.match(c, /; Secure/); assert.match(c, /; HttpOnly/);
    } finally { await prod.close(); }
  });
  it('login with a wrong password gives 401, no cookie, and the same error as the desktop endpoint', async () => {
    const r = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: 'wrong password here' } });
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'invalid_credentials'); assert.equal(cookieOf(r.headers), null);
  });
  it('refresh: restores the session from the cookie, rotates it, and the access token works on the existing API', async () => {
    const login = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG } });
    assert.equal(login.status, 200);
    const c1 = cookieOf(login.headers);
    const r = await env.call('POST', '/v1/web/session/refresh', { headers: withCookie(c1), body: {} });
    assert.equal(r.status, 200, r.text);
    const c2 = cookieOf(r.headers);
    assert.ok(c2 && cookieValue(c2) !== cookieValue(c1), 'rotated');
    assert.equal(r.json.sessionId, login.json.sessionId);
    const me = await env.call('GET', '/v1/account', { token: r.json.accessToken });
    assert.equal(me.status, 200); assert.equal(me.json.user.email, email);
  });
  it('reuse of an old cookie ends the session (existing theft detection) and clears the cookie', async () => {
    const login = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG } });
    const c1 = cookieOf(login.headers);
    const r1 = await env.call('POST', '/v1/web/session/refresh', { headers: withCookie(c1), body: {} });
    assert.equal(r1.status, 200);
    const reuse = await env.call('POST', '/v1/web/session/refresh', { headers: withCookie(c1), body: {} });
    assert.equal(reuse.status, 401); assert.equal(reuse.json.error.code, 'refresh_token_reused');
    assert.match(cookieOf(reuse.headers) ?? '', /^petali_rt=;.*Max-Age=0/);
    const dead = await env.call('POST', '/v1/web/session/refresh', { headers: withCookie(cookieOf(r1.headers)), body: {} });
    assert.equal(dead.status, 401, 'the newer cookie is cut off too');
    assert.equal((await env.call('GET', '/v1/account', { token: r1.json.accessToken })).status, 401);
  });
  it('refresh without a cookie is 401 no_session', async () => {
    const r = await env.call('POST', '/v1/web/session/refresh', { headers: WEB, body: {} });
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'no_session');
  });
  it('CSRF: the custom header and an allowed Origin are both required, on every cookie endpoint', async () => {
    const login = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG } });
    const cookie = `petali_rt=${cookieValue(cookieOf(login.headers))}`;
    for (const p of ['login', 'register', 'refresh', 'logout']) {
      const body = p === 'login' ? { email, password: STRONG } : p === 'register' ? { email: 'x@example.com', password: STRONG } : {};
      const noHeader = await env.call('POST', `/v1/web/session/${p}`, { headers: { origin: ORIGIN, cookie }, body });
      assert.equal(noHeader.status, 403, `${p} without header`); assert.equal(noHeader.json.error.code, 'web_header_required');
      const noOrigin = await env.call('POST', `/v1/web/session/${p}`, { headers: { 'x-petali-web': '1', cookie }, body });
      assert.equal(noOrigin.status, 403, `${p} without origin`); assert.equal(noOrigin.json.error.code, 'origin_not_allowed');
      const evil = await env.call('POST', `/v1/web/session/${p}`, { headers: { 'x-petali-web': '1', origin: 'https://evil.example', cookie }, body });
      assert.equal(evil.status, 403, `${p} from another origin`); assert.equal(evil.json.error.code, 'origin_not_allowed');
      const similar = await env.call('POST', `/v1/web/session/${p}`, { headers: { 'x-petali-web': '1', origin: `${ORIGIN}.evil.example`, cookie }, body });
      assert.equal(similar.status, 403, `${p} lookalike origin`);
    }
    // none of the blocked requests touched the session
    assert.equal((await env.call('POST', '/v1/web/session/refresh', { headers: { ...WEB, cookie }, body: {} })).status, 200);
  });
  it('logout ends the session on the server at once, clears the cookie, and repeating it is harmless', async () => {
    const login = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG } });
    const c = cookieOf(login.headers);
    const out = await env.call('POST', '/v1/web/session/logout', { headers: withCookie(c), body: {} });
    assert.equal(out.status, 204); assert.match(cookieOf(out.headers) ?? '', /^petali_rt=;.*Max-Age=0/);
    assert.equal((await env.call('GET', '/v1/account', { token: login.json.accessToken })).status, 401, 'the access token stops working immediately');
    assert.equal((await env.call('POST', '/v1/web/session/refresh', { headers: withCookie(c), body: {} })).status, 401);
    assert.equal((await env.call('POST', '/v1/web/session/logout', { headers: WEB, body: {} })).status, 204);
  });
  it('a web session is an ordinary account session: listed as "Petali Web" and revocable from the account', async () => {
    const login = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG } });
    const list = await env.call('GET', '/v1/account/sessions', { token: login.json.accessToken });
    const mine = list.json.sessions.find((s: any) => s.current);
    assert.equal(mine.deviceLabel, 'Petali Web');
    const second = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG } });
    const del = await env.call('DELETE', `/v1/account/sessions/${login.json.sessionId}`, { token: second.json.accessToken });
    assert.equal(del.status, 200, del.text);
    assert.equal((await env.call('POST', '/v1/web/session/refresh', { headers: withCookie(cookieOf(login.headers)), body: {} })).status, 401, 'revoked from elsewhere: the next refresh fails');
  });
  it('the desktop endpoints are unchanged: /v1/auth/login still returns the refresh token in the body and sets no cookie', async () => {
    const r = await env.call('POST', '/v1/auth/login', { body: { email, password: STRONG } });
    assert.equal(r.status, 200); assert.match(r.json.tokens.refreshToken, /^ptr_/); assert.equal(cookieOf(r.headers), null);
  });
  it('registration rules are the existing ones (weak password, duplicate email) and unknown fields are rejected', async () => {
    assert.equal((await env.call('POST', '/v1/web/session/register', { headers: WEB, body: { email: 'weak@example.com', password: 'password' } })).json.error.code, 'weak_password');
    assert.equal((await env.call('POST', '/v1/web/session/register', { headers: WEB, body: { email, password: STRONG } })).json.error.code, 'email_taken');
    assert.equal((await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG, userId: 'x' } })).status, 400);
  });
  it('the API sends no CORS headers (the site uses a same-origin proxy)', async () => {
    const r = await env.call('POST', '/v1/web/session/login', { headers: WEB, body: { email, password: STRONG } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
});

describe('web: plant (parity with the desktop)', () => {
  it('accountPlant gives exactly what the desktop PlantGrowth gives, for every vector', () => {
    const v = fixture('plant-vectors.json');
    assert.ok(v.cases.length >= 10);
    for (const c of v.cases) {
      const got = accountPlant(c.ledgers.map((l: unknown, i: number) => ({ deviceId: `d${i}`, ledger: l })));
      assert.ok(got, c.name);
      assert.deepEqual({ stage: got.stage, stageIndex: got.stageIndex, progress: got.progress, growthMinutes: got.growthMinutes }, c.expected, c.name);
    }
  });
  it('no ledger means no plant (not a seed)', () => { assert.equal(accountPlant([]), null); assert.equal(accountPlant([{ deviceId: 'a', ledger: 'junk' }]), null); });
  it('stage table matches the desktop', () => { assert.deepEqual(STAGES.map((s) => [s.id, s.atMs / H]), [['seed', 0], ['sprout', 2], ['young', 10], ['mature', 30]]); });
});

describe('web: report maths (parity with the desktop)', () => {
  const v = fixture('report-vectors.json');
  const hw: HwMap = new Map(Object.entries(v.inputs.hardware)) as HwMap;
  const active = new Map<string, any>(Object.entries(v.inputs.active));
  const events = v.inputs.healthEvents;
  it('periodFor: same periods, same errors', () => { for (const c of v.periods) assert.deepEqual(norm(periodFor(c.kind, c.key, c.today)), c.expected, `${c.kind} ${c.key}`); });
  it('usageSection', () => { assert.deepEqual(norm(usageSection(v.week.keys, active)), v.expected.usage); assert.deepEqual(norm(usageSection(v.week.prevKeys, active)), v.expected.usagePrev); });
  it('aggregateHardware (sample-weighted averages, maxima, peaks, battery, health minutes)', () => { assert.deepEqual(norm(aggregateHardware(v.week.keys, hw)), v.expected.aggregate); assert.deepEqual(norm(aggregateHardware(v.week.prevKeys, hw)), v.expected.aggregatePrev); });
  it('buildEpisodes + healthSection', () => {
    const from = Date.parse('2026-10-12T00:00:00Z') - 86_400_000; const to = Date.parse('2026-10-20T00:00:00Z');
    const eps = buildEpisodes(events, { from, to });
    assert.deepEqual(norm(eps), v.expected.episodes);
    const agg = aggregateHardware(v.week.keys, hw);
    assert.deepEqual(norm(healthSection(eps, events, agg)), v.expected.health);
  });
  it('compare: the same decision and the same numbers, and no comparison on too little data', () => {
    const p = periodFor('weekly', '2026-10-12', v.week.today) as any; const pp = periodFor('weekly', '2026-10-05', v.week.today) as any;
    const agg = aggregateHardware(v.week.keys, hw); const aggPrev = aggregateHardware(v.week.prevKeys, hw);
    const out = compare({ period: p, usage: usageSection(v.week.keys, active), agg, health: v.expected.health, prev: { key: pp.key, keys: pp.dayKeys, usage: usageSection(v.week.prevKeys, active), agg: aggPrev, health: v.expected.healthPrev } });
    assert.deepEqual(norm(out), v.expected.comparison);
    const t = v.expected.thin; const tp = periodFor('weekly', '2026-10-12', t.today) as any;
    const thin = compare({ period: tp, usage: usageSection(t.keys, active), agg: aggregateHardware(t.keys, hw), health: v.expected.health, prev: { key: pp.key, keys: pp.dayKeys, usage: usageSection(v.week.prevKeys, active), agg: aggPrev, health: v.expected.healthPrev } });
    assert.deepEqual(norm(thin), t.comparison); assert.equal(thin.available, false);
  });
});

describe('web: read endpoints', () => {
  let env: TestEnv; let a: Awaited<ReturnType<TestEnv['register']>>; let b: Awaited<ReturnType<TestEnv['register']>>;
  let d1: Dev; let d2: Dev; let empty: Dev;
  const monthOf = (k: string) => k.slice(0, 7);
  before(async () => {
    env = await createTestEnv(); a = await env.register(); b = await env.register();
    d1 = await device(env, a.tokens.accessToken, 'Desk'); d2 = await device(env, a.tokens.accessToken, 'Laptop'); empty = await device(env, a.tokens.accessToken, 'Brand new');
    const t0 = env.clock.now; const k0 = dayKey(0); const k1 = dayKey(1); const k2 = dayKey(2);
    const hourT = Date.parse(`${k1}T10:00:00Z`);
    const mk = (hs: number[], cpu: number) => bucket(hourT, 60, { cpu: [cpu, cpu + 20], temp: [60, 72], ram: [40, 50], hsm: hs });
    await push(env, d1, [
      dev('day', k0, dayDoc(k0, 2 * H)), dev('day', k1, dayDoc(k1, 3 * H, 3)), dev('day', k2, dayDoc(k2, 1 * H, 1)),
      dev('apps', k1, { version: 1, dayKey: k1, apps: { 'chrome.exe': 2 * H, 'Code.exe': 0.5 * H }, unknownMs: 0.25 * H, hourly: [] }),
      dev('plant', 'ledger', { baseMs: 2 * H, days: { [k1]: 3 * H, [k2]: 1 * H } }),
      dev('rollup', monthOf(k1), rollupMonth(monthOf(k1), { [k1]: { hw: { ...mk([40, 15, 5], 30), t: Date.parse(`${k1}T00:00:00Z`), minutes: 60 }, hourly: [mk([40, 15, 5], 30)] } })),
      dev('health', monthOf(k1), { lines: [
        { k: 'start', id: 'cpuOverheat', t: hourT + 600_000, sev: 'warning', v: [{ key: 'temp', value: 93, unit: '°C' }] }, { k: 'sev', id: 'cpuOverheat', t: hourT + 900_000, sev: 'critical' }, { k: 'end', id: 'cpuOverheat', t: hourT + 1_500_000 },
        { k: 'start', id: 'ramHigh', t: hourT + 2_000_000, sev: 'warning', v: [] },
      ] }),
    ]);
    await env.call('POST', '/v1/sync/push', { token: a.tokens.accessToken, body: { deviceId: d1.id, epoch: d1.epoch, ops: [
      { kind: 'setting', key: 'ui.plant', scope: 'account', clientUpdatedAt: iso(), data: 'fern' }, { kind: 'setting', key: 'ui.name', scope: 'account', clientUpdatedAt: iso(), data: 'Fernando' }] } });
    await push(env, d2, [dev('day', k1, dayDoc(k1, 1 * H)), dev('plant', 'ledger', { baseMs: 0, days: { [k1]: 2 * H, [dayKey(3)]: 1 * H } })]);
    void t0;
  });
  after(async () => { await env.close(); });
  const get = (path: string, token = a.tokens.accessToken) => env.call('GET', path, { token });

  it('every web view needs a signed-in account', async () => {
    for (const p of ['/v1/web/overview', '/v1/web/plant', `/v1/web/devices/${d1.id}/health`, `/v1/web/devices/${d1.id}/performance`, `/v1/web/devices/${d1.id}/report?kind=daily`]) {
      const r = await env.call('GET', p); assert.equal(r.status, 401, p); assert.equal(r.json.error.code, 'missing_token');
    }
    assert.equal((await env.call('GET', '/v1/web/overview', { token: 'x'.repeat(40) })).status, 401);
  });
  it('overview: plant from the account ledgers, device counts, usage, health counts, and what is not known stays unknown', async () => {
    const r = await get('/v1/web/overview'); assert.equal(r.status, 200, r.text);
    const o = r.json;
    assert.equal(o.source, 'cloud-snapshot'); assert.equal(o.devices.total, 3); assert.equal(o.devices.removed, 0);
    // base 2 h + (day k1: min(4h, 3h+2h)=4h) + (k2: 1h) + (k3: 1h) = 8 h
    assert.equal(o.plant.growthMinutes, 8 * 60); assert.equal(o.plant.stage, 'sprout'); assert.equal(o.plant.computers, 2);
    assert.equal(o.usage.available, true); assert.equal(o.usage.last7Days.activeMs, (2 + 3 + 1 + 1) * H);
    assert.equal(o.health.recorded, true); assert.equal(o.health.episodes30d, 2); assert.equal(o.health.critical30d, 1);
    const fresh = o.devices.list.find((d: any) => d.name === 'Brand new'); assert.equal(fresh.activeMsLast7Days, 0);
    assert.ok(o.lastSyncAt);
    assert.deepEqual(o.identity, { species: 'fern', name: 'Fernando' }, 'species and name come from the synchronised settings');
    assert.deepEqual((await get('/v1/web/overview', b.tokens.accessToken)).json.identity, { species: null, name: null });
  });
  it('a brand-new account has no plant, no usage and no health record: "unavailable", never 0', async () => {
    const r = await get('/v1/web/overview', b.tokens.accessToken);
    assert.equal(r.status, 200); assert.equal(r.json.plant, null); assert.equal(r.json.usage.available, false); assert.equal(r.json.health.recorded, false); assert.equal(r.json.health.episodes30d, null); assert.equal(r.json.devices.total, 0); assert.equal(r.json.lastSyncAt, null);
  });
  it('plant: account-wide, never shrinks when a computer is removed (its ledger stays)', async () => {
    const before = (await get('/v1/web/plant')).json.plant;
    assert.equal(before.growthMinutes, 480); assert.equal(before.perDevice.length, 2); assert.ok(before.recentDays.length >= 2);
    const rm = await env.call('POST', `/v1/devices/${d2.id}/remove`, { token: a.tokens.accessToken, body: { confirm: true, deleteCloudHistory: true } });
    assert.equal(rm.status, 200, rm.text);
    const after = (await get('/v1/web/plant')).json.plant;
    assert.equal(after.growthMinutes, 480, 'history deletion does not remove plant growth'); assert.equal(after.perDevice.find((p: any) => p.deviceId === d2.id).removed, true);
    const o = (await get('/v1/web/overview')).json; assert.equal(o.devices.total, 2); assert.equal(o.devices.removed, 1);
  });
  it('health: episodes with severity and measured values, the latest recorded verdict, and open episodes stay open', async () => {
    const r = await get(`/v1/web/devices/${d1.id}/health?days=30`); assert.equal(r.status, 200, r.text);
    const h = r.json.health;
    assert.equal(r.json.source, 'cloud-snapshot'); assert.equal(h.episodeCount, 2); assert.equal(h.worst, 'critical');
    const hot = h.episodes.find((e: any) => e.id === 'cpuOverheat'); assert.equal(hot.severity, 'critical'); assert.equal(hot.durationMs, 900_000); assert.deepEqual(hot.values, [{ key: 'temp', value: 93, unit: '°C' }]);
    const open = h.episodes.find((e: any) => e.id === 'ramHigh'); assert.equal(open.end, null); assert.equal(open.durationMs, null);
    assert.equal(r.json.latest.status, 'critical'); assert.deepEqual(r.json.latest.minutes, { healthy: 40, warning: 15, critical: 5 });
  });
  it('health of a computer that never reported: recorded=false and latest=null (not "healthy")', async () => {
    const r = await get(`/v1/web/devices/${empty.id}/health`); assert.equal(r.status, 200);
    assert.equal(r.json.health.recorded, false); assert.equal(r.json.latest, null); assert.equal(r.json.health.episodeCount, 0);
  });
  it('performance: only metrics that were recorded appear; no zero-filling', async () => {
    const r = await get(`/v1/web/devices/${d1.id}/performance?days=7`); assert.equal(r.status, 200, r.text);
    assert.equal(r.json.available, true); assert.equal(r.json.minutes, 60);
    assert.deepEqual(r.json.metrics.map((m: any) => m.id).sort(), ['cpuTemp', 'cpuUsage', 'ramUsage']);
    const cpu = r.json.metrics.find((m: any) => m.id === 'cpuUsage'); assert.equal(cpu.avg, 30); assert.equal(cpu.max, 50);
    assert.equal(r.json.battery.recorded, false);
    const row1 = r.json.days.find((x: any) => x.dayKey === dayKey(1)); assert.equal(row1.cpuAvg, 30);
    const row0 = r.json.days.find((x: any) => x.dayKey === dayKey(0)); assert.equal(row0.cpuAvg, null); assert.equal(row0.recordedMinutes, null);
    const none = (await get(`/v1/web/devices/${empty.id}/performance`)).json; assert.equal(none.available, false); assert.deepEqual(none.metrics, []);
  });
  it('report (weekly) from synced documents: usage, apps, hardware, health, and an honest comparison', async () => {
    const r = await get(`/v1/web/devices/${d1.id}/report?kind=weekly&key=${dayKey(1)}`); assert.equal(r.status, 200, r.text);
    const x = r.json;
    assert.equal(x.period.kind, 'weekly'); assert.equal(x.period.days, 7); assert.equal(x.source, 'cloud-snapshot'); assert.ok(x.generatedAt);
    const inWeek = (k: string, h: number) => (k >= x.period.from && k <= x.period.to ? h * H : 0);     // which of the three seeded days fall in this calendar week depends on today's weekday
    assert.equal(x.usage.totalMs, inWeek(dayKey(0), 2) + inWeek(dayKey(1), 3) + inWeek(dayKey(2), 1));
    assert.equal(x.apps.top[0].app, 'chrome.exe'); assert.equal(x.apps.unknownMs, 0.25 * H);
    assert.equal(x.hardware.minutes, 60); assert.equal(x.comparison.available, false);
    assert.equal(x.health.episodeCount, 2);
  });
  it('report (daily): day rows and hourly detail; a day with no document is "no data", not 0', async () => {
    const r = await get(`/v1/web/devices/${d1.id}/report?kind=daily&key=${dayKey(1)}`);
    assert.equal(r.json.usage.totalMs, 3 * H); assert.equal(r.json.hardware.hourly.length, 1);
    const none = (await get(`/v1/web/devices/${d1.id}/report?kind=daily&key=${dayKey(20)}`)).json;
    assert.equal(none.usage.available, false); assert.equal(none.usage.totalMs, null); assert.equal(none.usage.days[0].activeMs, null); assert.equal(none.period.incomplete, true, 'before the history starts');
    assert.equal(none.navigation.previous, null);
  });
  it('report: monthly default period, and validation errors', async () => {
    const m = await get(`/v1/web/devices/${d1.id}/report?kind=monthly`); assert.equal(m.status, 200); assert.equal(m.json.period.key, dayKey(0).slice(0, 7)); assert.equal(m.json.period.incomplete, true);
    assert.equal((await get(`/v1/web/devices/${d1.id}/report?kind=yearly`)).status, 400);
    assert.equal((await get(`/v1/web/devices/${d1.id}/report`)).status, 400);
    const bad = await get(`/v1/web/devices/${d1.id}/report?kind=daily&key=2026-02-31`); assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'report_invalid_key');
    const future = await get(`/v1/web/devices/${d1.id}/report?kind=daily&key=${new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)}`); assert.equal(future.status, 400); assert.equal(future.json.error.code, 'report_future_period');
    assert.equal((await get(`/v1/web/devices/${d1.id}/health?days=0`)).status, 400); assert.equal((await get(`/v1/web/devices/${d1.id}/health?days=400`)).status, 400);
    assert.equal((await get('/v1/web/devices/not-a-uuid/health')).status, 400);
  });
  it('account isolation: another account sees none of this, and its device ids give 404 like unknown ones', async () => {
    for (const p of ['health', 'performance', 'report?kind=daily']) {
      const r = await get(`/v1/web/devices/${d1.id}/${p}`, b.tokens.accessToken); assert.equal(r.status, 404, p); assert.equal(r.json.error.code, 'device_not_found');
      const unknown = await get(`/v1/web/devices/${randomUUID()}/${p}`, b.tokens.accessToken); assert.equal(unknown.status, 404); assert.equal(JSON.stringify(unknown.json.error).replace(/"requestId":"[^"]*"/, ''), JSON.stringify(r.json.error).replace(/"requestId":"[^"]*"/, ''));
    }
    const o = (await get('/v1/web/overview', b.tokens.accessToken)).json; assert.equal(o.devices.total, 0); assert.equal(o.plant, null);
    assert.equal((await get('/v1/web/plant', b.tokens.accessToken)).json.plant, null);
    // the shared-account plant of A is not influenced by B's ledger
    const bd = await device(env, b.tokens.accessToken, 'B PC'); await push(env, bd, [dev('plant', 'ledger', { baseMs: 20 * H, days: {} })]);
    assert.equal((await get('/v1/web/plant', b.tokens.accessToken)).json.plant.growthMinutes, 20 * 60);
    assert.equal((await get('/v1/web/plant')).json.plant.growthMinutes, 480);
  });
  it('a signed-out session cannot read', async () => {
    const x = await env.register(); await env.call('POST', '/v1/auth/logout', { token: x.tokens.accessToken, body: {} });
    assert.equal((await env.call('GET', '/v1/web/overview', { token: x.tokens.accessToken })).status, 401);
  });
});

describe('web: rate limiting', () => {
  it('web reads are limited per IP', async () => {
    const env = await createTestEnv({ RATE_LIMIT_WEB_MAX: '3' });
    try {
      const a = await env.register(); let last = 0;
      for (let i = 0; i < 5; i += 1) last = (await env.call('GET', '/v1/web/overview', { token: a.tokens.accessToken })).status;
      assert.equal(last, 429);
    } finally { await env.close(); }
  });
});
