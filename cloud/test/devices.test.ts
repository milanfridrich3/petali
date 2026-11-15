import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const dayKey = (offset = 0) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const monthKey = () => dayKey().slice(0, 7);
const H = 3_600_000;
const dayDoc = (key: string, activeMs: number) => ({ version: 1, dayKey: key, activeMs, sessions: [{ start: 1, end: 2, activeMs }] });
const appsDoc = (key: string, apps: Record<string, number>, unknownMs = 0) => ({ version: 1, dayKey: key, attributedMs: unknownMs + Object.values(apps).reduce((a, b) => a + b, 0), unknownMs, apps, hourly: [] });

type Acc = Awaited<ReturnType<TestEnv['register']>>;
type Dev = { id: string; epoch: number; clientDeviceId: string; token: string };
async function login(env: TestEnv, acc: Acc): Promise<string> {
  const r = await env.call('POST', '/v1/auth/login', { body: { email: acc.email, password: acc.password } });
  assert.equal(r.status, 200, r.text);
  return r.json.tokens.accessToken;
}
async function device(env: TestEnv, token: string, name = 'PC', extra: Record<string, unknown> = {}): Promise<Dev> {
  const clientDeviceId = randomUUID();
  const r = await env.call('POST', '/v1/sync/devices/register', { token, body: { clientDeviceId, name, platform: 'win32', appVersion: '1.5.0', hardware: { cpu: 'Test CPU', threads: 8, ramGb: 16 }, ...extra } });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.device.id, epoch: r.json.device.epoch, clientDeviceId, token };
}
const push = (env: TestEnv, d: Dev, ops: unknown[]) => env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: d.id, epoch: d.epoch, ops } });
const dev = (kind: string, key: string, data: unknown) => ({ kind, key, scope: 'device', clientUpdatedAt: iso(), data });
const remove = (env: TestEnv, token: string, id: string, body: Record<string, unknown> = { confirm: true }) => env.call('POST', `/v1/devices/${id}/remove`, { token, body });
const docCount = async (env: TestEnv, deviceId: string) => (await env.pool.query('SELECT count(*)::int AS n FROM sync_documents WHERE device_id = $1', [deviceId])).rows[0].n as number;

