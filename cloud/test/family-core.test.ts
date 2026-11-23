import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';
import { call, createFamily, errCode, join, user } from './family-helpers';

describe('family: creation, retrieval and update', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('an account without a family sees "no family"; creating one makes the creator the first Parent and owner', async () => {
    const u = await user(env);
    const none = await call(env, u, 'GET', '');
    assert.equal(none.status, 200); assert.equal(none.json.family, null); assert.equal(none.json.me, null);
    const r = await createFamily(env, u, '  The   Smiths  ');
    assert.equal(r.family.name, 'The Smiths', 'name is trimmed and whitespace collapsed');
    const g = (await call(env, u, 'GET', '')).json;
    assert.equal(g.family.memberCount, 1); assert.equal(g.family.parentCount, 1); assert.match(g.family.id, /^[0-9a-f-]{36}$/);
    assert.equal(g.me.role, 'parent'); assert.equal(g.me.isOwner, true);
    assert.ok(g.family.createdAt && g.family.createdBy.petaliId === u.petaliId);
    assert.ok(g.me.permissions.includes('members.invite') && g.me.permissions.includes('audit.view'));
    assert.deepEqual(g.family.settings, { childrenCanLeave: true });
  });

  it('validates the family name', async () => {
    const u = await user(env);
    for (const name of ['', '   ', 'x'.repeat(61), 'bad\u0000name']) {
      const r = await call(env, u, 'POST', '', { name });
      assert.equal(r.status, 400, JSON.stringify(name)); assert.equal(errCode(r), 'validation_failed');
    }
    assert.equal((await call(env, u, 'POST', '', {})).status, 400);
    assert.equal((await call(env, u, 'POST', '', { name: 'ok', ownerId: 'x' })).status, 400, 'unknown fields are refused');
    assert.equal((await call(env, u, 'GET', '')).json.family, null, 'nothing was created by the failed attempts');
    assert.equal((await call(env, u, 'POST', '', { name: 'x'.repeat(60) })).status, 201, 'exactly 60 characters is fine');
  });

  it('an account can be in only one family (also when two create requests race)', async () => {
    const u = await user(env); await createFamily(env, u);
    const again = await call(env, u, 'POST', '', { name: 'Second' });
    assert.equal(again.status, 409); assert.equal(errCode(again), 'already_in_family');
    const v = await user(env);
    const rs = await Promise.all([1, 2, 3, 4].map((i) => call(env, v, 'POST', '', { name: `Race ${i}` })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, 'exactly one create wins');
    assert.ok(rs.every((r) => r.status === 201 || r.status === 409));
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM family_members WHERE user_id = $1', [v.id])).rows[0].n, 1);
  });

  it('an account with a pending deletion request cannot create a family', async () => {
    const u = await user(env);
    assert.equal((await env.call('POST', '/v1/account/deletion-request', { token: u.token, body: { password: u.password } })).status < 300, true);
    const r = await call(env, u, 'POST', '', { name: 'Nope' });
    assert.equal(r.status, 403); assert.equal(errCode(r), 'account_pending_deletion');
  });

  it('the owner can rename the family and change settings; the change is idempotent and audited once', async () => {
    const u = await user(env); await createFamily(env, u, 'Old');
    const r = await call(env, u, 'PATCH', '', { name: 'New name', settings: { childrenCanLeave: false } });
    assert.equal(r.status, 200); assert.equal(r.json.family.name, 'New name'); assert.equal(r.json.family.settings.childrenCanLeave, false);
    await call(env, u, 'PATCH', '', { name: 'New name' });
    const audit = (await call(env, u, 'GET', '/audit')).json.events.filter((e: any) => e.action === 'family_updated');
    assert.equal(audit.length, 1, 'the repeat changed nothing and recorded nothing');
    assert.deepEqual(audit[0].detail.changed.sort(), ['childrenCanLeave', 'name']);
    assert.equal((await call(env, u, 'PATCH', '', {})).status, 400);
    assert.equal((await call(env, u, 'PATCH', '', { name: '' })).status, 400);
    assert.equal((await call(env, u, 'PATCH', '', { settings: { childrenCanLeave: 'yes' } })).status, 400);
  });

  it('a Child cannot change the family settings, a Parent with the permission can', async () => {
    const owner = await user(env); await createFamily(env, owner);
    const kid = await user(env); await join(env, owner, kid, 'child');
    const co = await user(env); const coId = await join(env, owner, co, 'parent');
    const r = await call(env, kid, 'PATCH', '', { name: 'Hacked' });
    assert.equal(r.status, 403); assert.equal(errCode(r), 'permission_denied');
    assert.equal((await call(env, co, 'PATCH', '', { name: 'By co-parent' })).status, 200, 'multiple Parents can manage the family');
    assert.equal((await call(env, owner, 'GET', '')).json.family.name, 'By co-parent');
    assert.equal((await call(env, owner, 'GET', '')).json.family.parentCount, 2);
    assert.ok(coId);
  });

  it('only the owner can delete the family; deleting removes the family relationship but nothing of the accounts', async () => {
    const owner = await user(env); const fam = await createFamily(env, owner);
    const kid = await user(env); await join(env, owner, kid);
    const co = await user(env); await join(env, owner, co, 'parent');
    assert.equal(errCode(await call(env, co, 'POST', '/dissolve', { confirm: true })), 'owner_required');
    assert.equal((await call(env, owner, 'POST', '/dissolve', {})).status, 400, 'explicit confirmation is required');
    const r = await call(env, owner, 'POST', '/dissolve', { confirm: true });
    assert.equal(r.status, 200); assert.equal(r.json.dissolved, true);
    for (const u of [owner, kid, co]) assert.equal((await call(env, u, 'GET', '')).json.family, null);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])', [[owner.id, kid.id, co.id]])).rows[0].n, 3, 'accounts are untouched');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM family_audit_log WHERE family_id = $1', [fam.family.id])).rows[0].n > 0, true, 'the audit trail outlives the family');
    assert.equal((await call(env, owner, 'POST', '', { name: 'Again' })).status, 201, 'accounts are free to create or join a family again');
  });

  it('every family endpoint needs authentication', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const list: [string, string, unknown?][] = [['GET', ''], ['POST', '', { name: 'x' }], ['PATCH', '', { name: 'x' }], ['POST', '/dissolve', { confirm: true }], ['POST', '/leave', { confirm: true }], ['POST', '/ownership', { memberId: id, confirm: true }],
      ['GET', '/members'], ['PATCH', `/members/${id}`, { role: 'child' }], ['DELETE', `/members/${id}`], ['PUT', `/members/${id}/permissions`, { grant: [] }], ['GET', `/members/${id}/access`], ['GET', `/members/${id}/devices`],
      ['GET', '/me/sharing'], ['PUT', '/me/sharing', { screenTime: true }], ['GET', '/me/devices'], ['GET', '/invitations'], ['POST', '/invitations', { petaliId: 'x' }], ['GET', '/invitations/received'],
      ['POST', '/invitations/accept-code', { code: 'x' }], ['POST', `/invitations/${id}/accept`], ['POST', `/invitations/${id}/revoke`], ['GET', '/devices'], ['PUT', `/devices/${id}/link`], ['DELETE', `/devices/${id}/link`],
      ['POST', `/devices/${id}/transfers`, { toMemberId: id }], ['GET', '/transfers'], ['POST', `/transfers/${id}/accept`], ['GET', '/audit']];
    for (const [m, p, body] of list) { const r = await env.call(m, `/v1/family${p}`, body ? { body } : {}); assert.equal(r.status, 401, `${m} ${p}`); }
    const bad = await env.call('GET', '/v1/family', { token: 'x'.repeat(40) }); assert.equal(bad.status, 401);
  });

  it('path ids are validated, and responses never contain internal user ids, emails or password data', async () => {
    const owner = await user(env); await createFamily(env, owner);
    const kid = await user(env); await join(env, owner, kid);
    assert.equal((await call(env, owner, 'DELETE', '/members/not-a-uuid')).status, 400);
    const text = [(await call(env, owner, 'GET', '')).text, (await call(env, owner, 'GET', '/members')).text, (await call(env, owner, 'GET', '/audit')).text, (await call(env, kid, 'GET', '/members')).text].join('\n');
    assert.ok(!text.includes(owner.id) && !text.includes(kid.id), 'internal user ids stay internal');
    assert.ok(!text.includes(owner.email) && !text.includes(kid.email), 'emails are not exposed to family members');
    assert.ok(!/password|token_hash|hash/i.test(text));
  });
});
