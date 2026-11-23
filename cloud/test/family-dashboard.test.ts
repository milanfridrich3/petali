import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';
import { errCode } from './family-helpers';
import { ALL_SHARED, HOUR, MIN, call, dayAgo, device, family, linkDevice, putApps, putDoc, putDay, putOverride, q, shareWith, user, utcToday, type Fam } from './family-dashboard-helpers';
import { addDays } from '../src/modules/web/report-core';

let env: TestEnv;
function useEnv() { before(async () => { env = await createTestEnv(); }); after(async () => { await env.close(); }); }

const range = (from: string, to: string, extra: Record<string, string | number> = {}) => q({ from, to, today: to, ...extra });
const week = () => range(dayAgo(env, 6), dayAgo(env, 0));
const get = (u: { token: string }, path: string) => call(env, u, 'GET', path);
const members = (r: { json: any }) => Object.fromEntries((r.json.members as any[]).map((m) => [m.memberId, m]));

// A's distinctive numbers: if any of them appears in a response the viewer must not see, data leaked.
const A_TODAY = 7_654_321; const A_APP_MS = 3_333_333;
async function seed(f: Fam) {
  for (let i = 0; i < 5; i += 1) { await putDay(env, f.owner, f.ownerDev, dayAgo(env, i), HOUR); await putApps(env, f.owner, f.ownerDev, dayAgo(env, i), { 'code.exe': 40 * MIN }); }
  const [a, b] = f.kids as [Fam['kids'][0], Fam['kids'][0]];
  await putDay(env, a.u, a.dev, dayAgo(env, 0), A_TODAY, [{ activeMs: 4_000_000 }, { activeMs: 3_654_321 }]); await putApps(env, a.u, a.dev, dayAgo(env, 0), { 'steam.exe': A_APP_MS, 'chrome.exe': 2_000_000, 'zzgame.exe': 1_000_000 }, 200_000);
  for (let i = 1; i < 5; i += 1) await putDay(env, a.u, a.dev, dayAgo(env, i), 2 * HOUR);
  for (let i = 0; i < 3; i += 1) { await putDay(env, b.u, b.dev, dayAgo(env, i), 4_444_444); await putApps(env, b.u, b.dev, dayAgo(env, i), { 'discord.exe': 1_000_000 }); }
}