describe('devices: registration and identity', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('registers a computer once, however often or however parallel the registration is repeated', async () => {
    const a = await env.register(); const cid = randomUUID();
    const body = { clientDeviceId: cid, name: 'Desk', platform: 'win32', hardware: { cpu: 'X' } };
    const results = await Promise.all(Array.from({ length: 6 }, () => env.call('POST', '/v1/sync/devices/register', { token: a.tokens.accessToken, body })));
    for (const r of results) assert.equal(r.status, 200, r.text);
    assert.equal(new Set(results.map((r) => r.json.device.id)).size, 1, 'one device id');
    assert.equal(results.filter((r) => r.json.created).length, 1, 'exactly one request created it');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM devices WHERE client_device_id = $1', [cid])).rows[0].n, 1);
  });

  it('keeps several computers under one account, each with its own id, and tells the caller which one it is', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    const d1 = await device(env, t, 'Desk'); const d2 = await device(env, t, 'Laptop'); const d3 = await device(env, t, 'Laptop');   // equal names are fine: a name is a label
    assert.equal(new Set([d1.id, d2.id, d3.id]).size, 3);
    const r = await env.call('GET', `/v1/devices?clientDeviceId=${d2.clientDeviceId}`, { token: t });
    assert.equal(r.status, 200); assert.equal(r.json.devices.length, 3);
    assert.deepEqual(r.json.devices.filter((d: any) => d.current).map((d: any) => d.id), [d2.id]);
    for (const d of r.json.devices) { assert.equal(d.status, 'active'); assert.equal(d.nameCustomized, false); assert.equal(d.removed, false); assert.ok(d.hardware.cpu); assert.ok(!('clientDeviceId' in d), 'the installation id is never returned'); }
  });

  it('a computer is connected to exactly one account at a time (also under a race), and can move after it was removed', async () => {
    const a = await env.register(); const b = await env.register(); const cid = randomUUID();
    const reg = (acc: Acc) => env.call('POST', '/v1/sync/devices/register', { token: acc.tokens.accessToken, body: { clientDeviceId: cid, name: 'Shared PC' } });
    const [ra, rb] = await Promise.all([reg(a), reg(b)]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409], 'exactly one account wins the race');
    const loser = ra.status === 409 ? ra : rb; const winnerAcc = ra.status === 200 ? a : b; const loserAcc = ra.status === 200 ? b : a;
    assert.equal(loser.json.error.code, 'device_in_use_by_another_account');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM devices WHERE client_device_id = $1 AND revoked_at IS NULL', [cid])).rows[0].n, 1);
    // once the first account removed it, the other account may register it
    const id = (await env.call('GET', '/v1/devices', { token: winnerAcc.tokens.accessToken })).json.devices[0].id;
    assert.equal((await remove(env, winnerAcc.tokens.accessToken, id)).status, 409, 'the server knows this session belongs to that computer');
    assert.equal((await remove(env, winnerAcc.tokens.accessToken, id, { confirm: true, allowCurrent: true })).status, 200);
    assert.equal((await reg(loserAcc)).status, 200);
    // ... and the first account cannot silently take it back while it is active elsewhere (its old session ended with the removal)
    assert.equal((await env.call('POST', '/v1/sync/devices/register', { token: await login(env, winnerAcc), body: { clientDeviceId: cid, name: 'x', reactivate: true } })).json.error.code, 'device_in_use_by_another_account');
  });

  it('every device endpoint needs authentication', async () => {
    const id = randomUUID();
    for (const [m, p, body] of [['GET', '/v1/devices'], ['GET', `/v1/devices/${id}`], ['GET', `/v1/devices/${id}/summary`], ['PATCH', `/v1/devices/${id}`, { name: 'x' }], ['POST', `/v1/devices/${id}/remove`, { confirm: true }]] as const) {
      const r = await env.call(m, p, body ? { body } : {});
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });
});

describe('devices: detail, status and last synchronisation', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('shows hardware, metadata, cloud contents and storage of one device', async () => {
    const a = await env.register(); const t = a.tokens.accessToken; const d = await device(env, t, 'Desk');
    await push(env, d, [dev('day', dayKey(1), dayDoc(dayKey(1), 2 * H)), dev('apps', dayKey(1), appsDoc(dayKey(1), { 'chrome.exe': H }))]);
    const r = await env.call('GET', `/v1/devices/${d.id}?clientDeviceId=${d.clientDeviceId}`, { token: t });
    assert.equal(r.status, 200);
    const x = r.json.device;
    assert.equal(x.id, d.id); assert.equal(x.name, 'Desk'); assert.equal(x.platform, 'win32'); assert.equal(x.appVersion, '1.5.0'); assert.deepEqual(x.hardware, { cpu: 'Test CPU', threads: 8, ramGb: 16 });
    assert.equal(x.current, true); assert.equal(x.docCounts.day, 1); assert.equal(x.docCounts.apps, 1); assert.equal(x.lastUsageDay, dayKey(1)); assert.equal(x.activeMsLast7Days, 2 * H);
    assert.ok(x.storageBytes > 0); assert.ok(x.lastSyncAt);
  });

  it('classifies a computer as never / active / offline / stale / removed, and a quiet computer that only pulls stays active', async () => {
    const a = await env.register(); const t = a.tokens.accessToken; const d = await device(env, t, 'Desk');
    const status = async () => (await env.call('GET', `/v1/devices/${d.id}`, { token: await login(env, a) })).json.device.status;
    const set = (sql: string) => env.pool.query(`UPDATE devices SET ${sql} WHERE id = $1`, [d.id]);
    await set('last_seen_at = NULL, last_sync_at = NULL'); assert.equal(await status(), 'never');
    await set("last_seen_at = now() - interval '5 minutes', last_sync_at = now() - interval '5 minutes'"); assert.equal(await status(), 'active');
    await set("last_seen_at = now() - interval '2 hours', last_sync_at = now() - interval '2 hours'"); assert.equal(await status(), 'offline');
    await set("last_seen_at = now() - interval '5 days', last_sync_at = now() - interval '5 days'"); assert.equal(await status(), 'stale');
    // an idle computer has nothing to upload, but its periodic pull still proves it is running
    const pull = await env.call('GET', `/v1/sync/changes?deviceId=${d.id}&epoch=${d.epoch}&scope=account&since=0`, { token: t });
    assert.equal(pull.status, 200); assert.equal(await status(), 'active');
    const seen1 = (await env.pool.query('SELECT last_seen_at FROM devices WHERE id = $1', [d.id])).rows[0].last_seen_at.getTime();
    await env.call('GET', `/v1/sync/changes?deviceId=${d.id}&epoch=${d.epoch}&scope=account&since=0`, { token: t });
    assert.equal((await env.pool.query('SELECT last_seen_at FROM devices WHERE id = $1', [d.id])).rows[0].last_seen_at.getTime(), seen1, 'at most one write a minute per device');
    assert.equal((await remove(env, await login(env, a), d.id)).status, 200); assert.equal(await status(), 'removed');
  });
});

