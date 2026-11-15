import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { generatePetaliId, isValidPetaliId, PETALI_ID_REGEX } from '../src/lib/petali-id';
import { createTestEnv, type TestEnv } from './helpers';

describe('Petali ID generation', () => {
  it('has the PTL-XXXX-XXXX-XXXX shape and a valid check symbol', () => {
    for (let i = 0; i < 500; i += 1) { const id = generatePetaliId(); assert.match(id, PETALI_ID_REGEX); assert.ok(isValidPetaliId(id)); }
  });
  it('never uses easily confused letters (I, L, O, U)', () => {
    for (let i = 0; i < 500; i += 1) assert.ok(!/[ILOU]/.test(generatePetaliId().slice(4)));
  });
  it('is unique across a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i += 1) seen.add(generatePetaliId());
    assert.equal(seen.size, 50_000);
  });
  it('a single wrong character is detected by the check symbol', () => {
    const id = generatePetaliId();
    const chars = id.split('');
    const pos = 5; chars[pos] = chars[pos] === '0' ? '1' : '0';
    assert.ok(!isValidPetaliId(chars.join('')));
    assert.ok(!isValidPetaliId('PTL-0000-0000-000'));
    assert.ok(!isValidPetaliId(42));
  });
});

describe('Petali ID in accounts', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('every account gets its own, unrelated to the email', async () => {
    const a = await env.register('same-prefix@example.com');
    const b = await env.register('same-prefix2@example.com');
    assert.match(a.user.petaliId, PETALI_ID_REGEX);
    assert.notEqual(a.user.petaliId, b.user.petaliId);
    assert.ok(!a.user.petaliId.toLowerCase().includes('same'));
  });
  it('stays the same when the email, password and name change', async () => {
    const a = await env.register();
    const before = a.user.petaliId;
    const t = a.tokens.accessToken;
    await env.call('PATCH', '/v1/account/profile', { token: t, body: { displayName: 'New Name' } });
    const e = await env.call('PUT', '/v1/account/email', { token: t, body: { newEmail: `changed-${Date.now()}@example.com`, currentPassword: a.password } });
    assert.equal(e.status, 200);
    const p = await env.call('PUT', '/v1/account/password', { token: t, body: { currentPassword: a.password, newPassword: 'a brand new passphrase' } });
    assert.equal(p.status, 200);
    const me = await env.call('GET', '/v1/account', { token: t });
    assert.equal(me.json.user.petaliId, before);
  });
  it('cannot be changed at the database level either', async () => {
    const a = await env.register();
    await assert.rejects(env.pool.query('UPDATE users SET petali_id = $1 WHERE petali_id = $2', ['PTL-0000-0000-0000', a.user.petaliId]), /permanent/);
    await assert.rejects(env.pool.query(`UPDATE users SET petali_id = 'bad' WHERE petali_id = $1`, [a.user.petaliId]));
  });
  it('a duplicate Petali ID is rejected by the unique index', async () => {
    const a = await env.register();
    await assert.rejects(env.pool.query(
      `INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ($1, 'x@example.com', 'x@example.com', 'h')`, [a.user.petaliId]), /users_petali_id_key/);
  });
});

describe('Petali ID collision handling', () => {
  let env: TestEnv; let calls = 0; let first = '';
  before(async () => {
    env = await createTestEnv({}, { generateId: () => { calls += 1; return calls <= 2 ? first : generatePetaliId(); } });
  });
  after(async () => { await env.close(); });
  it('generates another ID when the first one is already taken', async () => {
    first = generatePetaliId();
    calls = 100;
    await env.pool.query(`INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ($1, 'seed@example.com', 'seed@example.com', 'h')`, [first]);
    calls = 0;                                      // the next two attempts return the taken ID, the third a fresh one
    const r = await env.register('collide@example.com');
    assert.notEqual(r.user.petaliId, first);
    assert.ok(calls >= 3);
  });
});
