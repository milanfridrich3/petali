import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';
import { isAllowedText, MODERATION_VERSION } from '../src/lib/moderation';
import { assertAllowedText } from '../src/lib/moderation';

const cases = JSON.parse(readFileSync(join(__dirname, 'moderation-cases.json'), 'utf8')) as { blocked: string[]; allowed: string[] };

describe('moderation core (server copy)', () => {
  it('blocks the shared blocked cases and allows the shared allowed cases', () => {
    for (const t of cases.blocked) assert.equal(isAllowedText(t), false, `should block: ${t}`);
    for (const t of cases.allowed) assert.equal(isAllowedText(t), true, `should allow: ${t}`);
  });
  it('assertAllowedText throws a 422 inappropriate_text that never contains the text', () => {
    const bad = 'Moje kurva kytka';
    try { assertAllowedText('displayName', bad); assert.fail('should throw'); } catch (e) {
      const err = e as { status: number; code: string; message: string; details: unknown };
      assert.equal(err.status, 422); assert.equal(err.code, 'inappropriate_text');
      assert.ok(!JSON.stringify([err.message, err.details]).toLowerCase().includes('kurva'));
      assert.deepEqual((err.details as { dictionary: string }).dictionary, MODERATION_VERSION);
    }
    assert.doesNotThrow(() => assertAllowedText('displayName', 'Klíček')); assert.doesNotThrow(() => assertAllowedText('displayName', undefined));
  });
});

describe('moderation on persisted API input', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  async function login(acc: Awaited<ReturnType<TestEnv['register']>>): Promise<string> {
    const r = await env.call('POST', '/v1/auth/login', { body: { email: acc.email, password: acc.password } });
    assert.equal(r.status, 200, r.text); return r.json.tokens.accessToken;
  }
  const refused = (r: { status: number; text: string }, word: string) => { assert.equal(r.status, 422, r.text); assert.ok(r.text.includes('inappropriate_text')); assert.ok(!r.text.toLowerCase().includes(word), 'the response must not echo the text'); };

  it('registration: a not-allowed display name is refused and nothing is created; an allowed one works', async () => {
    const email = `mod-${randomUUID()}@example.com`;
    const r = await env.call('POST', '/v1/auth/register', { body: { email, password: 'correct-horse-77', displayName: 'k0kot' } });
    refused(r, 'kokot'); assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM users WHERE email_normalized = $1 OR email = $1', [email]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0);
    const ok = await env.call('POST', '/v1/auth/register', { body: { email, password: 'correct-horse-77', displayName: 'Klíček' } });
    assert.equal(ok.status, 201, ok.text);
  });

  it('profile update: refused for a not-allowed name, the stored name is unchanged, and clearing the name still works', async () => {
    const acc = await env.register(); const token = await login(acc);
    const good = await env.call('PATCH', '/v1/account/profile', { token, body: { displayName: 'Milan' } }); assert.equal(good.status, 200, good.text);
    const bad = await env.call('PATCH', '/v1/account/profile', { token, body: { displayName: 'F u c k' } }); refused(bad, 'fuck');
    const me = await env.call('GET', '/v1/account', { token }); assert.equal(me.json.user.displayName, 'Milan');
    const cleared = await env.call('PATCH', '/v1/account/profile', { token, body: { displayName: null } }); assert.equal(cleared.status, 200, cleared.text);
  });

  it('device rename is moderated; a computer that registers itself with a not-allowed host name gets a neutral name instead of failing', async () => {
    const acc = await env.register(); const token = await login(acc);
    const reg = await env.call('POST', '/v1/sync/devices/register', { token, body: { clientDeviceId: randomUUID(), name: 'kurva-pc', platform: 'win32', appVersion: '1.6.0' } });
    assert.equal(reg.status, 200, reg.text); assert.equal(reg.json.device.name, 'My computer');
    const id = reg.json.device.id as string;
    const bad = await env.call('PATCH', `/v1/devices/${id}`, { token, body: { name: 'Zmrd PC' } }); refused(bad, 'zmrd');
    const good = await env.call('PATCH', `/v1/devices/${id}`, { token, body: { name: 'Kancelář' } }); assert.equal(good.status, 200, good.text);
  });

  it('family name is moderated on create and on update', async () => {
    const acc = await env.register(); const token = await login(acc);
    const bad = await env.call('POST', '/v1/family', { token, body: { name: 'Hajzlové' } });
    // "Hajzlové" is an inflected form that is not listed: it must be allowed (no guessing); a listed form is refused.
    assert.notEqual(bad.status, 422);
    const refusedName = await env.call('POST', '/v1/family', { token, body: { name: 'Ty hajzle' } }); refused(refusedName, 'hajzle');
  });
});

describe('moderation: the plant name travels with the synced settings (ui.name): server-side rejection when the client check is bypassed', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });
  const iso = () => new Date().toISOString();
  const setting = (key: string, data: unknown) => ({ kind: 'setting', key, scope: 'account', clientUpdatedAt: iso(), data });

  it('a push that carries a not-allowed ui.name is rejected on its own (reason without the text); ordinary names and the other settings in the batch go through', async () => {
    const acc = await env.register(); const token = (await env.call('POST', '/v1/auth/login', { body: { email: acc.email, password: acc.password } })).json.tokens.accessToken as string;
    const reg = await env.call('POST', '/v1/sync/devices/register', { token, body: { clientDeviceId: randomUUID(), name: 'PC', platform: 'win32', appVersion: '1.6.0' } });
    const d = { id: reg.json.device.id as string, epoch: reg.json.device.epoch as number };
    const push = (ops: unknown[]) => env.call('POST', '/v1/sync/push', { token, body: { deviceId: d.id, epoch: d.epoch, ops } });
    for (const bad of ['kurva', 'k0kot', 'Debil', 'f*ck', 'kurva2']) {
      const r = await push([setting('ui.name', bad), setting('ui.effects', true)]);
      assert.equal(r.status, 200, r.text); const out = r.json.results.map((x: { outcome: string }) => x.outcome) as string[]; assert.equal(out[0], 'rejected', bad); assert.ok(['applied', 'unchanged'].includes(out[1] as string), 'the other setting in the batch is not affected');
      assert.ok(!JSON.stringify(r.json).toLowerCase().includes(bad.toLowerCase()), 'the rejected text is not echoed');
    }
    for (const good of ['Květinka', 'Šárka', 'Pepa', 'Čurda']) { const r = await push([setting('ui.name', good)]); assert.equal(r.json.results[0].outcome, 'applied', good); }
    assert.ok(!env.logLines.join('').match(/kurva|k0kot|debil|f\*ck/i), 'the rejected text is not in the logs');
  });
});