describe('devices: rename', () => {
  let env: TestEnv; let acc: Acc; let t: string; let d: Dev;
  before(async () => { env = await createTestEnv(); acc = await env.register(); t = acc.tokens.accessToken; d = await device(env, t, 'HOSTNAME-1'); });
  after(async () => { await env.close(); });
  const rename = (id: string, body: Record<string, unknown>, token = t) => env.call('PATCH', `/v1/devices/${id}`, { token, body });

  it('renames, normalises the name, is idempotent, and is not undone by the app registering again with its host name', async () => {
    const r1 = await rename(d.id, { name: '  Living   room PC ' });
    assert.equal(r1.status, 200); assert.equal(r1.json.outcome, 'applied'); assert.equal(r1.json.device.name, 'Living room PC'); assert.equal(r1.json.device.nameCustomized, true);
    const r2 = await rename(d.id, { name: 'Living room PC' }); assert.equal(r2.json.outcome, 'unchanged');
    const re = await env.call('POST', '/v1/sync/devices/register', { token: t, body: { clientDeviceId: d.clientDeviceId, name: 'HOSTNAME-1', platform: 'win32', appVersion: '1.5.1' } });
    assert.equal(re.json.device.name, 'Living room PC', 'the user\'s name survives automatic registration'); assert.equal(re.json.device.appVersion, '1.5.1', 'other details still update');
    const claim = await env.call('POST', '/v1/sync/devices/claim', { token: t, body: { deviceId: d.id, clientDeviceId: randomUUID(), name: 'REINSTALLED-HOST' } });
    assert.equal(claim.json.device.name, 'Living room PC', 'nor by a restore');
  });

  it('orders renames by the client clock: a late, older rename cannot undo a newer one', async () => {
    const d2 = await device(env, t, 'X');
    const newer = iso(Date.now() - 1000); const older = iso(Date.now() - 60_000);
    assert.equal((await rename(d2.id, { name: 'Newer', clientUpdatedAt: newer })).json.outcome, 'applied');
    const late = await rename(d2.id, { name: 'Older', clientUpdatedAt: older });
    assert.equal(late.status, 200); assert.equal(late.json.outcome, 'superseded'); assert.equal(late.json.device.name, 'Newer');
    assert.equal((await rename(d2.id, { name: 'Newer', clientUpdatedAt: older })).json.outcome, 'unchanged', 'repeating a request is harmless');
    const ahead = await rename(d2.id, { name: 'Future', clientUpdatedAt: iso(env.clock.now + 5 * 86_400_000) });   // a wrong clock is clamped, not trusted
    assert.equal(ahead.json.outcome, 'applied');
    const stored = (await env.pool.query('SELECT name_updated_at FROM devices WHERE id = $1', [d2.id])).rows[0].name_updated_at.getTime();
    assert.ok(stored <= env.clock.now + 5 * 60_000, 'clamped to the server time plus 5 minutes');
    env.clock.advance(6 * 60_000);
    assert.equal((await rename(d2.id, { name: 'After', clientUpdatedAt: iso(env.clock.now) })).json.outcome, 'applied', 'a clock 5 days ahead did not win forever');
  });

  it('two renames with the very same client time are both applied in arrival order (only a strictly older one is superseded)', async () => {
    const d3 = await device(env, t, 'Same-ms'); const at = iso(Date.now() - 1000);
    assert.equal((await rename(d3.id, { name: 'First', clientUpdatedAt: at })).json.outcome, 'applied');
    const second = await rename(d3.id, { name: 'Second', clientUpdatedAt: at });
    assert.equal(second.json.outcome, 'applied'); assert.equal(second.json.device.name, 'Second');
    assert.equal((await rename(d3.id, { name: 'Older', clientUpdatedAt: iso(Date.now() - 5000) })).json.outcome, 'superseded');
  });

  it('validates input strictly', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 'bad\u0000name' }, { name: 'tab\there'.replace('\t', '\u0007') }, { name: 5 }, { name: 'ok', id: 'x' }, { name: 'ok', userId: 'y' }, { name: 'ok', clientUpdatedAt: 'yesterday' }, { name: 'ok', epoch: 3 }]) {
      const r = await rename(d.id, body); assert.ok(r.status === 400 || r.status === 409, `${JSON.stringify(body)} -> ${r.status}`);
    }
    assert.equal((await rename('not-a-uuid', { name: 'x' })).status, 400);
    assert.equal((await rename(d.id, { name: 'x'.repeat(80) })).status, 200);
  });

  it('cannot rename a computer of another account (404, nothing changes)', async () => {
    const other = await env.register();
    const r = await rename(d.id, { name: 'hijacked' }, other.tokens.accessToken);
    assert.equal(r.status, 404); assert.equal(r.json.error.code, 'device_not_found');
    assert.notEqual((await env.pool.query('SELECT name FROM devices WHERE id = $1', [d.id])).rows[0].name, 'hijacked');
    assert.equal((await rename(randomUUID(), { name: 'x' })).status, 404, 'the same answer as for an unknown id');
  });
});

