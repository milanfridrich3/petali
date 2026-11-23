import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MailError, type Mailer, type MailMessage } from '../src/lib/mailer';
import type { TestEnv } from './helpers';

export type FakeMailer = Mailer & { sent: MailMessage[]; failNext: boolean };
export function fakeMailer(configured = true): FakeMailer {
  const m: FakeMailer = {
    configured, sent: [], failNext: false,
    async send(msg) { if (!configured) throw new Error('not configured'); if (m.failNext) { m.failNext = false; throw new MailError('provider_rejected', 'rejected', 500); } m.sent.push(msg); },
  };
  return m;
}
export const codeFrom = (msg: MailMessage): string => { const x = /pfi_[A-Za-z0-9_-]{43}/.exec(msg.text); assert.ok(x, 'the email contains an invitation code'); return x[0]; };

export type User = { token: string; petaliId: string; email: string; password: string; id: string };
export async function user(env: TestEnv, extra: Record<string, unknown> = {}): Promise<User> {
  const a = await env.register(undefined, undefined, extra);
  const id = (await env.pool.query('SELECT id FROM users WHERE petali_id = $1', [a.user.petaliId])).rows[0].id as string;
  return { token: a.tokens.accessToken, petaliId: a.user.petaliId, email: a.email, password: a.password, id };
}
export const call = (env: TestEnv, u: { token: string }, method: string, path: string, body?: unknown) => env.call(method, `/v1/family${path}`, { token: u.token, ...(body !== undefined ? { body } : {}) });

export async function createFamily(env: TestEnv, u: User, name = 'The Smiths') {
  const r = await call(env, u, 'POST', '', { name });
  assert.equal(r.status, 201, r.text);
  return r.json as { family: { id: string; name: string }; me: { memberId: string } };
}
// invites by Petali ID and accepts in the app; returns the invitee's member id
export async function join(env: TestEnv, owner: User, who: User, role: 'parent' | 'child' = 'child'): Promise<string> {
  const inv = await call(env, owner, 'POST', '/invitations', { petaliId: who.petaliId, role });
  assert.equal(inv.status, 201, inv.text);
  const acc = await call(env, who, 'POST', `/invitations/${inv.json.invitation.id}/accept`);
  assert.equal(acc.status, 200, acc.text);
  return acc.json.me.memberId as string;
}
export async function setup(env: TestEnv, children = 1, parents = 0) {
  const owner = await user(env); const fam = await createFamily(env, owner);
  const kids: { u: User; memberId: string }[] = []; const pars: { u: User; memberId: string }[] = [];
  for (let i = 0; i < parents; i += 1) { const u = await user(env); pars.push({ u, memberId: await join(env, owner, u, 'parent') }); }
  for (let i = 0; i < children; i += 1) { const u = await user(env); kids.push({ u, memberId: await join(env, owner, u, 'child') }); }
  return { owner, ownerMemberId: fam.me.memberId, familyId: fam.family.id, kids, pars };
}
export async function device(env: TestEnv, u: User, name = 'PC'): Promise<{ id: string; clientDeviceId: string; epoch: number }> {
  const clientDeviceId = randomUUID();
  const r = await env.call('POST', '/v1/sync/devices/register', { token: u.token, body: { clientDeviceId, name, platform: 'win32', appVersion: '1.5.0', hardware: { cpu: 'Test CPU', threads: 8, ramGb: 16 } } });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.device.id, clientDeviceId, epoch: r.json.device.epoch };
}
export const errCode = (r: { json: any }) => r.json?.error?.code as string;