describe('family dashboard: consent decides every section (private by default)', () => {
  useEnv();
  it('nothing of another member is visible until they share it; own data always is; no number or app name of A leaks', async () => {
    const f = await family(env); await seed(f); const [a] = f.kids as [Fam['kids'][0]];
    const r = await get(f.owner, `/dashboard${week()}`); assert.equal(r.status, 200, r.text);
    const ms = members(r);
    assert.equal(ms[f.ownerMemberId].usage.state, 'ok'); assert.equal(ms[f.ownerMemberId].usage.totalMs, 5 * HOUR);
    for (const k of f.kids) { assert.deepEqual([ms[k.memberId].usage.state, ms[k.memberId].usage.reason], ['restricted', 'not_shared']); assert.equal(ms[k.memberId].usage.totalMs, undefined); }
    assert.deepEqual([r.json.totals.includedMembers, r.json.totals.totalMembers, r.json.totals.totalMs], [1, 3, 5 * HOUR]);
    assert.deepEqual([r.json.daily.includedMembers, r.json.apps.includedMembers, r.json.categories.includedMembers], [1, 1, 1]);
    for (const secret of [String(A_TODAY), String(A_APP_MS), 'steam.exe', 'zzgame.exe', '4444444', 'discord.exe']) assert.ok(!r.text.includes(secret), `leaked ${secret}`);
    const m = await get(f.owner, `/members/${a.memberId}/dashboard${week()}`); assert.equal(m.status, 200, m.text);
    for (const s of ['usage', 'trend', 'apps', 'categories']) assert.deepEqual([m.json[s].state, m.json[s].reason], ['restricted', 'not_shared'], s);
    assert.equal(m.json.devices.lastSyncAt, null, 'not even the time of the last synchronisation of a private member');
    for (const secret of [String(A_TODAY), 'steam.exe']) assert.ok(!m.text.includes(secret));
    const h = await get(f.owner, `/members/${a.memberId}/history${week()}`); assert.equal(h.json.state, 'restricted'); assert.deepEqual(h.json.days, []);
    const rep = await get(f.owner, `/members/${a.memberId}/reports/daily${q({ today: utcToday(env) })}`); assert.equal(rep.json.state, 'restricted'); assert.ok(!rep.text.includes(String(A_TODAY)));
  });

  it('each category opens exactly its own part: screenTime = totals, usageHistory = series, appUsage = applications, appCategories = categories', async () => {
    const f = await family(env); await seed(f); const [a] = f.kids as [Fam['kids'][0]];
    await shareWith(env, a.u, { screenTime: true });
    let m = (await get(f.owner, `/members/${a.memberId}/dashboard${week()}`)).json;
    assert.equal(m.usage.state, 'ok'); assert.equal(m.usage.totalMs, A_TODAY + 4 * 2 * HOUR); assert.equal(m.usage.daysWithData, 5);
    assert.equal(m.trend.state, 'restricted'); assert.equal(m.apps.state, 'restricted'); assert.equal(m.categories.state, 'restricted');
    await shareWith(env, a.u, { usageHistory: true });
    m = (await get(f.owner, `/members/${a.memberId}/dashboard${week()}`)).json;
    assert.equal(m.trend.state, 'ok'); assert.equal(m.trend.daily.length, 7); assert.equal(m.trend.daily.find((d: any) => d.day === dayAgo(env, 0)).activeMs, A_TODAY);
    assert.equal(m.apps.state, 'restricted');
    await shareWith(env, a.u, { appUsage: true });
    m = (await get(f.owner, `/members/${a.memberId}/dashboard${week()}`)).json;
    assert.equal(m.apps.state, 'ok'); assert.equal(m.apps.top[0].app, 'steam.exe'); assert.equal(m.apps.top[0].ms, A_APP_MS); assert.ok(!('category' in m.apps.top[0]), 'categories stay private until shared');
    assert.equal(m.categories.state, 'restricted');
    await shareWith(env, a.u, { appCategories: true });
    m = (await get(f.owner, `/members/${a.memberId}/dashboard${week()}`)).json;
    assert.equal(m.categories.state, 'ok'); assert.equal(m.apps.top[0].category, 'Games');
    const cat = Object.fromEntries(m.categories.items.map((i: any) => [i.category, i.ms])); assert.deepEqual(cat, { Games: A_APP_MS, Other: 2_000_000 + 1_000_000 + 200_000 });
  });

  it('family sections only sum members whose category the VIEWER may read, and say how many that is', async () => {
    const f = await family(env); await seed(f); const [a, b] = f.kids as [Fam['kids'][0], Fam['kids'][0]];
    await shareWith(env, a.u, { screenTime: true }); await shareWith(env, b.u, { screenTime: true, appUsage: true });
    const r = await get(f.owner, `/dashboard${week()}`); const ms = members(r);
    const aTotal = A_TODAY + 4 * 2 * HOUR; const bTotal = 3 * 4_444_444;
    assert.equal(r.json.totals.totalMs, 5 * HOUR + aTotal + bTotal); assert.equal(r.json.totals.includedMembers, 3);
    assert.ok(Math.abs(ms[a.memberId].usage.share + ms[b.memberId].usage.share + ms[f.ownerMemberId].usage.share - 1) < 1e-9, 'distribution adds up to 100%');
    assert.equal(r.json.daily.includedMembers, 1, 'nobody shared usageHistory: only the viewer\'s own history is in the family series');
    assert.equal(r.json.apps.includedMembers, 2); const names = r.json.apps.top.map((t: any) => t.app); assert.ok(names.includes('discord.exe') && names.includes('code.exe') && !names.includes('steam.exe'), 'A did not share appUsage');
    assert.equal(r.json.categories.includedMembers, 1);
  });

  it('a Parent role alone opens nothing; the permission memberData.view is required as well (denied parent: no_permission)', async () => {
    const f = await family(env, { parents: 1 }); await seed(f); const [a] = f.kids as [Fam['kids'][0]]; const p = f.pars[0] as Fam['pars'][0];
    await shareWith(env, a.u, ALL_SHARED);
    assert.equal((await get(p.u, `/members/${a.memberId}/dashboard${week()}`)).json.usage.state, 'ok', 'consent + parent permission = visible');
    const deny = await call(env, f.owner, 'PUT', `/members/${p.memberId}/permissions`, { grant: [], deny: ['memberData.view'] }); assert.equal(deny.status, 200, deny.text);
    const m = await get(p.u, `/members/${a.memberId}/dashboard${week()}`);
    for (const s of ['usage', 'trend', 'apps', 'categories']) assert.deepEqual([m.json[s].state, m.json[s].reason], ['restricted', 'no_permission'], s);
    assert.ok(!m.text.includes(String(A_TODAY)));
    const ov = await get(p.u, `/dashboard${week()}`); assert.equal(members(ov)[a.memberId].usage.reason, 'no_permission'); assert.equal(ov.json.totals.includedMembers, 1);
  });

  it('a Child sees only their own data even when everybody shares everything; siblings stay closed', async () => {
    const f = await family(env); await seed(f); const [a, b] = f.kids as [Fam['kids'][0], Fam['kids'][0]];
    await shareWith(env, a.u, ALL_SHARED); await shareWith(env, f.owner, ALL_SHARED);
    const m = await get(b.u, `/members/${a.memberId}/dashboard${week()}`); assert.equal(m.json.usage.reason, 'no_permission'); assert.ok(!m.text.includes(String(A_TODAY)));
    const o = await get(b.u, `/members/${f.ownerMemberId}/dashboard${week()}`); assert.equal(o.json.usage.state, 'restricted');
    const own = await get(b.u, `/members/${b.memberId}/dashboard${week()}`); assert.equal(own.json.usage.state, 'ok'); assert.equal(own.json.usage.totalMs, 3 * 4_444_444); assert.equal(own.json.member.isMe, true);
    const ov = await get(b.u, `/dashboard${week()}`); assert.equal(ov.json.totals.includedMembers, 1); assert.equal(ov.json.totals.totalMs, 3 * 4_444_444);
  });

  it('a revoked consent is effective on the very next request', async () => {
    const f = await family(env); await seed(f); const [a] = f.kids as [Fam['kids'][0]];
    await shareWith(env, a.u, ALL_SHARED);
    assert.equal((await get(f.owner, `/members/${a.memberId}/dashboard${week()}`)).json.apps.state, 'ok');
    await shareWith(env, a.u, { appUsage: false });
    const after1 = await get(f.owner, `/members/${a.memberId}/dashboard${week()}`); assert.equal(after1.json.apps.state, 'restricted'); assert.ok(!after1.text.includes('steam.exe'));
    await shareWith(env, a.u, { screenTime: false, usageHistory: false, appCategories: false, individualReports: false });
    const after2 = await get(f.owner, `/dashboard${week()}`); assert.equal(members(after2)[a.memberId].usage.state, 'restricted'); assert.equal(after2.json.totals.includedMembers, 1, 'only the owner\'s own data is left'); assert.ok(!after2.text.includes(String(A_TODAY)));
  });

  it('own data is complete without any sharing, and the owner\'s own dashboard does not depend on consent', async () => {
    const f = await family(env); await seed(f);
    const m = await get(f.owner, `/members/${f.ownerMemberId}/dashboard${week()}`); assert.equal(m.json.usage.state, 'ok'); assert.equal(m.json.apps.state, 'ok'); assert.equal(m.json.categories.state, 'ok');
    assert.equal(m.json.devices.scope, 'own'); assert.deepEqual(Object.values(m.json.access).map((x: any) => x.reason), ['self', 'self', 'self', 'self', 'self']);
  });
});

