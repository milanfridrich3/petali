import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import { hashOf } from '../src/modules/sync/canonical';
import { createTestEnv, type TestEnv } from './helpers';

// Petali 1.5.0 Phase 4 on the backend, against a real PostgreSQL: monotone cloud copies (conflict resolution), repeat-safety,
// the backup manifest, and idempotent token refresh (a lost answer must not end the session).
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const dayKey = (offset = 0) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const monthKey = (offset = 0) => dayKey(offset * 31).slice(0, 7);
const HOUR = 3_600_000;
const S = (id: string, activeMs: number, endReason: string | null = 'lock', startMs = 1_700_000_000_000) => ({ id, startMs, endMs: startMs + activeMs, activeMs, endReason });
const dayDoc = (key: string, sessions: ReturnType<typeof S>[], activeMs?: number) => ({ version: 1, dayKey: key, activeMs: activeMs ?? sessions.reduce((t, s) => t + s.activeMs, 0), sessions });
const appsDoc = (key: string, apps: Record<string, number>, unknownMs = 0) => ({ version: 1, dayKey: key, attributedMs: unknownMs + Object.values(apps).reduce((a, b) => a + b, 0), unknownMs, apps, hourly: [] });
const rollDay = (minutes: number) => ({ hw: { t: 1, n: minutes, minutes }, hourly: [] });

type Acc = Awaited<ReturnType<TestEnv['register']>>;
async function device(env: TestEnv, acc: Acc, name = 'PC', token: string = acc.tokens.accessToken) {
  const clientDeviceId = randomUUID();
  const r = await env.call('POST', '/v1/sync/devices/register', { token, body: { clientDeviceId, name, platform: 'win32', appVersion: '1.5.0' } });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.device.id as string, epoch: r.json.device.epoch as number, clientDeviceId, token: token as string };
}
type Dev = Awaited<ReturnType<typeof device>>;
const dev = (kind: string, key: string, data: unknown, ts = iso()) => ({ kind, key, scope: 'device', clientUpdatedAt: ts, data });
const push = (env: TestEnv, d: Dev, ops: unknown[]) => env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: d.id, epoch: d.epoch, ops } });
// Removing a computer is done from a session that is not bound to it (the registering session is bound to the computer it registered last).
async function otherSession(env: TestEnv, acc: Acc): Promise<string> { const r = await env.call('POST', '/v1/auth/login', { body: { email: acc.email, password: acc.password } }); assert.equal(r.status, 200, r.text); return r.json.tokens.accessToken; }
const stored = async (env: TestEnv, d: Dev, kind: string, key: string) => (await env.pool.query('SELECT data, change_seq FROM sync_documents WHERE device_id = $1 AND kind = $2 AND doc_key = $3', [d.id, kind, key])).rows[0];

