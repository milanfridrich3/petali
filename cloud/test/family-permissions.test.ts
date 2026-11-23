import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { ALWAYS_GRANTED, NON_DELEGABLE, PERMISSIONS, PRIVACY_CATEGORIES, PRIVATE_BY_DEFAULT, ROLES, canManageMember, canViewMemberData, effectivePermissions, normalizeSharing, normalizeSettings } from '../src/modules/family/permissions';
import { createTestEnv, type TestEnv } from './helpers';
import { call, errCode, setup, user, join } from './family-helpers';

describe('permission model (pure)', () => {
  it('roles: parent holds everything, child only sees the family and the member list', () => {
    assert.deepEqual([...effectivePermissions({ role: 'parent', isOwner: false })].sort(), [...PERMISSIONS].sort());
    assert.deepEqual([...effectivePermissions({ role: 'child', isOwner: false })].sort(), ['family.view', 'members.view']);
  });
  it('permissions are independently configurable: grants and denials on top of the role; non-delegable ones cannot reach a child; family.view cannot be removed', () => {
    const c = effectivePermissions({ role: 'child', isOwner: false, overrides: { grant: ['devices.view', 'members.remove'], deny: ['family.view', 'members.view'] } });
    assert.ok(c.has('devices.view')); assert.ok(!c.has('members.remove'), 'non-delegable'); assert.ok(c.has('family.view')); assert.ok(!c.has('members.view'));
    const p = effectivePermissions({ role: 'parent', isOwner: false, overrides: { grant: [], deny: ['members.invite', 'memberData.view'] } });
    assert.ok(!p.has('members.invite') && !p.has('memberData.view') && p.has('members.remove'));
    assert.ok(NON_DELEGABLE.every((x) => (PERMISSIONS as readonly string[]).includes(x))); assert.deepEqual([...ALWAYS_GRANTED], ['family.view']);
  });
  it('the owner can never be restricted', () => {
    assert.equal(effectivePermissions({ role: 'parent', isOwner: true, overrides: { grant: [], deny: [...PERMISSIONS] } }).size, PERMISSIONS.length);
  });
  it('the role registry is extensible: a new role needs only an entry, unknown roles have no permissions', () => {
    assert.ok(ROLES['parent']?.administrator && !ROLES['child']?.administrator);
    assert.equal(effectivePermissions({ role: 'nonexistent', isOwner: false }).size, 0);
  });
  it('canManageMember: never yourself, never the owner, other parents only by the owner', () => {
    const owner = { memberId: 'o', role: 'parent', isOwner: true, permissions: new Set(PERMISSIONS) }; const co = { memberId: 'c', role: 'parent', isOwner: false, permissions: new Set(PERMISSIONS) };
    assert.equal(canManageMember(owner, { memberId: 'o', role: 'parent', isOwner: true }).ok, false);
    assert.equal(canManageMember(co, { memberId: 'o', role: 'parent', isOwner: true }).ok, false);
    assert.equal(canManageMember(co, { memberId: 'x', role: 'parent', isOwner: false }).ok, false);
    assert.equal(canManageMember(owner, { memberId: 'x', role: 'parent', isOwner: false }).ok, true);
    assert.equal(canManageMember(co, { memberId: 'k', role: 'child', isOwner: false }).ok, true);
  });
  it('data access needs the same family, the permission AND the member\'s consent; a Parent role alone is not enough', () => {
    const parent = { memberId: 'p', familyId: 'f', permissions: effectivePermissions({ role: 'parent', isOwner: false }) };
    const kidPrivate = { memberId: 'k', familyId: 'f', sharing: normalizeSharing(null) }; const kidShares = { memberId: 'k', familyId: 'f', sharing: normalizeSharing({ screenTime: true }) };
    for (const c of PRIVACY_CATEGORIES) assert.equal(canViewMemberData(parent, kidPrivate, c).reason, 'not_shared');
    assert.equal(canViewMemberData(parent, kidShares, 'screenTime').allowed, true);
    assert.equal(canViewMemberData(parent, kidShares, 'appUsage').allowed, false, 'sharing one category shares only that one');
    assert.equal(canViewMemberData({ ...parent, permissions: effectivePermissions({ role: 'child', isOwner: false }) }, kidShares, 'screenTime').reason, 'no_permission');
    assert.equal(canViewMemberData(parent, { ...kidShares, familyId: 'other' }, 'screenTime').reason, 'other_family');
    assert.equal(canViewMemberData({ ...parent, memberId: 'k' }, kidPrivate, 'appUsage').reason, 'self');
  });
  it('stored sharing and settings are untrusted: only literal true counts, unknown keys vanish, defaults are private', () => {
    assert.deepEqual(normalizeSharing(null), PRIVATE_BY_DEFAULT);
    assert.deepEqual(normalizeSharing({ screenTime: 'true', appUsage: 1, evil: true, deviceInfo: true }), { ...PRIVATE_BY_DEFAULT, deviceInfo: true });
    assert.deepEqual(normalizeSharing([true]), PRIVATE_BY_DEFAULT);
    assert.deepEqual(normalizeSettings({ childrenCanLeave: 'no' }), { childrenCanLeave: true });
    assert.equal(PRIVACY_CATEGORIES.length, 7);
  });
});