describe('family dashboard: membership changes revoke access immediately', () => {
  useEnv();
  it('a removed member disappears from the family numbers; the removed member and former members get nothing', async () => {
    const f = await family(env); await seed(f); const [a] = f.kids as [Fam['kids'][0]];
    await shareWith(env, a.u, ALL_SHARED); await shareWith(env, f.owner, ALL_SHARED);
    assert.equal(members(await get(f.owner, `/dashboard${week()}`))[a.memberId].usage.state, 'ok');
    assert.equal((await call(env, f.owner, 'DELETE', `/members/${a.memberId}`)).status, 200);
    const ov = await get(f.owner, `/dashboard${week()}`); assert.equal(members(ov)[a.memberId], undefined); assert.equal(ov.json.totals.totalMembers, 2); assert.ok(!ov.text.includes(String(A_TODAY)));
    const gone = await get(f.owner, `/members/${a.memberId}/dashboard${week()}`); assert.equal(gone.status, 404); assert.equal(errCode(gone), 'member_not_found');
    for (const p of ['/dashboard', `/members/${f.ownerMemberId}/dashboard`, `/members/${f.ownerMemberId}/history`, `/members/${f.ownerMemberId}/reports/daily`]) { const x = await get(a.u, `${p}${week()}`); assert.equal(x.status, 404, p); assert.equal(errCode(x), 'family_not_found', p); assert.ok(!x.text.includes(String(5 * HOUR))); }
    // still true after the former member's own sharing choices are changed or the family is re-joined by somebody else
    assert.equal((await get(a.u, `/dashboard${week()}`)).status, 404);
  });

  it('leaving the family closes the dashboard both ways; the left member\'s history is not reachable through any id', async () => {
    const f = await family(env); await seed(f); const [a] = f.kids as [Fam['kids'][0]];
    await shareWith(env, a.u, ALL_SHARED);
    assert.equal((await call(env, a.u, 'POST', '/leave', { confirm: true })).status, 200);
    assert.equal((await get(a.u, `/dashboard${week()}`)).status, 404);
    const x = await get(f.owner, `/members/${a.memberId}/history${week()}`); assert.equal(x.status, 404); assert.ok(!x.text.includes(String(A_TODAY)));
  });

  it('a dissolved family leaves nobody a dashboard', async () => {
    const f = await family(env); await seed(f);
    assert.equal((await call(env, f.owner, 'POST', '/dissolve', { confirm: true })).status, 200);
    assert.equal((await get(f.owner, `/dashboard${week()}`)).status, 404);
  });

  it('a member of ANOTHER family (or an unknown id) is "not found", exactly like a missing member', async () => {
    const f = await family(env); await seed(f); const g = await family(env); const [a] = f.kids as [Fam['kids'][0]];
    await shareWith(env, a.u, ALL_SHARED);
    for (const p of [`/members/${a.memberId}/dashboard`, `/members/${a.memberId}/history`, `/members/${a.memberId}/reports/weekly`, '/members/00000000-0000-4000-8000-000000000000/dashboard']) { const x = await get(g.owner, `${p}${week()}`); assert.equal(x.status, 404, p); assert.equal(errCode(x), 'member_not_found', p); }
  });

  it('unauthenticated, malformed ids and unsupported methods are refused', async () => {
    const f = await family(env);
    assert.equal((await env.call('GET', `/v1/family/dashboard${week()}`)).status, 401);
    assert.equal((await get(f.owner, `/members/not-a-uuid/dashboard`)).status, 400);
    assert.equal((await get(f.owner, `/members/${f.ownerMemberId}/reports/yearly`)).status, 400);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call(env, f.owner, m, '/dashboard', {})).status, 404, `${m} /dashboard does not exist: the dashboard is read-only`);
  });
});

