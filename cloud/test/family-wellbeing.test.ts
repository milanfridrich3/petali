import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';
import { KINDS } from '../src/modules/sync/kinds';
import { errCode } from './family-helpers';
import { ALL_SHARED, call, dayAgo, device, family, putDoc, q, shareWith, user, type Fam } from './family-dashboard-helpers';

let env: TestEnv;
function useEnv() { before(async () => { env = await createTestEnv(); }); after(async () => { await env.close(); }); }
const W = '/wellbeing';
const LIMIT = { kind: 'limit', config: { scope: 'total', minutes: 120 } };
const wdoc = (day: string, limits: { exceeded: boolean }[], breaks = { reminders: 0, dismissed: 0, taken: 0 }, viol = 0) => ({ version: 1, dayKey: day, activeMs: 1000, limits: limits.map((l, i) => ({ ruleId: `r${i}`, scope: 'total', limitMs: 1, usedMs: 2, exceeded: l.exceeded, warned: true })), breaks, schedules: viol ? [{ ruleId: 's', violationMs: viol }] : [] });

describe('wellbeing rules: ownership and consent', () => {
  useEnv();
  it('a member creates, changes and removes their own rules directly; they are active at once', async () => {
    const f = await family(env); const k = f.kids[0]!;
    const c = await call(env, k.u, 'POST', `${W}/rules`, LIMIT); assert.equal(c.status, 201, c.text);
    assert.equal(c.json.status, 'active'); assert.equal(c.json.origin, 'self');
    const u = await call(env, k.u, 'PUT', `${W}/rules/${c.json.id}`, { config: { scope: 'total', minutes: 90 } }); assert.equal(u.status, 200, u.text);
    assert.equal(u.json.config.minutes, 90); assert.equal(u.json.version, 2);
    const mine = await call(env, k.u, 'GET', `${W}/my-rules`); assert.equal(mine.json.rules.length, 1); assert.equal(mine.json.rules[0].config.minutes, 90);
    assert.equal((await call(env, k.u, 'DELETE', `${W}/rules/${c.json.id}`)).status, 200);
    assert.equal((await call(env, k.u, 'GET', `${W}/my-rules`)).json.rules.length, 0);
  });
  it('a parent can only PROPOSE: a proposal is pending and is never delivered to the child computer until accepted', async () => {
    const f = await family(env); const k = f.kids[0]!;
    const p = await call(env, f.owner, 'POST', `/members/${k.memberId}${W}/rules`, LIMIT); assert.equal(p.status, 201, p.text);
    assert.equal(p.json.status, 'pending'); assert.equal(p.json.proposedByMe, true);
    assert.equal((await call(env, k.u, 'GET', `${W}/my-rules`)).json.rules.length, 0);
    const kv = await call(env, k.u, 'GET', `${W}/rules`); assert.equal(kv.json.rules[0].awaitingMyAnswer, true);
    const a = await call(env, k.u, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: true }); assert.equal(a.status, 200, a.text); assert.equal(a.json.status, 'active');
    assert.equal((await call(env, k.u, 'GET', `${W}/my-rules`)).json.rules.length, 1);
  });
  it('declining deletes the proposal; the parent cannot answer for the child; a stranger gets nothing', async () => {
    const f = await family(env); const k = f.kids[0]!;
    const p = await call(env, f.owner, 'POST', `/members/${k.memberId}${W}/rules`, LIMIT);
    assert.equal(errCode(await call(env, f.owner, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: true })), 'permission_denied');
    const o = await family(env); assert.equal(errCode(await call(env, o.owner, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: true })), 'rule_not_found');
    const d = await call(env, k.u, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: false }); assert.equal(d.json.removed, true);
    assert.equal((await call(env, f.owner, 'GET', `/members/${k.memberId}${W}/rules`)).json.rules.length, 0);
  });
  it('a change to an active rule is stored aside until accepted; the active config stays in force meanwhile', async () => {
    const f = await family(env); const k = f.kids[0]!;
    const p = await call(env, f.owner, 'POST', `/members/${k.memberId}${W}/rules`, LIMIT); await call(env, k.u, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: true });
    const ch = await call(env, f.owner, 'PUT', `${W}/rules/${p.json.id}`, { config: { scope: 'total', minutes: 30 } }); assert.equal(ch.status, 200, ch.text); assert.equal(ch.json.config.minutes, 120); assert.equal(ch.json.pendingChange.config.minutes, 30);
    assert.equal((await call(env, k.u, 'GET', `${W}/my-rules`)).json.rules[0].config.minutes, 120);
    const no = await call(env, k.u, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: false }); assert.equal(no.json.pendingChange, null); assert.equal(no.json.config.minutes, 120);
    await call(env, f.owner, 'PUT', `${W}/rules/${p.json.id}`, { config: { scope: 'total', minutes: 45 } });
    const yes = await call(env, k.u, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: true }); assert.equal(yes.json.config.minutes, 45); assert.equal(yes.json.version, 3);
    assert.equal(errCode(await call(env, k.u, 'POST', `${W}/rules/${p.json.id}/answer`, { accept: true })), 'nothing_to_answer');
  });
  it('a child cannot propose to anyone; a parent cannot touch the owner or another parent unless owner; permission can be denied', async () => {
    const f = await family(env, { parents: 1, children: 1 }); const k = f.kids[0]!; const p = f.pars[0]!;
    assert.equal(errCode(await call(env, k.u, 'POST', `/members/${f.ownerMemberId}${W}/rules`, LIMIT)), 'permission_denied');
    assert.equal(errCode(await call(env, p.u, 'POST', `/members/${f.ownerMemberId}${W}/rules`, LIMIT)), 'owner_protected');
    assert.equal(errCode(await call(env, p.u, 'POST', `/members/${p.memberId}${W}/rules`, { ...LIMIT })), undefined);      // own rules are always allowed
    assert.equal((await call(env, f.owner, 'POST', `/members/${p.memberId}${W}/rules`, LIMIT)).status, 201);
    assert.equal(errCode(await call(env, k.u, 'POST', `/members/${p.memberId}${W}/rules`, LIMIT)), 'permission_denied');
    assert.equal((await call(env, f.owner, 'PUT', `/members/${p.memberId}/permissions`, { deny: ['wellbeing.manage'] })).status, 200);
    assert.equal(errCode(await call(env, p.u, 'POST', `/members/${k.memberId}${W}/rules`, LIMIT)), 'permission_denied');
  });
  it('a child cannot be granted wellbeing.manage (non-delegable)', async () => {
    const f = await family(env); const k = f.kids[0]!;
    await call(env, f.owner, 'PUT', `/members/${k.memberId}/permissions`, { grant: ['wellbeing.manage'] });
    assert.equal(errCode(await call(env, k.u, 'POST', `/members/${f.ownerMemberId}${W}/rules`, LIMIT)), 'permission_denied');
    const sib = await user(env); const m = (await call(env, f.owner, 'POST', '/invitations', { petaliId: sib.petaliId })).json;
    assert.ok(m.invitation);
  });
  it('privacy of rule lists: personal rules of a member are hidden from parents unless screen time is shared; family-set rules are always visible to managers', async () => {
    const f = await family(env); const k = f.kids[0]!;
    await call(env, k.u, 'POST', `${W}/rules`, { kind: 'limit', config: { scope: 'category', category: 'Games', minutes: 15 } });
    const prop = await call(env, f.owner, 'POST', `/members/${k.memberId}${W}/rules`, LIMIT);
    const before = await call(env, f.owner, 'GET', `/members/${k.memberId}${W}/rules`); assert.deepEqual(before.json.rules.map((r: any) => r.id), [prop.json.id]);
    await shareWith(env, k.u, { screenTime: true });
    assert.equal((await call(env, f.owner, 'GET', `/members/${k.memberId}${W}/rules`)).json.rules.length, 2);
    assert.equal(errCode(await call(env, k.u, 'GET', `/members/${f.ownerMemberId}${W}/rules`)), 'permission_denied');
  });
  it('a parent can withdraw their proposal and remove family-set rules, never the member\u2019s personal rules', async () => {
    const f = await family(env); const k = f.kids[0]!;
    const own = await call(env, k.u, 'POST', `${W}/rules`, LIMIT);
    assert.equal(errCode(await call(env, f.owner, 'DELETE', `${W}/rules/${own.json.id}`)), 'rule_is_personal');
    const prop = await call(env, f.owner, 'POST', `/members/${k.memberId}${W}/rules`, { kind: 'schedule', config: { days: [1], start: '22:00', end: '06:00' } });
    assert.equal((await call(env, f.owner, 'DELETE', `${W}/rules/${prop.json.id}`)).status, 200);
    const prop2 = await call(env, f.owner, 'POST', `/members/${k.memberId}${W}/rules`, { kind: 'schedule', config: { days: [2], start: '22:00', end: '06:00' } });
    await call(env, k.u, 'POST', `${W}/rules/${prop2.json.id}/answer`, { accept: true });
    assert.equal((await call(env, f.owner, 'DELETE', `${W}/rules/${prop2.json.id}`)).status, 200);
  });
  it('validation: bad kind/config, foreign computers, caps and the single break rule', async () => {
    const f = await family(env); const k = f.kids[0]!; const o = await device(env, f.owner, 'Owner2');
    assert.equal(errCode(await call(env, k.u, 'POST', `${W}/rules`, { kind: 'nope', config: {} })), 'invalid_rule_kind');
    assert.equal(errCode(await call(env, k.u, 'POST', `${W}/rules`, { kind: 'limit', config: { scope: 'total', minutes: 0 } })), 'invalid_rule');
    assert.equal(errCode(await call(env, k.u, 'POST', `${W}/rules`, { kind: 'limit', config: { scope: 'total', minutes: 5, deviceIds: [o.id] } })), 'invalid_rule');
    assert.equal((await call(env, k.u, 'POST', `${W}/rules`, { kind: 'limit', config: { scope: 'total', minutes: 5, deviceIds: [k.dev] } })).status, 201);
    assert.equal((await call(env, k.u, 'POST', `${W}/rules`, { kind: 'break', config: {} })).status, 201);
    assert.equal(errCode(await call(env, k.u, 'POST', `${W}/rules`, { kind: 'break', config: { intervalMinutes: 30 } })), 'break_rule_exists');
    assert.equal((await call(env, k.u, 'POST', `${W}/rules`, { extra: 1, kind: 'break', config: {} })).status, 400);
    for (let i = 0; i < 29; i += 1) assert.equal((await call(env, k.u, 'POST', `${W}/rules`, { kind: 'limit', config: { scope: 'app', app: `a${i}.exe`, minutes: 5 } })).status, 201);
    assert.equal(errCode(await call(env, k.u, 'POST', `${W}/rules`, LIMIT)), 'too_many_rules');
  });
  it('rules disappear with membership; leaving removes them; unauthenticated and no-family answers', async () => {
    const f = await family(env); const k = f.kids[0]!;
    await call(env, k.u, 'POST', `${W}/rules`, LIMIT);
    assert.equal((await env.call('GET', `/v1/family${W}/my-rules`)).status, 401);
    await call(env, f.owner, 'DELETE', `/members/${k.memberId}`);
    const mine = await call(env, k.u, 'GET', `${W}/my-rules`); assert.equal(mine.json.inFamily, false); assert.deepEqual(mine.json.rules, []);
    assert.equal((await env.pool.query('SELECT count(*)::int n FROM family_wellbeing_rules WHERE member_id = $1', [k.memberId])).rows[0].n, 0);
    assert.equal(errCode(await call(env, k.u, 'GET', `${W}/rules`)), 'family_not_found');
  });
  it('the database refuses a rule for a member of another family', async () => {
    const a = await family(env); const b = await family(env);
    await assert.rejects(env.pool.query(`INSERT INTO family_wellbeing_rules (family_id, member_id, kind, config) VALUES ($1,$2,'limit','{}')`, [a.familyId, b.kids[0]!.memberId]));
  });
  it('my-rules returns a stable revision that changes with the rules', async () => {
    const f = await family(env); const k = f.kids[0]!;
    const r0 = (await call(env, k.u, 'GET', `${W}/my-rules`)).json.revision; const c = await call(env, k.u, 'POST', `${W}/rules`, LIMIT);
    const r1 = (await call(env, k.u, 'GET', `${W}/my-rules`)).json.revision; assert.notEqual(r0, r1);
    assert.equal((await call(env, k.u, 'GET', `${W}/my-rules`)).json.revision, r1);
    await call(env, k.u, 'PUT', `${W}/rules/${c.json.id}`, { config: { scope: 'total', minutes: 5 } }); assert.notEqual((await call(env, k.u, 'GET', `${W}/my-rules`)).json.revision, r1);
  });
});

