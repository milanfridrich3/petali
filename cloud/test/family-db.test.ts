import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { runMaintenance } from '../src/db/maintenance';
import { loadConfig } from '../src/config/env';
import { createTestEnv, type TestEnv } from './helpers';
import { call, device, setup, user } from './family-helpers';

describe('family database (migration 0005)', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000' }); });
  after(async () => { await env.close(); });

  it('is additive: every table of versions 1-4 still exists and the family tables were created with their keys and indexes', async () => {
    const t = (await env.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [env.schema])).rows.map((r) => r.table_name);
    for (const n of ['users', 'devices', 'sessions', 'sync_documents', 'external_identities', 'families', 'family_members', 'family_member_permissions', 'family_member_privacy', 'family_invitations', 'family_devices', 'family_device_transfers', 'family_audit_log']) assert.ok(t.includes(n), n);
    const idx = (await env.pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [env.schema])).rows.map((r) => r.indexname);
    for (const n of ['family_members_user_key', 'family_members_one_owner_key', 'family_invitations_token_key', 'family_invitations_pending_user_key', 'family_invitations_pending_email_key', 'family_device_transfers_pending_key']) assert.ok(idx.includes(n), n);
  });

  it('database constraints: one family per account, one owner, owner must be a parent, role shape, invitation status and pairing', async () => {
    const s = await setup(env, 1); const other = (await env.pool.query('SELECT id FROM users WHERE id <> $1 LIMIT 1', [s.owner.id])).rows[0].id;
    await assert.rejects(env.pool.query(`INSERT INTO family_members (family_id, user_id, role) VALUES ($1,$2,'child')`, [s.familyId, s.kids[0]!.u.id]), /family_members_user_key/);
    await assert.rejects(env.pool.query(`UPDATE family_members SET role = 'child' WHERE id = $1`, [s.ownerMemberId]), /owner_is_parent/);
    await assert.rejects(env.pool.query(`INSERT INTO family_members (family_id, user_id, role) VALUES ($1,$2,'Bad Role')`, [s.familyId, other]), /role_shape/);
    await assert.rejects(env.pool.query(`INSERT INTO families (name) VALUES ('')`), /families_name_length/);
    await assert.rejects(env.pool.query(`INSERT INTO family_invitations (family_id, role, token_hash, expires_at) VALUES ($1,'child','h', now())`, [s.familyId]), /has_invitee/);
    await assert.rejects(env.pool.query(`INSERT INTO family_invitations (family_id, invitee_user_id, role, token_hash, expires_at, status) VALUES ($1,$2,'child','h2', now(), 'accepted')`, [s.familyId, other]), /responded/);
    await assert.rejects(env.pool.query(`INSERT INTO family_member_permissions (member_id, permission, effect) VALUES ($1,'x.y','maybe')`, [s.ownerMemberId]), /effect/);
  });

  it('a family device must be an active device of the linking member (trigger)', async () => {
    const s = await setup(env, 1); const d = await device(env, s.owner, 'P'); const dk = await device(env, s.kids[0]!.u, 'K');
    await assert.rejects(env.pool.query('INSERT INTO family_devices (device_id, family_id, member_id) VALUES ($1,$2,$3)', [dk.id, s.familyId, s.ownerMemberId]), /active device of the member/);
    await env.pool.query('INSERT INTO family_devices (device_id, family_id, member_id) VALUES ($1,$2,$3)', [d.id, s.familyId, s.ownerMemberId]);
    await assert.rejects(env.pool.query('UPDATE family_devices SET member_id = $2 WHERE device_id = $1', [d.id, s.kids[0]!.memberId]), /active device of the member/);
    await env.pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [dk.id]);
    await assert.rejects(env.pool.query('INSERT INTO family_devices (device_id, family_id, member_id) VALUES ($1,$2,$3)', [dk.id, s.familyId, s.kids[0]!.memberId]), /active device/);
  });

  it('invitation codes are unique and stored as 64-hex hashes', async () => {
    const s = await setup(env, 0); const k = await user(env);
    await call(env, s.owner, 'POST', '/invitations', { petaliId: k.petaliId });
    const rows = (await env.pool.query('SELECT token_hash FROM family_invitations')).rows; assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
    assert.equal(new Set(rows.map((r) => r.token_hash)).size, rows.length);
  });

  it('maintenance closes stale invitations and hand-overs, and drops old finished ones', async () => {
    const s = await setup(env, 0); const k = await user(env);
    const inv = (await call(env, s.owner, 'POST', '/invitations', { petaliId: k.petaliId })).json.invitation;
    await env.pool.query(`UPDATE family_invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [inv.id]);
    const r = await runMaintenance(env.pool); assert.ok(r.family >= 1);
    assert.equal((await env.pool.query('SELECT status FROM family_invitations WHERE id = $1', [inv.id])).rows[0].status, 'expired');
    await env.pool.query(`UPDATE family_invitations SET responded_at = now() - interval '100 days' WHERE id = $1`, [inv.id]);
    await runMaintenance(env.pool); assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM family_invitations WHERE id = $1', [inv.id])).rows[0].n, 0);
    await runMaintenance(env.pool);   // repeating is harmless
  });

  it('configuration: safe defaults and validated limits', () => {
    const good = { DATABASE_URL: 'postgres://u:p@localhost/db', JWT_ACCESS_SECRET: 'k3Jf9sLq0Zx7VbN2mQw8TyUi5OpAsDfGhJk1LzXc' };
    const c = loadConfig(good); assert.deepEqual(c.family, { inviteTtlMs: 7 * 86_400_000, transferTtlMs: 3 * 86_400_000, maxMembers: 12, maxPendingInvitations: 20 });
    assert.throws(() => loadConfig({ ...good, FAMILY_MAX_MEMBERS: '1' }), /FAMILY_MAX_MEMBERS/);
    assert.throws(() => loadConfig({ ...good, FAMILY_INVITE_TTL_DAYS: '0' }), /FAMILY_INVITE_TTL_DAYS/);
  });

  it('the invitation endpoints are rate limited', async () => {
    const e = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '3' });
    try {
      const u = await user(e); let last = 0;
      for (let i = 0; i < 5; i += 1) last = (await call(e, u, 'POST', '/invitations/accept-code', { code: 'pfi_' + 'A'.repeat(43) })).status;
      assert.equal(last, 429);
    } finally { await e.close(); }
  });
});