describe('family dashboard: only linked computers of other members count', () => {
  useEnv();
  it('another member\'s unlinked and removed computers are never read; the member\'s own dashboard counts every non-removed one', async () => {
    const f = await family(env); const [a] = f.kids as [Fam['kids'][0]];
    const hidden = await device(env, a.u, 'Hidden PC'); const gone = await device(env, a.u, 'Old PC'); await linkDevice(env, a.u, gone.id);
    await putDay(env, a.u, a.dev, dayAgo(env, 0), HOUR); await putDay(env, a.u, hidden.id, dayAgo(env, 0), 5_555_555); await putDay(env, a.u, gone.id, dayAgo(env, 0), 6_666_666);
    await env.pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [gone.id]);   // removed from the account (Device Management sets revoked_at)
    await shareWith(env, a.u, ALL_SHARED);
    const viewer = await get(f.owner, `/members/${a.memberId}/dashboard${week()}`); assert.equal(viewer.json.usage.totalMs, HOUR); assert.equal(viewer.json.devices.count, 1); assert.equal(viewer.json.devices.scope, 'family-linked');
    assert.ok(!viewer.text.includes('5555555') && !viewer.text.includes('6666666'));
    const self = await get(a.u, `/members/${a.memberId}/dashboard${week()}`); assert.equal(self.json.usage.totalMs, HOUR + 5_555_555, 'own view: every non-removed computer, never the removed one'); assert.equal(self.json.devices.count, 2);
  });

  it('a member with consent but no linked computer shows "no devices shared", not zero', async () => {
    const f = await family(env); const [a] = f.kids as [Fam['kids'][0]];
    await env.pool.query('DELETE FROM family_devices WHERE device_id = $1', [a.dev]); await putDay(env, a.u, a.dev, dayAgo(env, 0), HOUR);
    await shareWith(env, a.u, ALL_SHARED);
    const m = await get(f.owner, `/members/${a.memberId}/dashboard${week()}`); assert.deepEqual([m.json.usage.state, m.json.usage.reason], ['empty', 'no_devices_shared']); assert.equal(m.json.usage.totalMs, undefined);
    const ov = await get(f.owner, `/dashboard${week()}`); assert.equal(members(ov)[a.memberId].usage.reason, 'no_devices_shared');
  });

  it('the device list follows the Stage 1 consent (deviceInfo): without it only the name and the owner', async () => {
    const f = await family(env); const [a] = f.kids as [Fam['kids'][0]];
    const ov = await get(f.owner, `/dashboard${week()}`); const dev = ov.json.devices.find((d: any) => d.id === a.dev);
    assert.equal(dev.detailHidden, true); assert.equal(dev.detail, null); assert.equal(dev.owner.memberId, a.memberId);
    await shareWith(env, a.u, { deviceInfo: true }); const ov2 = await get(f.owner, `/dashboard${week()}`); assert.ok(ov2.json.devices.find((d: any) => d.id === a.dev).detail);
  });
});

describe('family dashboard: missing, delayed and incomplete data', () => {
  useEnv();
  it('no documents = "no data" (never 0); a real zero-minute day is a real zero; one member without data does not break the rest', async () => {
    const f = await family(env); const [a, b] = f.kids as [Fam['kids'][0], Fam['kids'][0]];
    await shareWith(env, a.u, ALL_SHARED); await shareWith(env, b.u, ALL_SHARED);
    await putDay(env, b.u, b.dev, dayAgo(env, 1), 0); await putDay(env, f.owner, f.ownerDev, dayAgo(env, 0), HOUR);
    const r = await get(f.owner, `/dashboard${week()}`); assert.equal(r.status, 200); const ms = members(r);
    assert.deepEqual([ms[a.memberId].usage.state, ms[a.memberId].usage.reason], ['empty', 'no_data']);
    assert.deepEqual([ms[b.memberId].usage.state, ms[b.memberId].usage.totalMs, ms[b.memberId].usage.daysWithData], ['ok', 0, 1]);
    assert.equal(ms[f.ownerMemberId].usage.totalMs, HOUR); assert.equal(r.json.totals.totalMs, HOUR); assert.equal(r.json.totals.daysWithData, 2);
    const day0 = r.json.daily.days.find((d: any) => d.day === dayAgo(env, 0)); const dayX = r.json.daily.days.find((d: any) => d.day === dayAgo(env, 3));
    assert.equal(day0.activeMs, HOUR); assert.equal(dayX.activeMs, null, 'a day without any document is null, not 0');
    const empty = await get(f.owner, `/members/${a.memberId}/dashboard${week()}`); for (const s of ['usage', 'trend', 'apps', 'categories']) assert.equal(empty.json[s].state, 'empty', s);
  });

  it('a completely empty family still answers (empty states everywhere, 200)', async () => {
    const f = await family(env);
    const r = await get(f.owner, `/dashboard${week()}`); assert.equal(r.status, 200); assert.equal(r.json.totals.state, 'empty'); assert.equal(r.json.daily.state, 'empty'); assert.equal(r.json.apps.state, 'empty'); assert.equal(r.json.categories.state, 'empty');
  });

  it('damaged documents are ignored instead of breaking the dashboard', async () => {
    const f = await family(env); await putDay(env, f.owner, f.ownerDev, dayAgo(env, 0), HOUR);
    await env.pool.query(`UPDATE sync_documents SET data = '{"activeMs":"oops"}'::jsonb WHERE user_id = $1 AND kind = 'day' AND doc_key = $2`, [f.owner.id, dayAgo(env, 0)]);
    await putDay(env, f.owner, f.ownerDev, dayAgo(env, 1), 2 * HOUR); await putDoc2(f.owner.id, f.ownerDev, 'apps', dayAgo(env, 1), { apps: 'not-a-map', unknownMs: 'x' }); await putDoc2(f.owner.id, f.ownerDev, 'apps', dayAgo(env, 2), { apps: { 'ok.exe': 1000, 'bad.exe': 'x', 'neg.exe': -5 }, unknownMs: -3 });
    const m = await get(f.owner, `/members/${f.ownerMemberId}/dashboard${week()}`); assert.equal(m.status, 200, m.text); assert.equal(m.json.usage.totalMs, 2 * HOUR); assert.equal(m.json.usage.daysWithData, 1);
    assert.deepEqual(m.json.apps.top.map((t: any) => [t.app, t.ms]), [['ok.exe', 1000]]);
  });
  const putDoc2 = (userId: string, dev: string, kind: string, key: string, data: unknown) => putDoc(env, userId, dev, kind, key, data);

  it('application time never exceeds Active Work of the same day and computer (unknown time is trimmed first), the day is counted as clamped', async () => {
    const f = await family(env); const d = dayAgo(env, 0);
    await putDay(env, f.owner, f.ownerDev, d, 100 * MIN); await putApps(env, f.owner, f.ownerDev, d, { 'a.exe': 60 * MIN, 'b.exe': 60 * MIN }, 20 * MIN);        // 140 min attributed, 100 min active
    const m = await get(f.owner, `/members/${f.ownerMemberId}/dashboard${week()}`);
    assert.equal(m.json.apps.clampedDays, 1); assert.equal(m.json.apps.unknownMs, 0, 'unknown time goes first'); assert.equal(m.json.apps.attributedMs, 5_999_998);
    const per = m.json.apps.top.map((t: any) => t.ms); assert.deepEqual(per, [2_999_999, 2_999_999], 'then the programs proportionally, rounded down per program exactly like the desktop (stats.js)'); assert.ok(m.json.apps.attributedMs <= m.json.usage.totalMs);
    await putApps(env, f.owner, f.ownerDev, d, { 'a.exe': 10 * MIN }, 5 * MIN);        // consistent data: untouched
    const ok = await get(f.owner, `/members/${f.ownerMemberId}/dashboard${week()}`); assert.equal(ok.json.apps.clampedDays, 0); assert.equal(ok.json.apps.attributedMs, 15 * MIN);
  });

  it('delayed synchronisation: apps without an Active Work document of that day are shown as they are (nothing can be checked against), data of other days is unaffected', async () => {
    const f = await family(env); await putApps(env, f.owner, f.ownerDev, dayAgo(env, 0), { 'a.exe': 30 * MIN }); await putDay(env, f.owner, f.ownerDev, dayAgo(env, 1), HOUR);
    const m = await get(f.owner, `/members/${f.ownerMemberId}/dashboard${week()}`); assert.equal(m.json.apps.top[0].ms, 30 * MIN); assert.equal(m.json.usage.totalMs, HOUR); assert.equal(m.json.apps.clampedDays, 0);
  });
});