describe('devices: removal, revocation and cloud history', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  async function twoComputers() {
    const acc = await env.register(); const t1 = acc.tokens.accessToken; const t2 = await login(env, acc);   // each computer has its own signed-in session
    const a = await device(env, t1, 'Computer A'); const b = await device(env, t2, 'Computer B');
    await push(env, a, [dev('day', dayKey(2), dayDoc(dayKey(2), 3 * H)), dev('apps', dayKey(2), appsDoc(dayKey(2), { 'code.exe': H })), dev('rollup', monthKey(), { month: monthKey() }), dev('plant', 'ledger', { baseMs: 5 * H, days: { [dayKey(2)]: 2 * H } })]);
    await push(env, b, [dev('day', dayKey(2), dayDoc(dayKey(2), H))]);
    return { acc, t1, t2, a, b };
  }

  it('needs an explicit confirmation', async () => {
    const { t2, a } = await twoComputers();
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }, { deleteCloudHistory: true }]) assert.equal((await remove(env, t2, a.id, body)).status, 400, JSON.stringify(body));
    assert.equal((await env.pool.query('SELECT revoked_at FROM devices WHERE id = $1', [a.id])).rows[0].revoked_at, null);
  });

  it('refuses to remove the computer you are using unless that is confirmed separately', async () => {
    const { t2, b } = await twoComputers();
    const r = await remove(env, t2, b.id, { confirm: true, currentDeviceId: b.id });
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'cannot_remove_current_device');
    assert.equal((await env.pool.query('SELECT revoked_at FROM devices WHERE id = $1', [b.id])).rows[0].revoked_at, null);
    const ok = await remove(env, t2, b.id, { confirm: true, currentDeviceId: b.id, allowCurrent: true });
    assert.equal(ok.status, 200); assert.equal(ok.json.device.status, 'removed');
  });

  it('knows the current computer by itself: omitting currentDeviceId does not bypass the protection', async () => {
    const { t1, a } = await twoComputers();      // t1 is the session that registered computer A
    const r = await remove(env, t1, a.id, { confirm: true });
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'cannot_remove_current_device');
  });

  it('revokes: the removed computer can no longer sync, register itself back, or use its session; the others are unaffected', async () => {
    const { t1, t2, a, b } = await twoComputers();
    const r = await remove(env, t2, a.id, { confirm: true, currentDeviceId: b.id });
    assert.equal(r.status, 200); assert.equal(r.json.alreadyRemoved, false); assert.equal(r.json.historyDeletedNow, false); assert.equal(r.json.revokedSessions, 1); assert.equal(r.json.device.removedAt !== null, true);
    // its session (bound at registration) ended, so even its token is dead
    const dead = await push(env, a, []);
    assert.equal(dead.status, 401); assert.equal(dead.json.error.code, 'session_revoked');
    // a fresh sign-in of the same account on that computer still cannot sync with the removed device
    const again = await login(env, { email: (await env.pool.query('SELECT email FROM users WHERE id = (SELECT user_id FROM devices WHERE id = $1)', [a.id])).rows[0].email, password: 'correct horse battery staple' } as Acc);
    for (const res of [await env.call('POST', '/v1/sync/push', { token: again, body: { deviceId: a.id, epoch: a.epoch, ops: [] } }), await env.call('GET', `/v1/sync/changes?deviceId=${a.id}&scope=account&since=0`, { token: again }), await env.call('GET', `/v1/sync/status?deviceId=${a.id}`, { token: again })]) {
      assert.equal(res.status, 403); assert.equal(res.json.error.code, 'device_removed');
    }
    const reg = await env.call('POST', '/v1/sync/devices/register', { token: again, body: { clientDeviceId: a.clientDeviceId, name: 'Computer A' } });
    assert.equal(reg.status, 409); assert.equal(reg.json.error.code, 'device_removed', 'it cannot silently come back');
    assert.equal((await env.call('PATCH', `/v1/devices/${a.id}`, { token: again, body: { name: 'still here?' } })).status, 403);
    // the other computer and the account carry on
    assert.equal((await push(env, b, [dev('day', dayKey(1), dayDoc(dayKey(1), H))])).status, 200);
    assert.equal((await env.call('GET', '/v1/devices', { token: t2 })).json.devices.length, 1, 'the list no longer shows it');
  });

  it('can bring a removed computer back only through an explicit reactivation, which keeps its history', async () => {
    const { t2, a } = await twoComputers();
    await remove(env, t2, a.id);
    const t = await login(env, { email: (await env.pool.query('SELECT email FROM users WHERE id = (SELECT user_id FROM devices WHERE id = $1)', [a.id])).rows[0].email, password: 'correct horse battery staple' } as Acc);
    const r = await env.call('POST', '/v1/sync/devices/register', { token: t, body: { clientDeviceId: a.clientDeviceId, name: 'Computer A', reactivate: true } });
    assert.equal(r.status, 200); assert.equal(r.json.reactivated, true); assert.equal(r.json.created, false); assert.equal(r.json.device.id, a.id); assert.equal(r.json.device.status, 'active');
    assert.equal(await docCount(env, a.id), 4, 'its cloud history was kept');
    assert.equal((await env.call('POST', '/v1/sync/push', { token: t, body: { deviceId: a.id, epoch: r.json.device.epoch, ops: [] } })).status, 200);
  });

  it('KEEPS the cloud history by default: it stays readable and can be restored by a reinstalled computer', async () => {
    const { t2, a } = await twoComputers();
    const before = await docCount(env, a.id);
    const r = await remove(env, t2, a.id);
    assert.equal(await docCount(env, a.id), before); assert.equal(r.json.device.historyDeleted, false);
    const listed = await env.call('GET', '/v1/devices?includeRemoved=true', { token: t2 });
    const row = listed.json.devices.find((d: any) => d.id === a.id); assert.equal(row.status, 'removed'); assert.equal(row.removed, true); assert.equal(row.docCounts.day, 1);
    assert.equal((await env.call('GET', `/v1/devices/${a.id}/summary?days=30`, { token: t2 })).json.summary.usage.activeMs, 3 * H, 'still viewable');
    const sync = await env.call('GET', `/v1/sync/devices?includeRemoved=true`, { token: t2 });
    assert.ok(sync.json.devices.some((d: any) => d.id === a.id && d.removed === true), 'offered as a restore source');
    assert.ok(!(await env.call('GET', '/v1/sync/devices', { token: t2 })).json.devices.some((d: any) => d.id === a.id), 'but not in the normal list');
    // a reinstalled computer (new installation id) claims it and gets the history
    const fresh = randomUUID();
    const c = await env.call('POST', '/v1/sync/devices/claim', { token: t2, body: { deviceId: a.id, clientDeviceId: fresh, name: 'Reinstalled' } });
    assert.equal(c.status, 200); assert.equal(c.json.takenOver, true); assert.equal(c.json.device.status !== 'removed', true); assert.equal(c.json.device.epoch, a.epoch + 1);
    const feed = await env.call('GET', `/v1/sync/changes?deviceId=${a.id}&epoch=${c.json.device.epoch}&scope=device&target=${a.id}&since=0`, { token: t2 });
    assert.equal(feed.json.docs.length, before);
  });

  it('with deleteCloudHistory the device\'s documents are deleted for good, except the plant ledger (plant growth is account-wide and never shrinks)', async () => {
    const { t2, a, b } = await twoComputers();
    const bDocs = await docCount(env, b.id);
    const used = (await env.call('GET', `/v1/sync/status?deviceId=${b.id}`, { token: t2 })).json.usedBytes;
    const r = await remove(env, t2, a.id, { confirm: true, currentDeviceId: b.id, deleteCloudHistory: true });
    assert.equal(r.status, 200); assert.equal(r.json.historyDeletedNow, true); assert.equal(r.json.device.historyDeleted, true);
    const left = (await env.pool.query('SELECT kind FROM sync_documents WHERE device_id = $1', [a.id])).rows.map((x) => x.kind);
    assert.deepEqual(left, ['plant']);
    assert.equal(await docCount(env, b.id), bDocs, 'another computer\'s history is untouched');
    assert.ok((await env.call('GET', `/v1/sync/status?deviceId=${b.id}`, { token: t2 })).json.usedBytes < used, 'the quota was freed');
    const c = await env.call('POST', '/v1/sync/devices/claim', { token: t2, body: { deviceId: a.id, clientDeviceId: randomUUID(), name: 'x' } });
    assert.equal(c.status, 409); assert.equal(c.json.error.code, 'device_history_deleted');
    assert.ok(!(await env.call('GET', '/v1/sync/devices?includeRemoved=true', { token: t2 })).json.devices.some((d: any) => d.id === a.id), 'nothing left to restore from');
  });

  it('is idempotent: repeating the request changes nothing, and a later repeat may still delete the history', async () => {
    const { t2, a } = await twoComputers();
    const r1 = await remove(env, t2, a.id); const r2 = await remove(env, t2, a.id);
    assert.equal(r1.json.alreadyRemoved, false); assert.equal(r2.status, 200); assert.equal(r2.json.alreadyRemoved, true); assert.equal(r2.json.revokedSessions, 0);
    assert.equal(r1.json.device.removedAt, r2.json.device.removedAt, 'the removal time does not move');
    const r3 = await remove(env, t2, a.id, { confirm: true, deleteCloudHistory: true }); assert.equal(r3.json.alreadyRemoved, true); assert.equal(r3.json.historyDeletedNow, true);
    const r4 = await remove(env, t2, a.id, { confirm: true, deleteCloudHistory: true }); assert.equal(r4.json.historyDeletedNow, false);
  });

  it('a push racing with the removal either lands before it or is refused, never after', async () => {
    const { t2, a, t1 } = await twoComputers();
    const pushes = Array.from({ length: 8 }, (_, i) => env.call('POST', '/v1/sync/push', { token: t1, body: { deviceId: a.id, epoch: a.epoch, ops: [dev('day', dayKey(10 + i), dayDoc(dayKey(10 + i), H))] } }));
    const rm = remove(env, t2, a.id, { confirm: true, deleteCloudHistory: true });
    const done = await Promise.all([...pushes, rm]);
    assert.equal(done[done.length - 1]!.status, 200);
    assert.deepEqual((await env.pool.query("SELECT kind FROM sync_documents WHERE device_id = $1 AND kind <> 'plant'", [a.id])).rows, [], 'nothing of the removed device remains, whichever request came first');
    for (const r of done.slice(0, -1)) assert.ok([200, 401, 403].includes(r.status), String(r.status));
  });

  it('cannot remove, purge or even see a computer of another account', async () => {
    const { a } = await twoComputers(); const other = await env.register(); const ot = other.tokens.accessToken;
    const r = await remove(env, ot, a.id, { confirm: true, deleteCloudHistory: true, allowCurrent: true });
    assert.equal(r.status, 404); assert.equal(r.json.error.code, 'device_not_found');
    assert.equal((await env.pool.query('SELECT revoked_at FROM devices WHERE id = $1', [a.id])).rows[0].revoked_at, null);
    assert.equal(await docCount(env, a.id), 4);
    for (const p of [`/v1/devices/${a.id}`, `/v1/devices/${a.id}/summary`]) assert.equal((await env.call('GET', p, { token: ot })).status, 404, p);
    assert.equal((await env.call('GET', '/v1/devices?includeRemoved=true', { token: ot })).json.devices.length, 0);
  });

  it('leaves a security record of the removal', async () => {
    const { acc, t2, a } = await twoComputers();
    await remove(env, t2, a.id);
    const ev = await env.call('GET', '/v1/account/security-events', { token: t2 });
    assert.ok(ev.json.events.some((e: any) => e.type === 'session_revoked' && /device removed/.test(e.detail ?? '')), JSON.stringify(ev.json.events));
    void acc;
  });
});