describe('family permissions and individual privacy (API)', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000' }); });
  after(async () => { await env.close(); });

  it('Parent permissions work and Child permissions are limited, enforced by the server', async () => {
    const s = await setup(env, 1, 1); const kid = s.kids[0]!;
    const me = (await call(env, kid.u, 'GET', '')).json.me; assert.deepEqual(me.permissions, ['family.view', 'members.view']);
    const checks: [string, string, unknown?][] = [['PATCH', '', { name: 'x' }], ['POST', '/invitations', { email: 'a@b.cz' }], ['GET', '/invitations'], ['GET', '/audit'], ['DELETE', `/members/${s.pars[0]!.memberId}`], ['PUT', `/members/${s.pars[0]!.memberId}/permissions`, { grant: [] }]];
    for (const [m, p, b] of checks) { const r = await call(env, kid.u, m, p, b); assert.ok([403].includes(r.status), `${m} ${p} -> ${r.status}`); }
    assert.equal((await call(env, kid.u, 'GET', '')).status, 200); assert.equal((await call(env, kid.u, 'GET', '/members')).status, 200);
    for (const [m, p, b] of checks.slice(0, 4)) assert.notEqual((await call(env, s.pars[0]!.u, m, p, b)).status, 403, `parent ${m} ${p}`);
  });

  it('the owner grants and denies individual permissions; the effective set is returned and audited', async () => {
    const s = await setup(env, 1, 1); const kid = s.kids[0]!; const co = s.pars[0]!;
    const g = await call(env, s.owner, 'PUT', `/members/${kid.memberId}/permissions`, { grant: ['devices.view', 'invitations.view'] });
    assert.equal(g.status, 200, g.text); assert.deepEqual(g.json.explicitPermissions.grant.sort(), ['devices.view', 'invitations.view']);
    assert.equal((await call(env, kid.u, 'GET', '/invitations')).status, 200);
    const d = await call(env, s.owner, 'PUT', `/members/${co.memberId}/permissions`, { deny: ['members.invite'] });
    assert.equal(d.status, 200); assert.ok(!d.json.permissions.includes('members.invite'));
    assert.equal(errCode(await call(env, co.u, 'POST', '/invitations', { email: 'a@b.cz' })), 'permission_denied');
    await call(env, s.owner, 'PUT', `/members/${kid.memberId}/permissions`, { grant: [], deny: [] });
    assert.equal((await call(env, kid.u, 'GET', '/invitations')).status, 403, 'resetting returns the member to the role defaults');
    const ev = (await call(env, s.owner, 'GET', '/audit?limit=100')).json.events.filter((e: any) => e.action === 'permissions_changed'); assert.equal(ev.length, 3);
  });

  it('invalid permission changes are refused: unknown, contradictory, non-delegable, not revocable, on yourself, on the owner', async () => {
    const s = await setup(env, 1, 1); const kid = s.kids[0]!; const co = s.pars[0]!; const p = (id: string, b: unknown, u = s.owner) => call(env, u, 'PUT', `/members/${id}/permissions`, b);
    assert.equal(errCode(await p(kid.memberId, { grant: ['root.access'] })), 'unknown_permission');
    assert.equal((await p(kid.memberId, { grant: ['devices.view'], deny: ['devices.view'] })).status, 400);
    assert.equal(errCode(await p(kid.memberId, { grant: ['members.remove'] })), 'permission_not_delegable');
    assert.equal(errCode(await p(kid.memberId, { grant: ['audit.view'] })), 'permission_not_delegable');
    assert.equal(errCode(await p(kid.memberId, { deny: ['family.view'] })), 'permission_not_revocable');
    assert.equal(errCode(await p(s.ownerMemberId, { deny: ['members.invite'] })), 'cannot_manage_self');
    assert.equal(errCode(await p(s.ownerMemberId, { deny: ['members.invite'] }, co.u)), 'owner_protected');
    assert.equal(errCode(await p(co.memberId, { deny: ['members.invite'] }, kid.u)), 'permission_denied');
    assert.equal((await p(kid.memberId, { grant: ['devices.view'], extra: 1 })).status, 400);
  });

  it('no privilege escalation: a co-parent cannot grant what it does not hold, nor change another parent, and cannot modify itself', async () => {
    const s = await setup(env, 1, 2); const [co, co2] = s.pars as [any, any]; const kid = s.kids[0]!;
    await call(env, s.owner, 'PUT', `/members/${co.memberId}/permissions`, { deny: ['devices.view'] });
    assert.equal(errCode(await call(env, co.u, 'PUT', `/members/${kid.memberId}/permissions`, { grant: ['devices.view'] })), 'cannot_grant_unheld_permission');
    assert.equal((await call(env, co.u, 'PUT', `/members/${kid.memberId}/permissions`, { grant: ['invitations.view'] })).status, 200, 'it can grant what it holds');
    assert.equal(errCode(await call(env, co.u, 'PUT', `/members/${co2.memberId}/permissions`, { deny: ['members.invite'] })), 'owner_required');
    assert.equal(errCode(await call(env, co.u, 'PUT', `/members/${co.memberId}/permissions`, { grant: ['devices.view'] })), 'cannot_manage_self');
    assert.equal(errCode(await call(env, kid.u, 'PUT', `/members/${kid.memberId}/permissions`, { grant: ['members.remove'] })), 'permission_denied');
  });

  it('sharing is private by default and only the member can change it', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!;
    const g = (await call(env, kid.u, 'GET', '/me/sharing')).json;
    assert.deepEqual(g.categories, [...PRIVACY_CATEGORIES]); for (const c of PRIVACY_CATEGORIES) assert.equal(g.sharing[c], false, c);
    const r = await call(env, kid.u, 'PUT', '/me/sharing', { screenTime: true, appCategories: true });
    assert.equal(r.status, 200); assert.deepEqual(r.json.changed.sort(), ['appCategories', 'screenTime']); assert.equal(r.json.sharing.appUsage, false);
    assert.equal((await call(env, kid.u, 'PUT', '/me/sharing', { screenTime: true })).json.changed.length, 0, 'repeat changes nothing');
    assert.equal((await call(env, kid.u, 'GET', '/me/sharing')).json.sharing.screenTime, true);
    for (const bad of [{}, { screenTime: 'yes' }, { unknown: true }, { screenTime: true, memberId: 'x' }]) assert.equal((await call(env, kid.u, 'PUT', '/me/sharing', bad)).status, 400, JSON.stringify(bad));
    // a parent has no way to change a child's choice: the endpoint only ever addresses the caller
    await call(env, s.owner, 'PUT', '/me/sharing', { deviceInfo: true });
    assert.equal((await call(env, kid.u, 'GET', '/me/sharing')).json.sharing.deviceInfo, false);
    assert.equal((await call(env, s.owner, 'PUT', `/members/${kid.memberId}/sharing`, { appUsage: true })).status, 404);
  });

  it('a Parent sees only what the member shares: access decisions and the member list reflect consent', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!;
    const acc = async () => (await call(env, s.owner, 'GET', `/members/${kid.memberId}/access`)).json;
    let a = await acc(); assert.equal(a.self, false); for (const c of PRIVACY_CATEGORIES) { assert.equal(a.categories[c].allowed, false); assert.equal(a.categories[c].reason, 'not_shared'); }
    assert.deepEqual((await call(env, s.owner, 'GET', '/members')).json.members.find((m: any) => m.memberId === kid.memberId).sharedWithYou, []);
    await call(env, kid.u, 'PUT', '/me/sharing', { usageHistory: true, individualReports: true });
    a = await acc(); assert.equal(a.categories.usageHistory.allowed, true); assert.equal(a.categories.usageHistory.reason, 'shared'); assert.equal(a.categories.screenTime.allowed, false);
    assert.deepEqual((await call(env, s.owner, 'GET', '/members')).json.members.find((m: any) => m.memberId === kid.memberId).sharedWithYou.sort(), ['individualReports', 'usageHistory']);
    await call(env, s.owner, 'PUT', `/members/${s.ownerMemberId}/permissions`, { deny: ['memberData.view'] });   // owner cannot be restricted: still allowed
    assert.equal((await acc()).categories.usageHistory.allowed, true);
    const co = await user(env); const coId = await join(env, s.owner, co, 'parent');
    await call(env, s.owner, 'PUT', `/members/${coId}/permissions`, { deny: ['memberData.view'] });
    const viaCo = (await call(env, co, 'GET', `/members/${kid.memberId}/access`)).json; assert.equal(viaCo.categories.usageHistory.reason, 'no_permission', 'permission and consent are separate layers');
    const own = (await call(env, kid.u, 'GET', `/members/${kid.memberId}/access`)).json; assert.equal(own.self, true); assert.ok(PRIVACY_CATEGORIES.every((c) => own.categories[c].allowed));
    // a child cannot read a sibling's data even if the sibling shares
    const sib = await user(env); const sibId = await join(env, s.owner, sib, 'child'); await call(env, sib, 'PUT', '/me/sharing', { screenTime: true });
    assert.equal((await call(env, kid.u, 'GET', `/members/${sibId}/access`)).json.categories.screenTime.reason, 'no_permission');
  });

  it('privacy settings do not survive leaving: a re-joined member starts private again; changes are visible only to the member in the audit', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!;
    await call(env, kid.u, 'PUT', '/me/sharing', { screenTime: true });
    assert.ok(!(await call(env, s.owner, 'GET', '/audit?limit=100')).json.events.some((e: any) => e.action === 'sharing_updated'), 'the parent does not see that the child changed sharing');
    await call(env, kid.u, 'POST', '/leave', { confirm: true });
    const inv = await call(env, s.owner, 'POST', '/invitations', { petaliId: kid.u.petaliId }); const back = await call(env, kid.u, 'POST', `/invitations/${inv.json.invitation.id}/accept`);
    assert.equal(back.status, 200);
    assert.equal((await call(env, kid.u, 'GET', '/me/sharing')).json.sharing.screenTime, false);
  });
});