describe('family dashboard: periods, comparisons and calendar-day boundaries', () => {
  useEnv();
  it('the range is inclusive, days outside are excluded, the previous period has the same length', async () => {
    const f = await family(env); const T = utcToday(env);
    for (let i = 0; i < 12; i += 1) await putDay(env, f.owner, f.ownerDev, addDays(T, -i), (i + 1) * 10 * MIN);
    const r = (await get(f.owner, `/members/${f.ownerMemberId}/dashboard${range(addDays(T, -2), T)}`)).json;
    assert.equal(r.usage.totalMs, (1 + 2 + 3) * 10 * MIN); assert.deepEqual([r.range.days, r.range.previous.from, r.range.previous.to], [3, addDays(T, -5), addDays(T, -3)]);
    assert.equal(r.usage.previousTotalMs, (4 + 5 + 6) * 10 * MIN); assert.equal(r.usage.comparison.available, true); assert.equal(r.usage.comparison.changeMs, -30 * MIN);
    assert.equal(r.usage.comparison.partial, true, 'the range ends today: today is not finished');
    const past = (await get(f.owner, `/members/${f.ownerMemberId}/dashboard${range(addDays(T, -4), addDays(T, -3), { today: T })}`)).json;
    assert.equal(past.usage.totalMs, (4 + 5) * 10 * MIN); assert.equal(past.usage.comparison.partial, false);
    assert.equal(past.usage.glance.today.activeMs, 10 * MIN, 'the at-a-glance block is anchored on today, not on the selected range');
    assert.deepEqual([past.usage.glance.last7.totalMs, past.usage.glance.last7.daysWithData], [(1 + 2 + 3 + 4 + 5 + 6 + 7) * 10 * MIN, 7]); assert.equal(past.usage.glance.last30.daysWithData, 12);
  });

  it('a computer in another time zone: the day key is the computer\'s own local day and is never shifted by UTC', async () => {
    const f = await family(env); const T = utcToday(env); const ahead = addDays(T, 1);
    // a member in Tokyo already is on the next calendar day: their document is keyed with it; the viewer in the same zone asks for "today" = that day
    await putDay(env, f.owner, f.ownerDev, ahead, 77 * MIN); await putDay(env, f.owner, f.ownerDev, T, 11 * MIN);
    const tokyo = (await get(f.owner, `/members/${f.ownerMemberId}/dashboard${q({ from: ahead, to: ahead, today: ahead })}`)); assert.equal(tokyo.status, 200, tokyo.text); assert.equal(tokyo.json.usage.totalMs, 77 * MIN);
    const here = (await get(f.owner, `/members/${f.ownerMemberId}/dashboard${q({ from: T, to: T, today: T })}`)).json; assert.equal(here.usage.totalMs, 11 * MIN);
    assert.equal((await get(f.owner, `/dashboard${q({ from: T, to: ahead, today: T })}`)).json.error.code, 'range_in_future');
    assert.equal(errCode(await get(f.owner, `/dashboard${q({ from: T, to: T, today: addDays(T, 3) })}`)), 'invalid_today');
  });

  it('the previous period crosses month and year boundaries correctly', async () => {
    const f = await family(env); const T = utcToday(env);
    const r = await get(f.owner, `/dashboard${q({ from: '2026-03-01', to: '2026-03-31', today: T })}`); assert.deepEqual([r.json.range.days, r.json.range.previous.from, r.json.range.previous.to], [31, '2026-01-29', '2026-02-28']);
  });

  it('a comparison is refused when one side lacks real data and says why', async () => {
    const f = await family(env); const T = utcToday(env); await putDay(env, f.owner, f.ownerDev, T, HOUR);
    const m = (await get(f.owner, `/members/${f.ownerMemberId}/dashboard${range(addDays(T, -6), T)}`)).json;
    assert.deepEqual(m.usage.comparison, { available: false, reason: 'not-enough-current-data' });
  });

  it('weekly and monthly buckets and the trend arrive with the usage history', async () => {
    const f = await family(env); const T = utcToday(env);
    for (let i = 0; i < 20; i += 1) await putDay(env, f.owner, f.ownerDev, addDays(T, -i), i < 10 ? 3 * HOUR : HOUR);
    const m = (await get(f.owner, `/members/${f.ownerMemberId}/dashboard${range(addDays(T, -19), T)}`)).json;
    assert.equal(m.trend.state, 'ok'); assert.equal(m.trend.trend.direction, 'up'); assert.ok(m.trend.weekly.length >= 3); assert.equal(m.trend.weekly.reduce((a: number, w: any) => a + w.activeMs, 0), m.trend.totalMs);
    assert.equal(m.trend.bestDay.activeMs, 3 * HOUR); assert.equal(m.trend.daily.length, 20);
  });

  it('own-category overrides and the built-in table decide categories; another member\'s override never applies', async () => {
    const f = await family(env); const [a] = f.kids as [Fam['kids'][0]]; const d = dayAgo(env, 0);
    await putDay(env, f.owner, f.ownerDev, d, 4 * HOUR); await putApps(env, f.owner, f.ownerDev, d, { 'chrome.exe': HOUR, 'steam.exe': HOUR, 'code.exe': HOUR });
    await putOverride(env, f.owner, 'chrome.exe', 'Education'); await putOverride(env, a.u, 'steam.exe', 'Productivity');
    const m = (await get(f.owner, `/members/${f.ownerMemberId}/dashboard${week()}`)).json; const c = Object.fromEntries(m.categories.items.map((i: any) => [i.category, i.ms]));
    assert.deepEqual(c, { Education: HOUR, Games: HOUR, Productivity: HOUR });
  });

  it('input validation: bad or missing dates are 400 with a stable code', async () => {
    const f = await family(env);
    for (const [qs, code] of [['?from=2026-13-01&to=2026-13-02', 'invalid_range'], ['?from=2026-11-10&to=2026-11-01', 'invalid_range'], ['?from=2019-01-01&to=2019-01-02', 'invalid_range'], [`?from=${addDays(utcToday(env), -400)}&to=${utcToday(env)}`, 'range_too_long'], ['?from[]=2026-11-01&to=2026-11-02', 'invalid_range']] as const) {
      const r = await get(f.owner, `/dashboard${qs}`); assert.equal(r.status, 400, qs); assert.equal(errCode(r), code, qs);
    }
    assert.equal(errCode(await get(f.owner, `/members/${f.ownerMemberId}/history${week()}&limit=0`)), 'validation_failed'); assert.equal(errCode(await get(f.owner, `/members/${f.ownerMemberId}/history${week()}&before=nope`)), 'validation_failed');
    assert.equal((await get(f.owner, '/dashboard')).status, 200, 'no query at all means today');
  });
});