describe('devices: per-device summaries never mix or double-count computers', () => {
  let env: TestEnv; let acc: Acc; let t: string; let A: Dev; let B: Dev;
  before(async () => {
    env = await createTestEnv(); acc = await env.register(); t = acc.tokens.accessToken; A = await device(env, t, 'A'); B = await device(env, t, 'B');
    await push(env, A, [dev('day', dayKey(1), dayDoc(dayKey(1), 2 * H)), dev('day', dayKey(3), dayDoc(dayKey(3), H)), dev('day', dayKey(60), dayDoc(dayKey(60), 9 * H)),
      dev('apps', dayKey(1), appsDoc(dayKey(1), { 'chrome.exe': H, 'code.exe': H / 2 }, H / 2)), dev('apps', dayKey(3), appsDoc(dayKey(3), { 'chrome.exe': H / 2 })),
      dev('health', monthKey(), { lines: [{ t: 1, k: 'start', id: 'cpuHot', sev: 1 }, { t: 2, k: 'end', id: 'cpuHot' }, { t: 3, k: 'start', id: 'cpuHot', sev: 2 }, { t: 4, k: 'start', id: 'ramHigh', sev: 1 }] }),
      dev('rollup', monthKey(), { month: monthKey() })]);
    await push(env, B, [dev('day', dayKey(1), dayDoc(dayKey(1), 5 * H)), dev('apps', dayKey(1), appsDoc(dayKey(1), { 'game.exe': 4 * H }))]);
  });
  after(async () => { await env.close(); });
  const sum = async (id: string, days = 30) => (await env.call('GET', `/v1/devices/${id}/summary?days=${days}`, { token: t })).json.summary;

  it('counts only the chosen computer\'s own documents', async () => {
    const a = await sum(A.id); const b = await sum(B.id);
    assert.equal(a.usage.activeMs, 3 * H); assert.equal(a.usage.activeDays, 2); assert.deepEqual(a.usage.daily.map((d: any) => d.day), [dayKey(3), dayKey(1)]);
    assert.deepEqual(a.apps.top, [{ app: 'chrome.exe', ms: 1.5 * H }, { app: 'code.exe', ms: H / 2 }]); assert.equal(a.apps.unknownMs, H / 2); assert.equal(a.apps.attributedMs, 2.5 * H);
    assert.equal(b.usage.activeMs, 5 * H); assert.deepEqual(b.apps.top, [{ app: 'game.exe', ms: 4 * H }]);
    assert.equal(a.usage.activeMs + b.usage.activeMs, 8 * H, 'the two computers add up exactly once');
    assert.ok(!JSON.stringify(a).includes('game.exe') && !JSON.stringify(b).includes('chrome.exe'));
  });
  it('windows by days, reports coverage of the whole history, health episodes and hardware-summary months', async () => {
    assert.equal((await sum(A.id, 7)).usage.activeMs, 3 * H);
    const wide = await sum(A.id, 90); assert.equal(wide.usage.activeMs, 12 * H); assert.equal(wide.usage.daily.length, 3);
    const a = await sum(A.id, 7);
    assert.deepEqual(a.coverage, { firstDay: dayKey(60), lastDay: dayKey(1), usageDays: 3 });
    assert.equal(a.health.episodes, 3); assert.deepEqual(a.health.topProblems, [{ id: 'cpuHot', episodes: 2 }, { id: 'ramHigh', episodes: 1 }]); assert.deepEqual(a.performance.months, [monthKey()]);
    const b = await sum(B.id); assert.equal(b.health.episodes, 0); assert.deepEqual(b.performance.months, []);
  });
  it('an empty computer gives an empty, well-formed summary', async () => {
    const e = await device(env, t, 'Empty'); const s = await sum(e.id);
    assert.deepEqual(s.usage, { activeMs: 0, activeDays: 0, daily: [] }); assert.deepEqual(s.coverage, { firstDay: null, lastDay: null, usageDays: 0 }); assert.deepEqual(s.apps.top, []);
  });
  it('rejects a bad range', async () => {
    for (const q of ['days=0', 'days=366', 'days=abc', 'days=1.5']) assert.equal((await env.call('GET', `/v1/devices/${A.id}/summary?${q}`, { token: t })).status, 400, q);
  });
  it('the per-device feed of the sync API returns that computer\'s documents only', async () => {
    const feed = await env.call('GET', `/v1/sync/changes?deviceId=${A.id}&epoch=${A.epoch}&scope=device&target=${B.id}&since=0`, { token: t });
    assert.ok(feed.json.docs.length > 0 && feed.json.docs.every((d: any) => d.deviceId === B.id));
  });
});

describe('devices: rate limiting', () => {
  it('limits removal requests and device management requests separately', async () => {
    const env = await createTestEnv({ RATE_LIMIT_DEVICE_REMOVE_MAX: '2', RATE_LIMIT_DEVICES_MAX: '6' });
    try {
      const acc = await env.register(); const t = await login(env, acc); const d = await device(env, acc.tokens.accessToken, 'x');
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await remove(env, t, d.id, { confirm: true })).status);
      assert.deepEqual(statuses, [200, 200, 429]);
      const r = await env.call('GET', '/v1/devices', { token: t });
      for (let i = 0; i < 6; i += 1) await env.call('GET', '/v1/devices', { token: t });
      const limited = await env.call('GET', '/v1/devices', { token: t });
      assert.equal(limited.status, 429); assert.equal(limited.json.error.code, 'rate_limited'); assert.ok(limited.headers.get('retry-after')); void r;
    } finally { await env.close(); }
  });
});