describe('wellbeing report: consent, device scoping, calculation', () => {
  useEnv();
  const seed = async (f: Fam) => { const k = f.kids[0]!;
    await putDoc(env, k.u.id, k.dev, 'wellbeing', dayAgo(env, 0), wdoc(dayAgo(env, 0), [{ exceeded: true }, { exceeded: false }], { reminders: 3, dismissed: 1, taken: 2 }, 600_000));
    await putDoc(env, k.u.id, k.dev, 'wellbeing', dayAgo(env, 1), wdoc(dayAgo(env, 1), [{ exceeded: false }]));
    await putDoc(env, k.u.id, k.dev, 'wellbeing', dayAgo(env, 8), wdoc(dayAgo(env, 8), [{ exceeded: true }, { exceeded: true }])); };
  const rep = (f: Fam, who: { token: string }, extra = {}) => call(env, who, 'GET', `/members/${f.kids[0]!.memberId}${W}/report${q({ from: dayAgo(env, 6), to: dayAgo(env, 0), today: dayAgo(env, 0), ...extra })}`);

  it('is restricted for a parent until the child shares both individual reports and screen time', async () => {
    const f = await family(env); await seed(f);
    assert.equal((await rep(f, f.owner)).json.reason, 'not_shared');
    await shareWith(env, f.kids[0]!.u, { individualReports: true }); assert.equal((await rep(f, f.owner)).json.state, 'restricted');
    await shareWith(env, f.kids[0]!.u, { screenTime: true }); assert.equal((await rep(f, f.owner)).json.state, 'ok');
    const body = JSON.stringify((await call(env, f.owner, 'GET', `/members/${f.kids[0]!.memberId}${W}/report${q({ from: dayAgo(env, 6), to: dayAgo(env, 0), today: dayAgo(env, 0) })}`)).json);
    assert.ok(!body.includes(f.kids[0]!.u.id) && !body.includes(f.kids[0]!.u.email));
    await shareWith(env, f.kids[0]!.u, { individualReports: false }); assert.equal((await rep(f, f.owner)).json.state, 'restricted');
  });
  it('the member always sees their own report with measured, calculated and comparison blocks; device list is theirs', async () => {
    const f = await family(env); await seed(f); const k = f.kids[0]!;
    const r = await rep(f, k.u); assert.equal(r.status, 200, r.text); assert.equal(r.json.state, 'ok');
    assert.equal(r.json.measured.daysWithData, 2); assert.equal(r.json.measured.daysInRange, 7); assert.equal(r.json.measured.days.filter((d: any) => d.limits === null).length, 5);
    assert.deepEqual({ ...r.json.calculated }, { daysWithData: 2, limitsEvaluated: 3, limitsExceeded: 1, limitsWithinLimit: 2, complianceRate: 66.7, daysWithAnExceededLimit: 1, breakReminders: 3, breaksDismissed: 1, breaksTaken: 2, scheduleViolationMs: 600000 });
    assert.equal(r.json.comparison.state, 'ok'); assert.equal(r.json.comparison.previous.limitsEvaluated, 2); assert.equal(r.json.comparison.complianceRateChange, 66.7);
    assert.equal(r.json.devices[0].deviceId, k.dev);
  });
  it('a day without a document is "no data", never "within the limit"; no data at all is an empty state; comparison says why it cannot be made', async () => {
    const f = await family(env); const k = f.kids[0]!;
    assert.equal((await rep(f, k.u)).json.reason, 'no_data');
    await putDoc(env, k.u.id, k.dev, 'wellbeing', dayAgo(env, 0), wdoc(dayAgo(env, 0), [{ exceeded: false }]));
    const r = await rep(f, k.u); assert.equal(r.json.comparison.state, 'unavailable'); assert.equal(r.json.comparison.reason, 'no_previous_data'); assert.equal(r.json.calculated.complianceRate, 100);
  });
  it('a parent sees only computers the child linked to the family and device names only with deviceInfo', async () => {
    const f = await family(env); const k = f.kids[0]!; const hidden = await device(env, k.u, 'Hidden PC');
    await putDoc(env, k.u.id, hidden.id, 'wellbeing', dayAgo(env, 0), wdoc(dayAgo(env, 0), [{ exceeded: true }, { exceeded: true }]));
    await putDoc(env, k.u.id, k.dev, 'wellbeing', dayAgo(env, 0), wdoc(dayAgo(env, 0), [{ exceeded: false }]));
    await shareWith(env, k.u, { screenTime: true, individualReports: true });
    const p = await rep(f, f.owner); assert.equal(p.json.calculated.limitsEvaluated, 1); assert.equal(p.json.devices, null);
    const me = await rep(f, k.u); assert.equal(me.json.calculated.limitsEvaluated, 3);
    await shareWith(env, k.u, { deviceInfo: true }); assert.equal((await rep(f, f.owner)).json.devices.length, 1);
  });
  it('sibling and foreign ids behave like unknown; invalid ranges are rejected', async () => {
    const f = await family(env, { children: 2 }); const o = await family(env);
    assert.equal((await call(env, f.kids[1]!.u, 'GET', `/members/${f.kids[0]!.memberId}${W}/report`)).json.reason, 'no_permission');
    assert.equal(errCode(await call(env, f.owner, 'GET', `/members/${o.kids[0]!.memberId}${W}/report`)), 'member_not_found');
    const k = f.kids[0]!; assert.equal(errCode(await call(env, k.u, 'GET', `/members/${k.memberId}${W}/report${q({ from: '2999-01-01', to: '2999-01-02' })}`)), 'range_in_future');
    assert.equal(errCode(await call(env, k.u, 'GET', `/members/${k.memberId}${W}/report${q({ from: 'x' })}`)), 'invalid_range');
  });
});

describe('wellbeing sync document kind', () => {
  useEnv();
  it('a computer can upload its wellbeing day; invalid documents are rejected', async () => {
    const k = KINDS['wellbeing']!; const day = dayAgo(env, 0);
    assert.equal(k.validate(wdoc(day, [{ exceeded: true }]), day), null);
    assert.ok(k.validate({ ...wdoc(day, []), dayKey: 'x' }, day)); assert.ok(k.validate({ dayKey: day, activeMs: 1, limits: 'x', schedules: [], breaks: {} }, day)); assert.ok(k.validate(null, day));
    assert.equal(k.scope, 'device'); assert.equal(k.allowDelete, false);
  });
  it('migration 0006 is additive: schema version 6 and the earlier tables are intact', async () => {
    assert.equal((await env.pool.query('SELECT max(version)::int v FROM schema_migrations')).rows[0].v, 6);
    for (const t of ['families', 'family_members', 'sync_documents', 'devices']) assert.equal((await env.pool.query('SELECT to_regclass($1) r', [t])).rows[0].r, t);
  });
});