describe('family dashboard: history list (paginated) and reports', () => {
  useEnv();
  it('history pages are newest first, bounded by the range, and chain through nextBefore without gaps or repeats', async () => {
    const f = await family(env); const T = utcToday(env);
    for (let i = 0; i < 45; i += 1) await putDay(env, f.owner, f.ownerDev, addDays(T, -i), (i + 1) * MIN, [{ activeMs: (i + 1) * MIN }]);
    const base = q({ from: addDays(T, -59), to: T, today: T, limit: 20 }); const seen: string[] = [];
    let before: string | null = null; let pages = 0;
    do {
      const r = await get(f.owner, `/members/${f.ownerMemberId}/history${base}${before ? `&before=${before}` : ''}`); assert.equal(r.status, 200, r.text);
      assert.ok(r.json.days.length <= 20); seen.push(...r.json.days.map((d: any) => d.day)); before = r.json.nextBefore; pages += 1;
      for (const d of r.json.days) assert.deepEqual([d.sessions, d.longestSessionMs], [1, d.activeMs]);
    } while (before && pages < 10);
    assert.equal(pages, 3); assert.equal(seen.length, 45); assert.equal(new Set(seen).size, 45); assert.deepEqual(seen, [...seen].sort().reverse());
    assert.equal(seen[0], T); assert.equal(seen[44], addDays(T, -44));
    const first = await get(f.owner, `/members/${f.ownerMemberId}/history${q({ from: addDays(T, -2), to: T, today: T })}`); assert.equal(first.json.days.length, 3); assert.equal(first.json.nextBefore, null);
  });

  it('history of another member needs usageHistory consent', async () => {
    const f = await family(env); const [a] = f.kids as [Fam['kids'][0]]; await putDay(env, a.u, a.dev, dayAgo(env, 0), HOUR);
    await shareWith(env, a.u, { screenTime: true }); assert.equal((await get(f.owner, `/members/${a.memberId}/history${week()}`)).json.state, 'restricted');
    await shareWith(env, a.u, { usageHistory: true }); const h = await get(f.owner, `/members/${a.memberId}/history${week()}`); assert.equal(h.json.state, 'ok'); assert.equal(h.json.days[0].activeMs, HOUR);
  });

  it('daily, weekly and monthly reports: period, totals, comparison, navigation and the incomplete flag', async () => {
    const f = await family(env); const T = utcToday(env);
    for (let i = 0; i < 70; i += 1) { await putDay(env, f.owner, f.ownerDev, addDays(T, -i), 2 * HOUR); await putApps(env, f.owner, f.ownerDev, addDays(T, -i), { 'code.exe': HOUR }); }
    const mid = `/members/${f.ownerMemberId}/reports`;
    const d = (await get(f.owner, `${mid}/daily${q({ key: addDays(T, -3), today: T })}`)).json; assert.equal(d.state, 'ok'); assert.equal(d.period.key, addDays(T, -3)); assert.equal(d.usage.totalMs, 2 * HOUR); assert.equal(d.incomplete, false); assert.equal(d.navigation.next, addDays(T, -2));
    const today = (await get(f.owner, `${mid}/daily${q({ today: T })}`)).json; assert.equal(today.period.key, T); assert.equal(today.incomplete, true); assert.equal(today.navigation.next, null);
    const w = (await get(f.owner, `${mid}/weekly${q({ key: addDays(T, -14), today: T })}`)).json; assert.equal(w.period.days, 7); assert.equal(w.usage.totalMs, 14 * HOUR); assert.equal(w.usage.comparison.available, true); assert.equal(w.usage.comparison.changeMs, 0);
    assert.equal(w.history.days.length, 7); assert.equal(w.apps.top[0].app, 'code.exe');
    const mo = (await get(f.owner, `${mid}/monthly${q({ key: addDays(T, -35).slice(0, 7), today: T })}`)).json; assert.equal(mo.state === 'ok' || mo.state === 'empty', true); assert.equal(mo.period.kind, 'monthly');
    const first = (await get(f.owner, `${mid}/daily${q({ key: addDays(T, -69), today: T })}`)).json; assert.equal(first.navigation.previous, null, 'nothing before the first recorded day');
    const old = (await get(f.owner, `${mid}/daily${q({ key: addDays(T, -200), today: T })}`)); assert.equal(old.json.state, 'empty'); assert.equal(old.json.reason, 'no_data');
    assert.equal(errCode(await get(f.owner, `${mid}/daily${q({ key: addDays(T, 5), today: T })}`)), 'report_future_period'); assert.equal(errCode(await get(f.owner, `${mid}/weekly${q({ key: 'x', today: T })}`)), 'report_invalid_key');
  });

  it('reports need individualReports, and each section inside still needs its own category', async () => {
    const f = await family(env); const [a] = f.kids as [Fam['kids'][0]]; const T = utcToday(env); const d = dayAgo(env, 1);
    await putDay(env, a.u, a.dev, d, A_TODAY); await putApps(env, a.u, a.dev, d, { 'steam.exe': A_APP_MS });
    const url = `/members/${a.memberId}/reports/daily${q({ key: d, today: T })}`;
    await shareWith(env, a.u, { screenTime: true, appUsage: true, appCategories: true, usageHistory: true });
    let r = await get(f.owner, url); assert.equal(r.json.state, 'restricted'); assert.ok(!r.text.includes(String(A_TODAY)) && !r.text.includes('steam.exe'), 'every category shared but not the reports: closed');
    await shareWith(env, a.u, { individualReports: true, appUsage: false, appCategories: false });
    r = await get(f.owner, url); assert.equal(r.json.state, 'ok'); assert.equal(r.json.usage.totalMs, A_TODAY); assert.equal(r.json.apps.state, 'restricted'); assert.equal(r.json.categories.state, 'restricted'); assert.ok(!r.text.includes('steam.exe'));
    await shareWith(env, a.u, { screenTime: false, usageHistory: false });
    r = await get(f.owner, url); assert.equal(r.json.usage.state, 'restricted'); assert.equal(r.json.history.state, 'restricted'); assert.equal(r.json.lastSyncAt, null); assert.ok(!r.text.includes(String(A_TODAY)));
  });
});