describe('phase 4 sync: the cloud copy of a computer only grows', () => {
  let env: TestEnv; let acc: Acc; let d: Dev;
  before(async () => { env = await createTestEnv(); acc = await env.register(); d = await device(env, acc); });
  after(async () => { await env.close(); });

  it('a stale upload of the same session cannot shrink the day, and the computer is told the cloud is ahead', async () => {
    const k = dayKey(1);
    assert.equal((await push(env, d, [dev('day', k, dayDoc(k, [S('a', 3 * HOUR)]))])).json.results[0].outcome, 'applied');
    const seq = (await stored(env, d, 'day', k)).change_seq;
    const r = await push(env, d, [dev('day', k, dayDoc(k, [S('a', HOUR, null)]))]);
    assert.equal(r.json.results[0].outcome, 'unchanged'); assert.equal(r.json.results[0].cloudAhead, true);
    const row = await stored(env, d, 'day', k);
    assert.equal(row.data.activeMs, 3 * HOUR); assert.equal(row.change_seq, seq, 'no new change number: nothing was written');
  });
  it('a fresh computer that replaced another one adds its time to the old day instead of erasing it', async () => {
    const k = dayKey(2);
    await push(env, d, [dev('day', k, dayDoc(k, [S('before-reinstall', 3 * HOUR, 'quit', 1_700_000_000_000)]))]);
    const r = await push(env, d, [dev('day', k, dayDoc(k, [S('after-reinstall', HOUR, null, 1_700_050_000_000)]))]);
    assert.equal(r.json.results[0].outcome, 'applied'); assert.equal(r.json.results[0].cloudAhead, true);
    const row = await stored(env, d, 'day', k);
    assert.equal(row.data.activeMs, 4 * HOUR); assert.deepEqual(row.data.sessions.map((s: any) => s.id).sort(), ['after-reinstall', 'before-reinstall']);
  });
  it('the order of two uploads does not change the result (two computers\' retries arriving in any order)', async () => {
    const k = dayKey(3); const k2 = dayKey(4);
    const x = dayDoc(k, [S('x', HOUR, 'lock', 1_000)]); const y = dayDoc(k, [S('y', 2 * HOUR, 'lock', 9_000_000)]);
    await push(env, d, [dev('day', k, x)]); await push(env, d, [dev('day', k, y)]);
    const x2 = dayDoc(k2, [S('x', HOUR, 'lock', 1_000)]); const y2 = dayDoc(k2, [S('y', 2 * HOUR, 'lock', 9_000_000)]);
    await push(env, d, [dev('day', k2, y2)]); await push(env, d, [dev('day', k2, x2)]);
    const a = (await stored(env, d, 'day', k)).data; const b = (await stored(env, d, 'day', k2)).data;
    assert.equal(a.activeMs, b.activeMs); assert.deepEqual(a.sessions, b.sessions);
  });
  it('repeating an upload any number of times creates no new change and no duplicate session', async () => {
    const k = dayKey(5); const doc = dayDoc(k, [S('r1', HOUR), S('r2', HOUR, 'suspend', 2_000_000_000_000)]);
    await push(env, d, [dev('day', k, doc)]); const seq = (await stored(env, d, 'day', k)).change_seq;
    for (let i = 0; i < 4; i += 1) assert.equal((await push(env, d, [dev('day', k, doc)])).json.results[0].outcome, 'unchanged');
    const row = await stored(env, d, 'day', k);
    assert.equal(row.change_seq, seq); assert.equal(row.data.sessions.length, 2);
    assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM sync_documents WHERE device_id = $1 AND kind = 'day' AND doc_key = $2`, [d.id, k])).rows[0].n, 1);
  });
  it('app usage: larger time per app wins, total stays consistent, a stale upload changes nothing', async () => {
    const k = dayKey(6);
    await push(env, d, [dev('apps', k, appsDoc(k, { 'chrome.exe': 5000, 'code.exe': 1000 }, 200))]);
    const r = await push(env, d, [dev('apps', k, appsDoc(k, { 'chrome.exe': 3000, 'steam.exe': 700 }, 500))]);
    assert.equal(r.json.results[0].outcome, 'applied');
    const m = (await stored(env, d, 'apps', k)).data;
    assert.deepEqual(m.apps, { 'chrome.exe': 5000, 'code.exe': 1000, 'steam.exe': 700 }); assert.equal(m.unknownMs, 500); assert.equal(m.attributedMs, 500 + 6700);
    assert.equal((await push(env, d, [dev('apps', k, appsDoc(k, { 'chrome.exe': 100 }, 0))])).json.results[0].outcome, 'unchanged');
  });
  it('hardware summaries and Device Health events of a month are merged, not replaced', async () => {
    const m = monthKey(1);
    await push(env, d, [dev('rollup', m, { version: 1, month: m, days: { [`${m}-01`]: rollDay(600), [`${m}-02`]: rollDay(100) } })]);
    await push(env, d, [dev('rollup', m, { version: 1, month: m, days: { [`${m}-02`]: rollDay(800), [`${m}-03`]: rollDay(20) } })]);
    const roll = (await stored(env, d, 'rollup', m)).data;
    assert.deepEqual(Object.keys(roll.days), [`${m}-01`, `${m}-02`, `${m}-03`]); assert.equal(roll.days[`${m}-02`].hw.minutes, 800);
    const t = Date.parse(`${m}-05T10:00:00Z`);
    const e1 = { t, k: 'start', id: 'Overheating', sev: 'warning' }; const e2 = { t: t + 60_000, k: 'end', id: 'Overheating' }; const e3 = { t: t - 5000, k: 'start', id: 'HighRam', sev: 'info' };
    await push(env, d, [dev('health', m, { lines: [e1, e2] })]); await push(env, d, [dev('health', m, { lines: [e1, e3] })]);
    assert.deepEqual((await stored(env, d, 'health', m)).data.lines, [e3, e1, e2]);
  });
  it('a merge that would produce an invalid document is refused for that document only', async () => {
    const k = dayKey(7);
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => S(`${p}${i}`, 1, 'lock', 1000 + i));
    await push(env, d, [dev('day', k, dayDoc(k, many('a', 1500)))]);
    const r = await push(env, d, [dev('day', k, dayDoc(k, many('b', 1500))), dev('day', dayKey(8), dayDoc(dayKey(8), [S('ok', HOUR)]))]);
    assert.equal(r.json.results[0].outcome, 'rejected'); assert.match(r.json.results[0].reason, /merged document is not valid/);
    assert.equal(r.json.results[1].outcome, 'applied');
    assert.equal((await stored(env, d, 'day', k)).data.sessions.length, 1500, 'the cloud copy was left as it was');
  });
  it('documents written before Phase 4 (raw rows, any shape) keep working and are merged on the next upload', async () => {
    const k = dayKey(9); const legacy = { version: 1, dayKey: k, activeMs: 7000, sessions: [{ start: 1, end: 2, activeMs: 7000 }] };
    await env.pool.query(`INSERT INTO sync_documents (user_id, device_id, kind, doc_key, data, deleted, data_hash, size_bytes, client_updated_at, written_by_device) VALUES ($1,$2,'day',$3,$4::jsonb,false,$5,100,now(),$2)`, [(await env.pool.query('SELECT user_id FROM devices WHERE id = $1', [d.id])).rows[0].user_id, d.id, k, JSON.stringify(legacy), hashOf(legacy)]);
    const r = await push(env, d, [dev('day', k, dayDoc(k, [S('new', 5000)]))]);
    assert.equal(r.json.results[0].outcome, 'applied');
    const row = await stored(env, d, 'day', k);
    assert.equal(row.data.activeMs, 7000); assert.equal(row.data.sessions.length, 2);
  });
  it('the plant ledger still only grows, and account settings still use last-writer-wins', async () => {
    await push(env, d, [{ kind: 'plant', key: 'ledger', scope: 'device', clientUpdatedAt: iso(), data: { baseMs: 5 * HOUR, days: { [dayKey(1)]: 2 * HOUR } } }]);
    await push(env, d, [{ kind: 'plant', key: 'ledger', scope: 'device', clientUpdatedAt: iso(), data: { baseMs: HOUR, days: { [dayKey(1)]: HOUR, [dayKey(2)]: HOUR } } }]);
    const p = (await stored(env, d, 'plant', 'ledger')).data;
    assert.equal(p.baseMs, 5 * HOUR); assert.equal(p.days[dayKey(1)], 2 * HOUR); assert.equal(p.days[dayKey(2)], HOUR);
    const s = (data: string, ts: number) => ({ kind: 'setting', key: 'ui.lang', scope: 'account', clientUpdatedAt: iso(ts), data });
    await push(env, d, [s('en', Date.now())]);
    assert.equal((await push(env, d, [s('cs', Date.now() - 60_000)])).json.results[0].outcome, 'superseded');
  });
});

describe('phase 4 sync: backup manifest', () => {
  let env: TestEnv; let acc: Acc; let d: Dev;
  before(async () => { env = await createTestEnv(); acc = await env.register(); d = await device(env, acc); });
  after(async () => { await env.close(); });
  const manifest = (dd: Dev, q = '') => env.call('GET', `/v1/sync/manifest?deviceId=${dd.id}&epoch=${dd.epoch}${q}`, { token: dd.token });

  it('lists exactly this computer\'s documents, paginated, with the newest change number', async () => {
    for (let i = 1; i <= 5; i += 1) await push(env, d, [dev('day', dayKey(i), dayDoc(dayKey(i), [S(`s${i}`, HOUR)]))]);
    const other = await device(env, acc, 'Other'); await push(env, other, [dev('day', dayKey(1), dayDoc(dayKey(1), [S('o', HOUR)]))]);
    const p1 = (await manifest(d, '&limit=3')).json; assert.equal(p1.entries.length, 3); assert.equal(p1.hasMore, true);
    const p2 = (await manifest(d, `&limit=3&since=${p1.cursor}`)).json; assert.equal(p2.entries.length, 2); assert.equal(p2.hasMore, false);
    const all = [...p1.entries, ...p2.entries];
    assert.deepEqual(all.map((e: any) => e.key).sort(), [1, 2, 3, 4, 5].map((i) => dayKey(i)).sort());
    assert.ok(all.every((e: any) => e.kind === 'day' && /^[0-9a-f]{64}$/.test(e.hash)));
    assert.ok(p2.highWaterSeq >= p2.cursor);
  });
  it('is scoped to the account and refused for a removed or replaced computer', async () => {
    const intruder = await env.register(); const t = intruder.tokens.accessToken;
    assert.equal((await env.call('GET', `/v1/sync/manifest?deviceId=${d.id}`, { token: t })).status, 404);
    assert.equal((await env.call('GET', `/v1/sync/manifest?deviceId=${d.id}&epoch=${d.epoch + 1}`, { token: d.token })).status, 409);
    assert.equal((await env.call('GET', '/v1/sync/manifest?deviceId=nope', { token: d.token })).status, 400);
    assert.equal((await env.call('GET', `/v1/sync/manifest?deviceId=${d.id}`)).status, 401);
    const victim = await device(env, acc, 'To remove');
    const admin = await otherSession(env, acc);
    const rm = await env.call('POST', `/v1/devices/${victim.id}/remove`, { token: admin, body: { confirm: true } });
    assert.equal(rm.status, 200, rm.text);
    const after = await env.call('GET', `/v1/sync/manifest?deviceId=${victim.id}`, { token: admin });
    assert.equal(after.status, 403); assert.equal(after.json.error.code, 'device_removed');
  });
  it('removed computers cannot push either (device revocation is unchanged)', async () => {
    const v = await device(env, acc, 'Gone', await otherSession(env, acc));
    const admin = await otherSession(env, acc);
    const rm = await env.call('POST', `/v1/devices/${v.id}/remove`, { token: admin, body: { confirm: true } });
    assert.equal(rm.status, 200, rm.text);
    const own = await push(env, v, [dev('day', dayKey(1), dayDoc(dayKey(1), [S('x', HOUR)]))]);
    assert.equal(own.status, 401, 'the session bound to the removed computer ended with it');
    const other = await push(env, { ...v, token: admin }, [dev('day', dayKey(1), dayDoc(dayKey(1), [S('x', HOUR)]))]);
    assert.equal(other.status, 403); assert.equal(other.json.error.code, 'device_removed');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM sync_documents WHERE device_id = $1', [v.id])).rows[0].n, 0, 'nothing was stored');
  });
});

describe('phase 4 auth: a lost refresh answer does not end the session', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });
  const tok = () => `ptr_${randomBytes(32).toString('base64url')}`;
  const refresh = (refreshToken: string, nextRefreshToken?: string) => env.call('POST', '/v1/auth/refresh', { body: { refreshToken, ...(nextRefreshToken ? { nextRefreshToken } : {}) } });
  const me = (access: string) => env.call('GET', '/v1/account', { token: access });

  it('asking again with the same pair returns the same session (no theft alarm), and the session stays alive', async () => {
    const a = await env.register(); const next = tok();
    const first = await refresh(a.tokens.refreshToken, next); assert.equal(first.status, 200); assert.equal(first.json.tokens.refreshToken, next);
    // the answer was lost: the client asks again with exactly the same pair
    const again = await refresh(a.tokens.refreshToken, next);
    assert.equal(again.status, 200, again.text); assert.equal(again.json.tokens.refreshToken, next); assert.equal(again.json.tokens.sessionId, first.json.tokens.sessionId);
    assert.equal(again.json.tokens.refreshTokenExpiresAt, first.json.tokens.refreshTokenExpiresAt);
    assert.equal((await me(again.json.tokens.accessToken)).status, 200);
    const following = await refresh(next, tok()); assert.equal(following.status, 200, 'the client carries on with the proposed token');
    assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM security_events WHERE type = 'refresh_reuse_detected'`)).rows[0].n, 0);
  });
  it('works across any number of repeats and with parallel duplicates', async () => {
    const a = await env.register(); const next = tok();
    const rs = await Promise.all([1, 2, 3, 4].map(() => refresh(a.tokens.refreshToken, next)));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','));
    assert.equal(new Set(rs.map((r) => r.json.tokens.refreshToken)).size, 1);
  });
  it('theft detection is intact: an old token without the matching proposal still ends the session', async () => {
    const a = await env.register(); const next = tok();
    await refresh(a.tokens.refreshToken, next);
    const replay = await refresh(a.tokens.refreshToken);                       // no proof of the proposal
    assert.equal(replay.status, 401); assert.equal(replay.json.error.code, 'refresh_token_reused');
    assert.equal((await refresh(next)).status, 401, 'the whole session is ended');
  });
  it('a different proposal for an old token is also treated as reuse', async () => {
    const a = await env.register(); const next = tok();
    await refresh(a.tokens.refreshToken, next);
    const r = await refresh(a.tokens.refreshToken, tok());
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'refresh_token_reused');
  });
  it('once the client moved on, the older pair is no longer accepted (only the most recent refresh can be repeated), but the live session is unharmed', async () => {
    const a = await env.register(); const n1 = tok(); const n2 = tok();
    await refresh(a.tokens.refreshToken, n1); const second = await refresh(n1, n2);
    const r = await refresh(a.tokens.refreshToken, n1);
    assert.equal(r.status, 401); assert.equal(r.json.error.code, 'invalid_refresh_token');
    assert.equal((await me(second.json.tokens.accessToken)).status, 200);
  });
  it('rejects malformed or colliding proposals, and clients that send none behave exactly as before', async () => {
    const a = await env.register(); const b = await env.register();
    assert.equal((await refresh(a.tokens.refreshToken, 'short')).status, 400);
    assert.equal((await refresh(a.tokens.refreshToken, a.tokens.refreshToken)).status, 400);
    const clash = await refresh(a.tokens.refreshToken, b.tokens.refreshToken); assert.equal(clash.status, 400); assert.equal(clash.json.error.code, 'invalid_next_refresh_token');
    assert.equal((await me(b.tokens.accessToken)).status, 200, 'another account\'s session is untouched');
    const plain = await refresh(a.tokens.refreshToken); assert.equal(plain.status, 200); assert.notEqual(plain.json.tokens.refreshToken, a.tokens.refreshToken);
  });
  it('an expired or revoked session cannot be revived by repeating the refresh', async () => {
    const a = await env.register(); const next = tok();
    await refresh(a.tokens.refreshToken, next);
    await env.call('POST', '/v1/auth/logout', { token: a.tokens.accessToken, body: {} });
    const r = await refresh(a.tokens.refreshToken, next); assert.equal(r.status, 401); assert.equal(r.json.error.code, 'session_revoked');
    const b = await env.register(); const n2 = tok(); await refresh(b.tokens.refreshToken, n2);
    env.clock.advance(400 * 86_400_000);
    const e = await refresh(b.tokens.refreshToken, n2); assert.equal(e.status, 401); assert.equal(e.json.error.code, 'session_expired');
  });
});
