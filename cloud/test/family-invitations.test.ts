import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { sha256Hex } from '../src/lib/crypto';
import { createTestEnv, type TestEnv } from './helpers';
import { call, codeFrom, createFamily, errCode, fakeMailer, user, type FakeMailer } from './family-helpers';

describe('family invitations', () => {
  let env: TestEnv; let mail: FakeMailer;
  before(async () => { mail = fakeMailer(); env = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000' }, { mailer: mail }); });
  after(async () => { await env.close(); });
  const DAY = 86_400_000;

  it('invites by Petali ID, lists it as pending for the family and as received for the invitee; the account answers in the app', async () => {
    const owner = await user(env); await createFamily(env, owner, 'Fam'); const kid = await user(env);
    const r = await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId, role: 'child' });
    assert.equal(r.status, 201, r.text); assert.equal(r.json.invitation.status, 'pending'); assert.equal(r.json.invitation.via, 'petaliId');
    assert.equal(r.json.invitation.invitee.petaliId, kid.petaliId);
    assert.equal(r.json.code, undefined, 'no code is handed out for an in-app invitation');
    const list = (await call(env, owner, 'GET', '/invitations')).json.invitations; assert.equal(list.length, 1);
    const rec = (await call(env, kid, 'GET', '/invitations/received')).json.invitations;
    assert.equal(rec.length, 1); assert.equal(rec[0].familyName, 'Fam'); assert.equal(rec[0].invitedBy.petaliId, owner.petaliId);
    assert.ok(!JSON.stringify(rec).includes(owner.email), 'no email of the inviter');
    const acc = await call(env, kid, 'POST', `/invitations/${rec[0].id}/accept`);
    assert.equal(acc.status, 200, acc.text); assert.equal(acc.json.status, 'accepted'); assert.equal(acc.json.me.role, 'child'); assert.equal(acc.json.family.memberCount, 2);
    assert.equal((await call(env, owner, 'GET', '/invitations?status=pending')).json.invitations.length, 0);
    assert.equal((await call(env, owner, 'GET', '/invitations?status=all')).json.invitations[0].status, 'accepted', 'history keeps it');
  });

  it('validates who can be invited', async () => {
    const owner = await user(env); await createFamily(env, owner); const other = await user(env);
    assert.equal(errCode(await call(env, owner, 'POST', '/invitations', { petaliId: owner.petaliId })), 'cannot_invite_self');
    assert.equal(errCode(await call(env, owner, 'POST', '/invitations', { email: owner.email.toUpperCase() })), 'cannot_invite_self');
    assert.equal((await call(env, owner, 'POST', '/invitations', { petaliId: 'PTL-AAAA-BBBB-CCCC' })).status, 400, 'bad check symbol');
    assert.equal(errCode(await call(env, owner, 'POST', '/invitations', { petaliId: 'PTL-0000-0000-0000' })) === undefined, false);
    assert.equal((await call(env, owner, 'POST', '/invitations', {})).status, 400);
    assert.equal((await call(env, owner, 'POST', '/invitations', { petaliId: other.petaliId, email: 'a@b.cz' })).status, 400, 'exactly one of the two');
    assert.equal(errCode(await call(env, owner, 'POST', '/invitations', { petaliId: other.petaliId, role: 'grandparent' })), 'unknown_role');
    assert.equal((await call(env, owner, 'POST', '/invitations', { petaliId: other.petaliId, role: 'child', admin: true })).status, 400);
  });

  it('duplicate invitations are refused; after revoking, a new one can be sent', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env);
    const a = await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId });
    const dup = await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId });
    assert.equal(dup.status, 409); assert.equal(errCode(dup), 'invitation_exists');
    const rs = await Promise.all([1, 2, 3].map(() => call(env, owner, 'POST', '/invitations', { email: 'race@example.org' })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, 'parallel duplicates: one wins');
    assert.equal((await call(env, owner, 'POST', `/invitations/${a.json.invitation.id}/revoke`)).json.status, 'revoked');
    assert.equal((await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId })).status, 201);
  });

  it('revoked invitations cannot be accepted; the invited account is told why', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env);
    const inv = (await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId })).json.invitation;
    const rv = await call(env, owner, 'POST', `/invitations/${inv.id}/revoke`); assert.equal(rv.json.changed, true);
    assert.equal((await call(env, owner, 'POST', `/invitations/${inv.id}/revoke`)).json.changed, false, 'revoking twice is harmless');
    const acc = await call(env, kid, 'POST', `/invitations/${inv.id}/accept`);
    assert.equal(acc.status, 410); assert.equal(errCode(acc), 'invitation_revoked');
    assert.equal((await call(env, kid, 'GET', '/invitations/received')).json.invitations.length, 0);
    assert.equal((await call(env, kid, 'GET', '')).json.family, null);
  });

  it('declined invitations cannot be accepted later; declining twice is harmless', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env);
    const inv = (await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId })).json.invitation;
    assert.equal((await call(env, kid, 'POST', `/invitations/${inv.id}/decline`)).json.status, 'declined');
    assert.equal((await call(env, kid, 'POST', `/invitations/${inv.id}/decline`)).json.status, 'declined');
    const acc = await call(env, kid, 'POST', `/invitations/${inv.id}/accept`);
    assert.equal(acc.status, 410); assert.equal(errCode(acc), 'invitation_declined');
    assert.equal((await call(env, owner, 'GET', '/invitations?status=all')).json.invitations[0].status, 'declined');
  });

  it('expired invitations cannot be accepted, are shown as expired, and free the slot for a new invitation', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env);
    const inv = (await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId })).json.invitation;
    await env.pool.query(`UPDATE family_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.id]);   // the clock cannot move a week without expiring every access token
    assert.equal((await call(env, owner, 'GET', '/invitations?status=all')).json.invitations[0].status, 'expired');
    assert.equal((await call(env, kid, 'GET', '/invitations/received')).json.invitations.length, 0);
    const acc = await call(env, kid, 'POST', `/invitations/${inv.id}/accept`);
    assert.equal(acc.status, 410); assert.equal(errCode(acc), 'invitation_expired');
    assert.equal((await call(env, kid, 'GET', '')).json.family, null);
    assert.equal((await call(env, owner, 'POST', '/invitations/' + inv.id + '/revoke')).status, 409, 'an expired invitation is not pending any more');
    assert.equal((await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId })).status, 201);
  });

  it('only the invited account can answer; everybody else gets the same "not found"', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env); const stranger = await user(env);
    const inv = (await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId })).json.invitation;
    const ghost = '123e4567-e89b-42d3-a456-426614174000';
    const a = await call(env, stranger, 'POST', `/invitations/${inv.id}/accept`); const b = await call(env, stranger, 'POST', `/invitations/${ghost}/accept`);
    assert.equal(a.status, 404); assert.equal(errCode(a), 'invitation_not_found'); assert.deepEqual(a.json.error.message, b.json.error.message, 'existing and unknown ids look alike');
    assert.equal((await call(env, stranger, 'POST', `/invitations/${inv.id}/decline`)).status, 404);
    assert.equal((await call(env, stranger, 'GET', '')).json.family, null);
    assert.equal((await call(env, stranger, 'POST', `/invitations/${inv.id}/revoke`)).status, 404, 'a non-member cannot revoke');
    assert.equal((await call(env, kid, 'POST', `/invitations/${inv.id}/revoke`)).status, 404, 'neither can the invitee (no family)');
    assert.equal((await call(env, owner, 'GET', '/invitations')).json.invitations[0].status, 'pending', 'still open for the real invitee');
  });

  it('email invitation: the code is mailed, stored only as a hash, works once, only for a verified matching address', async () => {
    const owner = await user(env); await createFamily(env, owner, 'Mail fam');
    mail.sent.length = 0;
    const r = await call(env, owner, 'POST', '/invitations', { email: ' New.Person@Example.com ', role: 'child' });
    assert.equal(r.status, 201); assert.equal(r.json.delivery, 'sent'); assert.equal(r.json.code, undefined);
    assert.equal(mail.sent.length, 1); assert.equal(mail.sent[0]?.to, 'new.person@example.com');
    const code = codeFrom(mail.sent[0] as any);
    const row = (await env.pool.query('SELECT token_hash FROM family_invitations WHERE id = $1', [r.json.invitation.id])).rows[0];
    assert.equal(row.token_hash, sha256Hex(code)); assert.ok(!JSON.stringify(row).includes(code));
    assert.ok(!mail.sent[0]?.html.includes(owner.email), 'the inviter email is not leaked');
    // someone with another email cannot use the code
    const other = await user(env);
    const bad = await call(env, other, 'POST', '/invitations/accept-code', { code });
    assert.equal(bad.status, 404); assert.equal(errCode(bad), 'invitation_not_found');
    // a person who registers with that address but has not verified it cannot use it either
    const invitee = await user(env); await env.pool.query('UPDATE users SET email = $2, email_normalized = $2 WHERE id = $1', [invitee.id, 'new.person@example.com']);
    const unverified = await call(env, invitee, 'POST', '/invitations/accept-code', { code });
    assert.equal(unverified.status, 403); assert.equal(errCode(unverified), 'email_not_verified');
    assert.equal((await call(env, invitee, 'GET', '/invitations/received')).json.invitations.length, 0, 'unverified addresses do not even see it');
    await env.pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [invitee.id]);
    assert.equal((await call(env, invitee, 'GET', '/invitations/received')).json.invitations.length, 1);
    const ok = await call(env, invitee, 'POST', '/invitations/accept-code', { code });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.family.name, 'Mail fam');
    // replay: the same code again
    const replay = await call(env, invitee, 'POST', '/invitations/accept-code', { code });
    assert.equal(replay.status, 409); assert.equal(errCode(replay), 'invitation_already_used');
    assert.equal(errCode(await call(env, other, 'POST', '/invitations/accept-code', { code })), 'invitation_not_found', 'a used code tells strangers nothing');
  });

  it('invalid, malformed and guessed codes are all the same 404', async () => {
    const u = await user(env);
    for (const code of ['pfi_' + 'A'.repeat(43), 'pfi_shorter!', 'x'.repeat(50), "pfi_'; DROP TABLE--", 'pfi_' + 'a'.repeat(44)]) {
      const r = await call(env, u, 'POST', '/invitations/accept-code', { code }); assert.equal(r.status, 404, code); assert.equal(errCode(r), 'invitation_not_found');
    }
    assert.equal((await call(env, u, 'POST', '/invitations/accept-code', { code: 'a' })).status, 400, 'absurdly short is a validation error');
    assert.equal((await call(env, u, 'POST', '/invitations/accept-code', {})).status, 400);
  });

  it('email delivery is reported honestly: not configured or failed means the inviter gets the code to pass on, bound to the address', async () => {
    const owner = await user(env); await createFamily(env, owner);
    mail.failNext = true;
    const r = await call(env, owner, 'POST', '/invitations', { email: 'fail@example.com' });
    assert.equal(r.status, 201); assert.equal(r.json.delivery, 'delivery_failed'); assert.match(r.json.code, /^pfi_/);
    const byId = await user(env);
    const r2 = await call(env, owner, 'POST', '/invitations', { petaliId: byId.petaliId });
    assert.equal(r2.json.delivery, 'not_applicable', 'unverified account email: no notice is mailed'); assert.equal(r2.json.code, undefined);
    const env2 = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000' }, { mailer: fakeMailer(false) });
    try {
      const o = await user(env2); await createFamily(env2, o);
      const x = await call(env2, o, 'POST', '/invitations', { email: 'a@example.com' });
      assert.equal(x.status, 201); assert.equal(x.json.delivery, 'not_configured'); assert.match(x.json.code, /^pfi_/);
    } finally { await env2.close(); }
  });

  it('a notice for an invitation by Petali ID goes only to a verified address', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env);
    await env.pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [kid.id]); mail.sent.length = 0;
    const r = await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId });
    assert.equal(r.json.delivery, 'sent'); assert.equal(mail.sent[0]?.to, kid.email);
    const code = codeFrom(mail.sent[0] as any);
    assert.equal(errCode(await call(env, owner, 'POST', '/invitations/accept-code', { code })), 'invitation_not_found', 'even the inviter cannot use the code');
    assert.equal((await call(env, kid, 'POST', '/invitations/accept-code', { code })).status, 200);
  });

  it('resend replaces the code (the old one stops working), restarts the expiry and is rate limited', async () => {
    const owner = await user(env); await createFamily(env, owner); mail.sent.length = 0;
    const r = await call(env, owner, 'POST', '/invitations', { email: 'again@example.com' });
    const first = codeFrom(mail.sent[0] as any);
    assert.equal(errCode(await call(env, owner, 'POST', `/invitations/${r.json.invitation.id}/resend`)), 'resend_too_soon');
    env.clock.advance(61_000);
    const re = await call(env, owner, 'POST', `/invitations/${r.json.invitation.id}/resend`);
    assert.equal(re.status, 200, re.text); const second = codeFrom(mail.sent[1] as any); assert.notEqual(first, second);
    const v = await user(env); await env.pool.query('UPDATE users SET email = $2, email_normalized = $2, email_verified_at = now() WHERE id = $1', [v.id, 'again@example.com']);
    assert.equal(errCode(await call(env, v, 'POST', '/invitations/accept-code', { code: first })), 'invitation_not_found', 'the replaced code is dead');
    assert.equal((await call(env, v, 'POST', '/invitations/accept-code', { code: second })).status, 200);
  });

  it('decline by code works for the invited identity only', async () => {
    const owner = await user(env); await createFamily(env, owner);
    const kid = await user(env); await env.pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [kid.id]); mail.sent.length = 0;
    await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId }); const code = codeFrom(mail.sent[0] as any);
    assert.equal((await call(env, await user(env), 'POST', '/invitations/decline-code', { code })).status, 404);
    assert.equal((await call(env, kid, 'POST', '/invitations/decline-code', { code })).json.status, 'declined');
  });

  it('an account that is already in a family cannot accept another invitation; one invitation cannot be accepted twice in parallel', async () => {
    const o1 = await user(env); await createFamily(env, o1, 'One'); const o2 = await user(env); await createFamily(env, o2, 'Two');
    const kid = await user(env);
    const i1 = (await call(env, o1, 'POST', '/invitations', { petaliId: kid.petaliId })).json.invitation;
    const i2 = (await call(env, o2, 'POST', '/invitations', { petaliId: kid.petaliId })).json.invitation;
    const rs = await Promise.all([call(env, kid, 'POST', `/invitations/${i1.id}/accept`), call(env, kid, 'POST', `/invitations/${i2.id}/accept`), call(env, kid, 'POST', `/invitations/${i1.id}/accept`)]);
    assert.equal(rs.filter((r) => r.status === 200).length, 1, 'exactly one acceptance wins');
    assert.ok(rs.every((r) => [200, 409].includes(r.status)), JSON.stringify(rs.map((r) => r.status)));
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM family_members WHERE user_id = $1', [kid.id])).rows[0].n, 1);
    const lost = rs.find((r) => r.status === 409); assert.ok(['already_in_family', 'invitation_already_used'].includes(errCode(lost as any)));
  });

  it('only a Parent with the permission can invite; only the owner can invite a Parent; limits are enforced', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env); const kidMember = await (async () => { const i = await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId }); return (await call(env, kid, 'POST', `/invitations/${i.json.invitation.id}/accept`)).json.me.memberId; })();
    const x = await user(env);
    assert.equal(errCode(await call(env, kid, 'POST', '/invitations', { petaliId: x.petaliId })), 'permission_denied');
    assert.equal((await call(env, kid, 'GET', '/invitations')).status, 403, 'a child cannot read the invitation list');
    const co = await user(env); const ci = await call(env, owner, 'POST', '/invitations', { petaliId: co.petaliId, role: 'parent' });
    await call(env, co, 'POST', `/invitations/${ci.json.invitation.id}/accept`);
    assert.equal(errCode(await call(env, co, 'POST', '/invitations', { petaliId: x.petaliId, role: 'parent' })), 'owner_required', 'a co-parent cannot appoint another parent');
    assert.equal((await call(env, co, 'POST', '/invitations', { petaliId: x.petaliId, role: 'child' })).status, 201);
    const env3 = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000', FAMILY_MAX_MEMBERS: '2', FAMILY_MAX_PENDING_INVITATIONS: '1' });
    try {
      const o = await user(env3); await createFamily(env3, o);
      assert.equal((await call(env3, o, 'POST', '/invitations', { email: 'a1@example.com' })).status, 201);
      assert.equal(errCode(await call(env3, o, 'POST', '/invitations', { email: 'a2@example.com' })), 'too_many_invitations');
      const k = await user(env3); const i = (await call(env3, o, 'POST', '/invitations', { petaliId: k.petaliId }).then(async (r) => { if (r.status === 201) return r; const list = (await call(env3, o, 'GET', '/invitations')).json.invitations; await call(env3, o, 'POST', `/invitations/${list[0].id}/revoke`); return call(env3, o, 'POST', '/invitations', { petaliId: k.petaliId }); })).json;
      await call(env3, k, 'POST', `/invitations/${i.invitation.id}/accept`);
      const k2 = await user(env3);
      assert.equal(errCode(await call(env3, o, 'POST', '/invitations', { petaliId: k2.petaliId })), 'family_full');
    } finally { await env3.close(); }
    assert.ok(kidMember);
  });

  it('a person who is already a member cannot be invited again', async () => {
    const owner = await user(env); await createFamily(env, owner); const kid = await user(env);
    const i = await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId }); await call(env, kid, 'POST', `/invitations/${i.json.invitation.id}/accept`);
    assert.equal(errCode(await call(env, owner, 'POST', '/invitations', { petaliId: kid.petaliId })), 'already_member');
    assert.equal(errCode(await call(env, owner, 'POST', '/invitations', { email: kid.email })), 'already_member');
  });

  it('invitations of one family are invisible to and unmanageable by another family', async () => {
    const o1 = await user(env); await createFamily(env, o1); const o2 = await user(env); await createFamily(env, o2); const k = await user(env);
    const inv = (await call(env, o1, 'POST', '/invitations', { petaliId: k.petaliId })).json.invitation;
    assert.equal((await call(env, o2, 'GET', '/invitations?status=all')).json.invitations.length, 0);
    assert.equal((await call(env, o2, 'POST', `/invitations/${inv.id}/revoke`)).status, 404);
    assert.equal((await call(env, o2, 'POST', `/invitations/${inv.id}/resend`)).status, 404);
    assert.equal((await call(env, o1, 'GET', '/invitations')).json.invitations[0].status, 'pending');
  });
});