describe('family dashboard: what the API never does', () => {
  useEnv();
  it('answers with aggregates only: no raw documents, user ids, e-mail addresses, hourly buckets or sessions', async () => {
    const f = await family(env); await seed(f); const [a] = f.kids as [Fam['kids'][0]]; await shareWith(env, a.u, ALL_SHARED);
    const texts = [(await get(f.owner, `/dashboard${week()}`)).text, (await get(f.owner, `/members/${a.memberId}/dashboard${week()}`)).text, (await get(f.owner, `/members/${a.memberId}/history${week()}`)).text, (await get(f.owner, `/members/${a.memberId}/reports/daily${q({ today: utcToday(env) })}`)).text];
    for (const t of texts) {
      for (const bad of [a.u.id, f.owner.id, a.u.email, f.owner.email, '"hourly"', '"sessions":[', 'dayKey', 'data_hash', 'password', 'token']) assert.ok(!t.includes(bad), `response contains ${bad}`);
      assert.ok(t.length < 40_000, 'compact');
    }
  });

  it('is strictly read-only: it writes nothing and Stage 3 does not exist (no limits, blocking or schedules)', async () => {
    const f = await family(env); await seed(f); const [a] = f.kids as [Fam['kids'][0]]; await shareWith(env, a.u, ALL_SHARED);
    const count = async () => JSON.stringify((await env.pool.query(`SELECT (SELECT count(*) FROM sync_documents) docs, (SELECT count(*) FROM family_audit_log) audit, (SELECT count(*) FROM family_member_privacy) privacy, (SELECT count(*) FROM devices) devices, (SELECT count(*) FROM family_devices) fdev, (SELECT count(*) FROM sessions) sessions`)).rows[0]);
    const before = await count();
    for (const p of [`/dashboard${week()}`, `/members/${a.memberId}/dashboard${week()}`, `/members/${a.memberId}/history${week()}`, `/members/${a.memberId}/reports/weekly`]) assert.equal((await get(f.owner, p)).status, 200, p);
    assert.equal(await count(), before);
    for (const p of ['/limits', '/schedules', '/restrictions', '/blocked-apps', '/members/' + a.memberId + '/limits']) assert.equal((await get(f.owner, p)).status, 404, p);
    const tables = (await env.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [env.schema])).rows.map((r) => r.table_name as string);
    assert.ok(!tables.some((t) => /limit|schedule|restrict|block/.test(t)), 'no Stage 3 tables');
  });

  it('needs no migration: the schema version is still the Stage 1 one', async () => {
    const v = (await env.pool.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]; assert.equal(v.v, 6);
  });
});

