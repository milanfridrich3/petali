import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';
import { call, createFamily, device, errCode, join, setup, user } from './family-helpers';

describe('family membership', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000' }); });
  after(async () => { await env.close(); });
  const members = async (u: any) => (await call(env, u, 'GET', '/members')).json.members as any[];

  it('lists members with roles; a child sees names and roles but no permissions of others', async () => {
    const s = await setup(env, 1, 1);
    const asParent = await members(s.owner); assert.equal(asParent.length, 3);
    assert.deepEqual(asParent.map((m) => m.role), ['parent', 'parent', 'child']); assert.equal(asParent[0].isOwner, true); assert.equal(asParent[0].isMe, true);
    assert.ok(asParent.every((m) => m.permissions), 'a parent with members.permissions.manage sees the permissions');
    const asKid = await members(s.kids[0]!.u);
    assert.equal(asKid.length, 3); assert.ok(asKid.filter((m) => !m.isMe).every((m) => m.permissions === undefined), 'children do not see permission sets of others');
    assert.ok(asKid.every((m) => m.deviceCount === null || m.isMe));
  });

  it('a Parent removes a Child: access is revoked immediately, the account, devices and personal data stay', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!;
    const d = await device(env, kid.u, 'Kid PC');
    assert.equal((await call(env, kid.u, 'PUT', `/devices/${d.id}/link`)).status, 200);
    await env.call('POST', '/v1/sync/push', { token: kid.u.token, body: { deviceId: d.id, epoch: d.epoch, ops: [{ kind: 'day', key: '2026-01-01', scope: 'device', clientUpdatedAt: new Date().toISOString(), data: { version: 1, dayKey: '2026-01-01', activeMs: 5000, sessions: [{ start: 1, end: 2, activeMs: 5000 }] } }] } });
    const docs = async () => (await env.pool.query('SELECT count(*)::int AS n FROM sync_documents WHERE user_id = $1', [kid.u.id])).rows[0].n;
    const before = await docs(); assert.ok(before > 0);
    const r = await call(env, s.owner, 'DELETE', `/members/${kid.memberId}`);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.removed, true);
    // the very next request of the removed account has no family any more
    assert.equal((await call(env, kid.u, 'GET', '')).json.family, null);
    for (const [m, p] of [['GET', '/members'], ['GET', '/devices'], ['GET', '/invitations'], ['GET', '/audit']] as const) assert.equal((await call(env, kid.u, m, p)).status, 404, `${m} ${p}`);
    assert.equal((await call(env, kid.u, 'POST', '/leave', { confirm: true })).status, 404);
    // ... and the family no longer shows the member or the device
    assert.equal((await members(s.owner)).length, 1); assert.equal((await call(env, s.owner, 'GET', '/devices')).json.devices.length, 0);
    // nothing personal was deleted
    assert.equal((await env.call('GET', '/v1/account', { token: kid.u.token })).status, 200, 'the Petali ID still works');
    assert.equal((await env.call('GET', '/v1/devices', { token: kid.u.token })).json.devices.length, 1, 'the device is still registered');
    assert.equal((await env.call('GET', '/v1/devices', { token: kid.u.token })).json.devices[0].status, 'active');
    assert.equal(await docs(), before, 'cloud sync data is intact');
    assert.equal((await env.call('POST', '/v1/sync/push', { token: kid.u.token, body: { deviceId: d.id, epoch: d.epoch, ops: [] } })).status, 200, 'the device keeps syncing');
    // the removed account can create or join again
    assert.equal((await call(env, kid.u, 'POST', '', { name: 'Own family' })).status, 201);
  });

  it('removal rules: a Child cannot remove anyone, a co-parent cannot remove the owner or another parent, nobody removes themselves that way', async () => {
    const s = await setup(env, 1, 2); const [p1, p2] = s.pars as [any, any]; const kid = s.kids[0]!;
    assert.equal(errCode(await call(env, kid.u, 'DELETE', `/members/${p1.memberId}`)), 'permission_denied');
    assert.equal(errCode(await call(env, p1.u, 'DELETE', `/members/${s.ownerMemberId}`)), 'owner_protected');
    assert.equal(errCode(await call(env, p1.u, 'DELETE', `/members/${p2.memberId}`)), 'owner_required');
    assert.equal(errCode(await call(env, s.owner, 'DELETE', `/members/${s.ownerMemberId}`)), 'cannot_manage_self');
    assert.equal((await call(env, p1.u, 'DELETE', `/members/${kid.memberId}`)).status, 200, 'a parent may remove a child');
    assert.equal((await call(env, s.owner, 'DELETE', `/members/${p2.memberId}`)).status, 200, 'the owner may remove a parent');
    assert.equal((await members(s.owner)).length, 2);
    assert.equal(errCode(await call(env, s.owner, 'DELETE', `/members/${kid.memberId}`)), 'member_not_found', 'already gone');
  });

  it('leaving: a Child leaves (if the family allows it), a co-parent leaves, the owner must transfer first, the last member dissolves the family', async () => {
    const s = await setup(env, 2, 1); const [k1, k2] = s.kids as [any, any]; const co = s.pars[0]!;
    assert.equal((await call(env, k1.u, 'POST', '/leave', {})).status, 400, 'explicit confirmation');
    assert.equal((await call(env, k1.u, 'POST', '/leave', { confirm: true })).json.left, true);
    assert.equal((await call(env, k1.u, 'GET', '')).json.family, null);
    await call(env, s.owner, 'PATCH', '', { settings: { childrenCanLeave: false } });
    assert.equal(errCode(await call(env, k2.u, 'POST', '/leave', { confirm: true })), 'leave_not_permitted');
    assert.equal((await call(env, co.u, 'POST', '/leave', { confirm: true })).status, 200, 'parents can always leave while the owner remains');
    const own = await call(env, s.owner, 'POST', '/leave', { confirm: true });
    assert.equal(own.status, 409); assert.equal(errCode(own), 'owner_must_transfer');
    assert.equal((await call(env, k2.u, 'GET', '')).json.family.memberCount, 2);
    await call(env, s.owner, 'DELETE', `/members/${k2.memberId}`);
    const last = await call(env, s.owner, 'POST', '/leave', { confirm: true });
    assert.equal(last.status, 200); assert.equal(last.json.familyDissolved, true);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM families WHERE id = $1', [s.familyId])).rows[0].n, 0);
  });

  it('the last Parent cannot leave or be removed or demoted without a valid ownership transfer', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!;
    assert.equal(errCode(await call(env, s.owner, 'POST', '/leave', { confirm: true })), 'owner_must_transfer');
    assert.equal(errCode(await call(env, s.owner, 'PATCH', `/members/${s.ownerMemberId}`, { role: 'child' })), 'cannot_manage_self');
    assert.equal(errCode(await call(env, s.owner, 'POST', '/ownership', { memberId: kid.memberId, confirm: true })), 'target_must_be_parent', 'ownership only goes to a parent');
    assert.equal(errCode(await call(env, s.owner, 'POST', '/ownership', { memberId: s.ownerMemberId, confirm: true })), 'validation_failed');
    const q = await env.pool.query('SELECT count(*)::int AS n FROM family_members WHERE family_id = $1 AND is_owner', [s.familyId]); assert.equal(q.rows[0].n, 1);
    // the proper way: promote, transfer, then leave
    assert.equal((await call(env, s.owner, 'PATCH', `/members/${kid.memberId}`, { role: 'parent' })).json.role, 'parent');
    assert.equal((await call(env, s.owner, 'POST', '/ownership', { memberId: kid.memberId, confirm: true })).status, 200);
    assert.equal((await call(env, s.owner, 'POST', '/leave', { confirm: true })).json.left, true);
    const g = (await call(env, kid.u, 'GET', '')).json; assert.equal(g.me.isOwner, true); assert.equal(g.family.memberCount, 1); assert.equal(g.family.parentCount, 1);
  });

  it('ownership transfer: only the owner, previous owner stays a parent, new owner holds everything, audited', async () => {
    const s = await setup(env, 1, 1); const co = s.pars[0]!;
    assert.equal(errCode(await call(env, co.u, 'POST', '/ownership', { memberId: co.memberId, confirm: true })), 'owner_required');
    assert.equal(errCode(await call(env, s.kids[0]!.u, 'POST', '/ownership', { memberId: co.memberId, confirm: true })), 'owner_required');
    assert.equal((await call(env, s.owner, 'POST', '/ownership', { memberId: co.memberId })).status, 400, 'confirmation required');
    const r = await call(env, s.owner, 'POST', '/ownership', { memberId: co.memberId, confirm: true });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.ownerMemberId, co.memberId);
    const ms = await members(co.u); assert.equal(ms.filter((m) => m.isOwner).length, 1); assert.equal(ms.find((m) => m.isOwner).memberId, co.memberId);
    assert.equal((await call(env, s.owner, 'GET', '')).json.me.role, 'parent');
    assert.equal(errCode(await call(env, s.owner, 'POST', '/dissolve', { confirm: true })), 'owner_required', 'the former owner lost the owner-only powers');
    assert.ok((await call(env, co.u, 'GET', '/audit')).json.events.some((e: any) => e.action === 'ownership_transferred'));
  });

  it('race: owner leaving and ownership transfer at the same time never leave a family without owner', async () => {
    for (let i = 0; i < 3; i += 1) {
      const s = await setup(env, 0, 1); const co = s.pars[0]!;
      const rs = await Promise.all([call(env, s.owner, 'POST', '/leave', { confirm: true }), call(env, s.owner, 'POST', '/ownership', { memberId: co.memberId, confirm: true })]);
      assert.ok(rs.every((r) => r.status < 500), JSON.stringify(rs.map((r) => r.status)));
      const owners = (await env.pool.query('SELECT count(*)::int AS n FROM family_members WHERE family_id = $1 AND is_owner', [s.familyId])).rows[0].n;
      const fam = (await env.pool.query('SELECT count(*)::int AS n FROM families WHERE id = $1', [s.familyId])).rows[0].n;
      assert.ok(fam === 0 || owners === 1, 'either the family is gone or it has exactly one owner');
    }
  });

  it('role changes: only authorized, never on yourself or the owner, new role starts from its defaults, unknown roles refused', async () => {
    const s = await setup(env, 1, 1); const kid = s.kids[0]!; const co = s.pars[0]!;
    assert.equal(errCode(await call(env, kid.u, 'PATCH', `/members/${co.memberId}`, { role: 'child' })), 'permission_denied');
    assert.equal(errCode(await call(env, co.u, 'PATCH', `/members/${kid.memberId}`, { role: 'parent' })), 'owner_required', 'a co-parent cannot appoint parents');
    assert.equal(errCode(await call(env, co.u, 'PATCH', `/members/${s.ownerMemberId}`, { role: 'child' })), 'owner_protected');
    assert.equal(errCode(await call(env, s.owner, 'PATCH', `/members/${kid.memberId}`, { role: 'admin' })), 'unknown_role');
    assert.equal((await call(env, s.owner, 'PATCH', `/members/${kid.memberId}`, { role: 'child' })).json.changed, false, 'same role is a no-op');
    await call(env, s.owner, 'PUT', `/members/${kid.memberId}/permissions`, { grant: ['devices.view'] });
    assert.equal((await call(env, s.owner, 'PATCH', `/members/${kid.memberId}`, { role: 'parent' })).json.changed, true);
    const promoted = (await call(env, kid.u, 'GET', '')).json.me; assert.equal(promoted.role, 'parent'); assert.ok(promoted.permissions.includes('members.invite'));
    assert.equal(errCode(await call(env, co.u, 'PATCH', `/members/${kid.memberId}`, { role: 'child' })), 'owner_required', 'a co-parent cannot demote a parent');
    assert.equal((await call(env, s.owner, 'PATCH', `/members/${kid.memberId}`, { role: 'child' })).status, 200);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM family_member_permissions WHERE member_id = $1', [kid.memberId])).rows[0].n, 0, 'overrides are reset by a role change');
    assert.equal((await call(env, kid.u, 'GET', '/members')).status, 200);
    assert.equal(errCode(await call(env, kid.u, 'DELETE', `/members/${co.memberId}`)), 'permission_denied', 'demoted: powers are gone at once');
  });

  it('cross-family access is impossible: foreign member ids behave like unknown ones', async () => {
    const a = await setup(env, 1); const b = await setup(env, 1);
    const foreign = b.kids[0]!.memberId;
    for (const [m, p, body] of [['DELETE', `/members/${foreign}`], ['PATCH', `/members/${foreign}`, { role: 'parent' }], ['PUT', `/members/${foreign}/permissions`, { grant: ['devices.view'] }], ['GET', `/members/${foreign}/access`], ['GET', `/members/${foreign}/devices`], ['POST', '/ownership', { memberId: foreign, confirm: true }]] as const) {
      const r = await call(env, a.owner, m, p, body); assert.equal(r.status, 404, `${m} ${p}`); assert.equal(errCode(r), 'member_not_found');
    }
    assert.equal((await members(b.owner)).length, 2, 'the other family is untouched');
    assert.equal((await call(env, b.owner, 'GET', '')).json.family.id, b.familyId);
  });

  it('a family cannot exist without an owner even at the database level', async () => {
    const s = await setup(env, 1);
    await assert.rejects(env.pool.query('DELETE FROM family_members WHERE id = $1', [s.ownerMemberId]), /must always have an owner/);
    await assert.rejects(env.pool.query('UPDATE family_members SET is_owner = false WHERE id = $1', [s.ownerMemberId]), /must always have an owner/);
    await assert.rejects(env.pool.query(`UPDATE family_members SET is_owner = true WHERE id = $1`, [s.kids[0]!.memberId]), /family_members_one_owner_key|owner_is_parent/);
    await assert.rejects(env.pool.query('DELETE FROM users WHERE id = $1', [s.owner.id]), /must always have an owner/, 'an owner account cannot vanish silently');
  });

  it('membership is independent of the account: changing email or password, and signing out and in, leaves it as it is', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!;
    assert.equal((await env.call('PUT', '/v1/account/email', { token: kid.u.token, body: { newEmail: `n${Date.now()}@example.org`, currentPassword: kid.u.password } })).status, 200);
    const login = await env.call('POST', '/v1/auth/login', { body: { email: (await env.pool.query('SELECT email FROM users WHERE id = $1', [kid.u.id])).rows[0].email, password: kid.u.password } });
    assert.equal(login.status, 200);
    const g = await call(env, { token: login.json.tokens.accessToken }, 'GET', ''); assert.equal(g.json.me.role, 'child'); assert.equal(g.json.family.id, s.familyId);
  });

  it('the audit trail records sensitive operations for those allowed to read it, and only for them', async () => {
    const s = await setup(env, 1, 1); const kid = s.kids[0]!;
    await call(env, s.owner, 'DELETE', `/members/${kid.memberId}`);
    const ev = (await call(env, s.owner, 'GET', '/audit?limit=100')).json.events as any[];
    const actions = ev.map((e) => e.action);
    for (const a of ['family_created', 'invitation_created', 'member_joined', 'member_removed']) assert.ok(actions.includes(a), a);
    assert.ok(ev.every((e) => !JSON.stringify(e).match(/pfi_|@|token/)), 'no codes or emails in the trail');
    assert.equal((await call(env, s.pars[0]!.u, 'GET', '/audit')).status, 200);
    assert.equal(errCode(await call(env, (await (async () => { const k = await user(env); await join(env, s.owner, k); return k; })()), 'GET', '/audit')), 'permission_denied');
    assert.equal((await call(env, s.owner, 'GET', '/audit?limit=0')).status, 400);
    const page = (await call(env, s.owner, 'GET', '/audit?limit=2')).json; assert.equal(page.events.length, 2); assert.ok(page.nextBefore);
    const next = (await call(env, s.owner, 'GET', `/audit?limit=2&before=${page.nextBefore}`)).json; assert.ok(next.events.every((e: any) => Number(e.id) < Number(page.nextBefore)));
    void createFamily;
  });
});