describe('family dashboard: size and speed', () => {
  useEnv();
  it('a big family (12 members, 2 computers each, a year of daily documents and app documents) answers a year-long overview quickly, with bounded output', async () => {
    const f = await family(env, { children: 11 }); const T = utcToday(env);
    const all = [{ u: f.owner, dev: f.ownerDev, memberId: f.ownerMemberId }, ...f.kids];
    for (const m of all) { if (m.u !== f.owner) await shareWith(env, m.u, ALL_SHARED); await linkOrNot(m.u, m.dev); }
    const second: { u: typeof f.owner; dev: string }[] = [];
    for (const m of all) { const d = await device(env, m.u, 'Second PC'); await linkDevice(env, m.u, d.id); second.push({ u: m.u, dev: d.id }); }
    for (const m of [...all.map((x) => ({ u: x.u, dev: x.dev })), ...second]) {
      await env.pool.query(`INSERT INTO sync_documents (user_id, device_id, kind, doc_key, data, data_hash, size_bytes, client_updated_at)
        SELECT $1, $2, 'day', to_char($3::date - g, 'YYYY-MM-DD'), jsonb_build_object('version', 1, 'dayKey', to_char($3::date - g, 'YYYY-MM-DD'), 'activeMs', 3600000 + (g % 7) * 600000, 'sessions', '[]'::jsonb), 'h', 10, now() FROM generate_series(0, 364) g`, [m.u.id, m.dev, T]);
      await env.pool.query(`INSERT INTO sync_documents (user_id, device_id, kind, doc_key, data, data_hash, size_bytes, client_updated_at)
        SELECT $1, $2, 'apps', to_char($3::date - g, 'YYYY-MM-DD'), jsonb_build_object('version', 1, 'dayKey', to_char($3::date - g, 'YYYY-MM-DD'), 'attributedMs', 3000000, 'unknownMs', 0, 'apps', (SELECT jsonb_object_agg('app' || n || '.exe', 100000 + n) FROM generate_series(1, 25) n), 'hourly', '[]'::jsonb), 'h', 10, now() FROM generate_series(0, 364) g`, [m.u.id, m.dev, T]);
    }
    await env.pool.query('ANALYZE sync_documents');   // what autovacuum does in a real database after a bulk load
    const t0 = Date.now(); const r = await get(f.owner, `/dashboard${q({ from: addDays(T, -364), to: T, today: T })}`); const ms = Date.now() - t0;
    assert.equal(r.status, 200, r.text); assert.equal(r.json.totals.includedMembers, 12); assert.equal(r.json.members.length, 12); assert.equal(r.json.daily.granularity, 'week'); assert.ok(r.json.daily.days.length >= 52 && r.json.daily.days.length <= 54, 'a year is weekly points'); assert.ok(r.json.apps.top.length <= 15);
    assert.ok(r.text.length < 100_000, `bounded response (${r.text.length} bytes)`); console.log(`      year overview of 12 members / 24 computers / ${24 * 365 * 2} documents: ${ms} ms, ${r.text.length} bytes`);
    assert.ok(ms < 5000, `took ${ms} ms`);
    const t1 = Date.now(); const m1 = await get(f.owner, `/members/${f.kids[0]!.memberId}/dashboard${q({ from: addDays(T, -364), to: T, today: T })}`); assert.equal(m1.status, 200); assert.ok(Date.now() - t1 < 3000);
  });
  async function linkOrNot(_u: unknown, _d: string) { /* the helper family() already linked the first computer */ }
});
