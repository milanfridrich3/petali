import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const dayKey = (offset = 0) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const monthKey = () => dayKey().slice(0, 7);
const dayDoc = (key: string, activeMs = 3_600_000, extra: Record<string, unknown> = {}) => ({ version: 1, dayKey: key, activeMs, sessions: [{ start: 1, end: 2, activeMs }], ...extra });

type Acc = Awaited<ReturnType<TestEnv['register']>>;
async function device(env: TestEnv, acc: Acc, name = 'PC') {
  const clientDeviceId = randomUUID();
  const r = await env.call('POST', '/v1/sync/devices/register', { token: acc.tokens.accessToken, body: { clientDeviceId, name, platform: 'win32', appVersion: '1.4.0', hardware: { cpu: 'Test CPU', ramGb: 16 } } });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.device.id as string, epoch: r.json.device.epoch as number, clientDeviceId, token: acc.tokens.accessToken as string };
}
const push = (env: TestEnv, d: { id: string; epoch: number; token: string }, ops: unknown[], over: Record<string, unknown> = {}) => env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: d.id, epoch: d.epoch, ops, ...over } });
const setting = (key: string, data: unknown, ts = iso(), extra: Record<string, unknown> = {}) => ({ kind: 'setting', key, scope: 'account', clientUpdatedAt: ts, data, ...extra });
const dev = (kind: string, key: string, data: unknown, ts = iso()) => ({ kind, key, scope: 'device', clientUpdatedAt: ts, data });
const feed = (env: TestEnv, d: { id: string; token: string; epoch?: number }, q: string) => env.call('GET', `/v1/sync/changes?deviceId=${d.id}&${q}`, { token: d.token });

describe('sync: devices', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv(); });
  after(async () => { await env.close(); });

  it('registers a device, and registering again is idempotent (same row, updated details)', async () => {
    const a = await env.register(); const cid = randomUUID();
    const r1 = await env.call('POST', '/v1/sync/devices/register', { token: a.tokens.accessToken, body: { clientDeviceId: cid, name: 'Desk', platform: 'win32', hardware: { cpu: 'X' } } });
    assert.equal(r1.json.created, true); assert.equal(r1.json.device.epoch, 1);
    const r2 = await env.call('POST', '/v1/sync/devices/register', { token: a.tokens.accessToken, body: { clientDeviceId: cid, name: 'Desk renamed', appVersion: '1.5.0' } });
    assert.equal(r2.json.created, false); assert.equal(r2.json.device.id, r1.json.device.id); assert.equal(r2.json.device.name, 'Desk renamed');
    assert.deepEqual(r2.json.device.hardware, { cpu: 'X' }, 'hardware kept when not re-sent');
    assert.equal((await env.call('GET', '/v1/sync/devices', { token: a.tokens.accessToken })).json.devices.length, 1);
  });
  it('flags which device is the caller\'s own when its client id is given', async () => {
    const a = await env.register(); const d1 = await device(env, a, 'one'); await device(env, a, 'two');
    const l = (await env.call('GET', `/v1/sync/devices?clientDeviceId=${d1.clientDeviceId}`, { token: a.tokens.accessToken })).json.devices;
    assert.deepEqual(l.map((x: any) => [x.name, x.current]), [['one', true], ['two', false]]);
    assert.ok((await env.call('GET', '/v1/sync/devices', { token: a.tokens.accessToken })).json.devices.every((x: any) => x.current === false));
    assert.equal((await env.call('GET', '/v1/sync/devices?clientDeviceId=nope', { token: a.tokens.accessToken })).status, 400);
  });
  it('validates device input strictly', async () => {
    const a = await env.register(); const t = a.tokens.accessToken;
    for (const body of [{}, { clientDeviceId: 'nope', name: 'x' }, { clientDeviceId: randomUUID(), name: '' }, { clientDeviceId: randomUUID(), name: 'x', userId: 'y' }, { clientDeviceId: randomUUID(), name: 'x', hardware: { a: { nested: 1 } } }, { clientDeviceId: randomUUID(), name: 'bad\u0000' }]) {
      assert.equal((await env.call('POST', '/v1/sync/devices/register', { token: t, body })).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });
  it('an account can have at most 20 devices', async () => {
    const a = await env.register();
    for (let i = 0; i < 20; i += 1) await device(env, a, `PC${i}`);
    const r = await env.call('POST', '/v1/sync/devices/register', { token: a.tokens.accessToken, body: { clientDeviceId: randomUUID(), name: 'one too many' } });
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'device_limit');
  });
  it('all sync endpoints need a signed-in account', async () => {
    for (const [m, p] of [['GET', '/v1/sync/devices'], ['POST', '/v1/sync/devices/register'], ['POST', '/v1/sync/push'], ['GET', '/v1/sync/changes'], ['GET', '/v1/sync/status'], ['POST', '/v1/sync/devices/claim']] as const) {
      assert.equal((await env.call(m, p, m === 'POST' ? { body: {} } : {})).status, 401, p);
    }
  });
  it('the device list shows counts and recent usage per device', async () => {
    const a = await env.register(); const d = await device(env, a, 'Main');
    await push(env, d, [dev('day', dayKey(0), dayDoc(dayKey(0), 2 * 3_600_000)), dev('day', dayKey(2), dayDoc(dayKey(2), 3_600_000)), dev('day', dayKey(40), dayDoc(dayKey(40), 9_000_000)), dev('apps', dayKey(0), { version: 1, dayKey: dayKey(0), apps: {}, hourly: [] })]);
    const l = (await env.call('GET', '/v1/sync/devices', { token: d.token })).json.devices[0];
    assert.deepEqual(l.docCounts, { day: 3, apps: 1 }); assert.equal(l.activeMsLast7Days, 3 * 3_600_000); assert.equal(l.lastUsageDay, dayKey(0)); assert.ok(l.lastSyncAt);
  });
});

describe('sync: push', () => {
  let env: TestEnv; let acc: Acc; let d: Awaited<ReturnType<typeof device>>;
  before(async () => { env = await createTestEnv(); acc = await env.register(); d = await device(env, acc); });
  after(async () => { await env.close(); });

  it('stores account settings and device documents, and a repeat is "unchanged" without a new sequence number', async () => {
    const ops = [setting('ui.lang', 'en'), dev('day', dayKey(), dayDoc(dayKey()))];
    const r1 = await push(env, d, ops);
    assert.deepEqual(r1.json.results.map((x: any) => x.outcome), ['applied', 'applied']);
    const seq1 = (await feed(env, d, 'scope=account&since=0')).json.cursor;
    const r2 = await push(env, d, ops);
    assert.deepEqual(r2.json.results.map((x: any) => x.outcome), ['unchanged', 'unchanged']);
    assert.equal((await feed(env, d, 'scope=account&since=0')).json.cursor, seq1, 'no duplicate rows / no new sequence');
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM sync_documents')).rows[0].n, 2);
  });
  it('the same content with a different key order is still a duplicate', async () => {
    await push(env, d, [setting('dashboard.layout', { a: 1, b: { x: 1, y: 2 } })]);
    const r = await push(env, d, [setting('dashboard.layout', { b: { y: 2, x: 1 }, a: 1 }, iso(Date.now() + 1000))]);
    assert.equal(r.json.results[0].outcome, 'unchanged');
  });
  it('changed content updates the same row (one row per document)', async () => {
    await push(env, d, [dev('day', dayKey(1), dayDoc(dayKey(1), 1000))]);
    const r = await push(env, d, [dev('day', dayKey(1), dayDoc(dayKey(1), 2000))]);
    assert.equal(r.json.results[0].outcome, 'applied');
    const rows = await env.pool.query(`SELECT data FROM sync_documents WHERE kind = 'day' AND doc_key = $1`, [dayKey(1)]);
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].data.activeMs, 2000);
  });
  it('a bad document is rejected on its own; the others in the batch still go through', async () => {
    const r = await push(env, d, [setting('ui.lang', 'fr'), setting('ui.name', 'Okay'), { kind: 'nope', key: 'x', scope: 'account', clientUpdatedAt: iso(), data: 1 }, dev('day', dayKey(3), dayDoc('2020-02-02')), setting('ui.effects', 'yes')]);
    assert.deepEqual(r.json.results.map((x: any) => x.outcome), ['rejected', 'applied', 'rejected', 'rejected', 'rejected']);
    assert.match(r.json.results[0].reason, /cs|en/); assert.match(r.json.results[3].reason, /dayKey/);
  });
  it('enforces kind scope, key format, date range, and per-kind limits', async () => {
    const bad = [
      { kind: 'day', key: dayKey(), scope: 'account', clientUpdatedAt: iso(), data: dayDoc(dayKey()) },
      { kind: 'setting', key: 'ui.lang', scope: 'device', clientUpdatedAt: iso(), data: 'en' },
      setting('secrets.password', 'x'), setting('apps.override.', 'Games'), setting('../../etc', 'x'),
      dev('day', '2999-01-01', dayDoc('2999-01-01')), dev('day', '1999-01-01', dayDoc('1999-01-01')), dev('rollup', '2026-13-45', {}),
      dev('day', dayKey(), dayDoc(dayKey(), 86_400_000 * 2)), dev('plant', 'ledger', { baseMs: 0, days: { [dayKey()]: 5 * 3_600_000 } }),
      setting('ui.name', 'x'.repeat(21)), setting('dashboard.layout', 'not an object'),
      { ...dev('health', monthKey(), { lines: 'no' }) },
    ];
    const r = await push(env, d, bad);
    assert.equal(r.status, 200);
    assert.ok(r.json.results.every((x: any) => x.outcome === 'rejected'), JSON.stringify(r.json.results.map((x: any) => x.outcome)));
  });
  it('rejects oversized documents and oversized batches', async () => {
    const big = dayDoc(dayKey(5), 1000, { sessions: Array.from({ length: 1900 }, (_, i) => ({ start: i, end: i + 1, activeMs: 1, pad: 'x'.repeat(200) })) });
    assert.equal((await push(env, d, [dev('day', dayKey(5), big)])).json.results[0].outcome, 'rejected');
    const many = Array.from({ length: 51 }, (_, i) => setting('ui.name', `n${i}`));
    const r = await push(env, d, many); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'too_many_ops');
  });
  it('rejects unknown fields and malformed requests (strict)', async () => {
    for (const body of [{}, { deviceId: d.id, epoch: d.epoch }, { deviceId: d.id, epoch: d.epoch, ops: [], extra: 1 }, { deviceId: d.id, epoch: d.epoch, ops: [{ kind: 'setting', key: 'ui.lang', scope: 'account', clientUpdatedAt: iso(), data: 'en', owner: 'x' }] }, { deviceId: 'x', epoch: 1, ops: [] }, { deviceId: d.id, epoch: 0, ops: [] }]) {
      assert.equal((await env.call('POST', '/v1/sync/push', { token: d.token, body })).status, 400, JSON.stringify(body).slice(0, 80));
    }
  });
  it('accepts a large body for sync (up to 4 MB) but other endpoints keep the small limit', async () => {
    const r = await env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: d.id, epoch: d.epoch, ops: [dev('rollup', monthKey(), { version: 1, pad: 'x'.repeat(600_000) })] } });
    assert.equal(r.status, 200); assert.equal(r.json.results[0].outcome, 'rejected', 'over the per-document limit, but the request itself was accepted');
    const huge = await env.call('POST', '/v1/sync/push', { token: d.token, raw: JSON.stringify({ pad: 'x'.repeat(4_300_000) }), headers: { 'content-type': 'application/json' } });
    assert.equal(huge.status, 413);
    assert.equal((await env.call('POST', '/v1/auth/login', { raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(40_000) }), headers: { 'content-type': 'application/json' } })).status, 413);
  });
  it('an unknown device, someone else\'s device, or a stale epoch cannot push', async () => {
    const other = await env.register(); const od = await device(env, other);
    assert.equal((await env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: randomUUID(), epoch: 1, ops: [] } })).status, 404);
    assert.equal((await env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: od.id, epoch: 1, ops: [setting('ui.name', 'hijack')] } })).status, 404);
    const stale = await env.call('POST', '/v1/sync/push', { token: d.token, body: { deviceId: d.id, epoch: d.epoch + 1, ops: [] } });
    assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'device_superseded');
    assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM sync_documents WHERE data = '"hijack"'::jsonb`)).rows[0].n, 0);
  });
  it('device documents always go to the pushing device, never to another', async () => {
    const a2 = await env.register(); const d1 = await device(env, a2, 'one'); const d2 = await device(env, a2, 'two');
    await push(env, d1, [dev('day', dayKey(), dayDoc(dayKey(), 111))]); await push(env, d2, [dev('day', dayKey(), dayDoc(dayKey(), 222))]);
    const rows = (await env.pool.query(`SELECT device_id, (data->>'activeMs')::int AS ms FROM sync_documents WHERE kind='day' AND user_id = (SELECT user_id FROM devices WHERE id = $1)`, [d1.id])).rows;
    assert.equal(rows.length, 2); assert.equal(rows.find((r) => r.device_id === d1.id).ms, 111); assert.equal(rows.find((r) => r.device_id === d2.id).ms, 222);
  });
  it('updates last_sync_at of the device', async () => {
    const a2 = await env.register(); const d1 = await device(env, a2);
    assert.equal((await env.pool.query('SELECT last_sync_at FROM devices WHERE id = $1', [d1.id])).rows[0].last_sync_at, null);
    await push(env, d1, []);
    assert.ok((await env.pool.query('SELECT last_sync_at FROM devices WHERE id = $1', [d1.id])).rows[0].last_sync_at);
  });
});

describe('sync: conflicts between devices', () => {
  let env: TestEnv; let acc: Acc; let A: Awaited<ReturnType<typeof device>>; let B: Awaited<ReturnType<typeof device>>;
  before(async () => { env = await createTestEnv(); acc = await env.register(); A = await device(env, acc, 'A'); B = await device(env, acc, 'B'); });
  after(async () => { await env.close(); });
  const t0 = Date.now() - 600_000;

  it('the later change wins; the loser is told the winning value', async () => {
    await push(env, A, [setting('ui.name', 'FromA', iso(t0))]);
    const b = await push(env, B, [setting('ui.name', 'FromB', iso(t0 + 1000))]);
    assert.equal(b.json.results[0].outcome, 'applied');
    const late = await push(env, A, [setting('ui.name', 'StaleA', iso(t0 + 500))]);
    assert.equal(late.json.results[0].outcome, 'superseded'); assert.equal(late.json.results[0].current.data, 'FromB');
    assert.equal((await env.pool.query(`SELECT data FROM sync_documents WHERE doc_key = 'ui.name'`)).rows[0].data, 'FromB');
  });
  it('an exact tie is decided the same way every time (by device id)', async () => {
    const ts = iso(t0 + 5000); const winner = A.id > B.id ? A : B; const loser = winner === A ? B : A;
    await push(env, loser, [setting('ui.mode', 'day', ts)]);
    const w = await push(env, winner, [setting('ui.mode', 'night', ts)]);
    assert.equal(w.json.results[0].outcome, 'applied');
    const l = await push(env, loser, [setting('ui.mode', 'day', ts)]);
    assert.equal(l.json.results[0].outcome, 'superseded');
  });
  it('a value that was never changed on its computer (default) never replaces an existing setting, but does fill an empty one', async () => {
    const floor = '2020-01-02T00:00:00.000Z';
    for (const dev_ of [A, B]) { const r = await push(env, dev_, [setting('ui.effects', true, floor)]); assert.ok(['applied', 'unchanged'].includes(r.json.results[0].outcome)); break; }
    const real = await push(env, A, [setting('ui.effects', false, iso(t0 + 30_000))]);
    assert.equal(real.json.results[0].outcome, 'applied');
    for (const d_ of [A, B]) { const r = await push(env, d_, [setting('ui.effects', true, floor)]); assert.equal(r.json.results[0].outcome, 'superseded', 'defaults never win, whichever device id is higher'); }
    assert.equal((await env.pool.query(`SELECT data FROM sync_documents WHERE doc_key = 'ui.effects'`)).rows[0].data, false);
  });
  it('independent settings never overwrite each other (per-key documents)', async () => {
    await push(env, A, [setting('ui.lang', 'cs', iso(t0 + 10_000))]); await push(env, B, [setting('ui.effects', false, iso(t0 + 10_000))]);
    const f = (await feed(env, A, 'scope=account&since=0')).json.docs;
    assert.equal(f.find((x: any) => x.key === 'ui.lang').data, 'cs'); assert.equal(f.find((x: any) => x.key === 'ui.effects').data, false);
  });
  it('a clock far in the future cannot win forever (timestamps are clamped to server time + 5 min)', async () => {
    env.clock.now = Date.now();
    const bogus = await push(env, A, [setting('ui.plant', 'rose', iso(env.clock.now + 365 * 86_400_000))]);
    assert.equal(bogus.json.results[0].outcome, 'applied');
    const stored = (await env.pool.query(`SELECT client_updated_at FROM sync_documents WHERE doc_key = 'ui.plant'`)).rows[0].client_updated_at.getTime();
    assert.ok(stored <= env.clock.now + 5 * 60_000 + 1000, 'stored time was clamped');
    assert.equal((await push(env, B, [setting('ui.plant', 'fern', iso(env.clock.now + 1000))])).json.results[0].outcome, 'superseded', 'within the clamp window the bogus write still counts');
    env.clock.advance(6 * 60_000);
    assert.equal((await push(env, B, [setting('ui.plant', 'fern', iso(env.clock.now))])).json.results[0].outcome, 'applied', 'a real change after the window wins');
  });
  it('removal is a tombstone that also wins/loses by time, and can be undone by a later write', async () => {
    await push(env, A, [setting('apps.override.game.exe', 'Games', iso(t0 + 20_000))]);
    const del = await push(env, B, [{ kind: 'setting', key: 'apps.override.game.exe', scope: 'account', clientUpdatedAt: iso(t0 + 21_000), deleted: true }]);
    assert.equal(del.json.results[0].outcome, 'applied');
    const f = (await feed(env, A, 'scope=account&since=0')).json.docs.find((x: any) => x.key === 'apps.override.game.exe');
    assert.equal(f.deleted, true); assert.equal(f.data, null);
    assert.equal((await push(env, A, [setting('apps.override.game.exe', 'Games', iso(t0 + 20_500))])).json.results[0].outcome, 'superseded');
    assert.equal((await push(env, A, [setting('apps.override.game.exe', 'Work', iso(t0 + 22_000))])).json.results[0].outcome, 'applied');
  });
  it('device documents cannot be deleted', async () => {
    const r = await push(env, A, [{ kind: 'day', key: dayKey(), scope: 'device', clientUpdatedAt: iso(), deleted: true }]);
    assert.equal(r.json.results[0].outcome, 'rejected');
  });
});

describe('sync: plant ledger', () => {
  let env: TestEnv; let acc: Acc; let A: Awaited<ReturnType<typeof device>>; let B: Awaited<ReturnType<typeof device>>;
  before(async () => { env = await createTestEnv(); acc = await env.register(); A = await device(env, acc, 'A'); B = await device(env, acc, 'B'); });
  after(async () => { await env.close(); });
  const ledger = (days: Record<string, number>, baseMs = 0) => dev('plant', 'ledger', { baseMs, days });
  const cur = async (d: typeof A) => (await feed(env, d, 'scope=plant&since=0')).json.docs.find((x: any) => x.deviceId === d.id)?.data;

  it('is merged per day by maximum, so a smaller or repeated upload never lowers it', async () => {
    await push(env, A, [ledger({ [dayKey(2)]: 3_000_000, [dayKey(1)]: 1_000_000 }, 7_200_000)]);
    await push(env, A, [ledger({ [dayKey(2)]: 2_000_000, [dayKey(1)]: 1_500_000 }, 3_600_000)]);   // older snapshot, e.g. a retried request
    assert.deepEqual(await cur(A), { baseMs: 7_200_000, days: { [dayKey(2)]: 3_000_000, [dayKey(1)]: 1_500_000 } });
    const same = await push(env, A, [ledger({ [dayKey(2)]: 3_000_000 })]);
    assert.equal(same.json.results[0].outcome, 'unchanged');
  });
  it('each device has its own ledger; both are visible to every device of the account', async () => {
    await push(env, B, [ledger({ [dayKey(1)]: 2_000_000 }, 1_000_000)]);
    const docs = (await feed(env, A, 'scope=plant&since=0')).json.docs;
    assert.equal(docs.length, 2); assert.deepEqual(docs.map((x: any) => x.deviceId).sort(), [A.id, B.id].sort());
  });
  it('rejects a day above the daily cap, a malformed ledger, and other users\' ledgers are invisible', async () => {
    assert.equal((await push(env, A, [ledger({ [dayKey()]: 4 * 3_600_000 + 1 })])).json.results[0].outcome, 'rejected');
    assert.equal((await push(env, A, [dev('plant', 'ledger', { baseMs: -1, days: {} })])).json.results[0].outcome, 'rejected');
    assert.equal((await push(env, A, [dev('plant', 'other', { baseMs: 0, days: {} })])).json.results[0].outcome, 'rejected');
    const o = await env.register(); const od = await device(env, o);
    assert.equal((await feed(env, od, 'scope=plant&since=0')).json.docs.length, 0);
  });
});

describe('sync: incremental changes feed', () => {
  let env: TestEnv; let acc: Acc; let A: Awaited<ReturnType<typeof device>>; let B: Awaited<ReturnType<typeof device>>;
  before(async () => { env = await createTestEnv(); acc = await env.register(); A = await device(env, acc, 'A'); B = await device(env, acc, 'B'); });
  after(async () => { await env.close(); });

  it('returns only what changed after the cursor, and an empty page keeps the cursor', async () => {
    await push(env, A, [setting('ui.lang', 'en'), setting('ui.name', 'N')]);
    const p1 = (await feed(env, B, 'scope=account&since=0')).json;
    assert.equal(p1.docs.length, 2); assert.equal(p1.hasMore, false);
    assert.deepEqual((await feed(env, B, `scope=account&since=${p1.cursor}`)).json.docs, []);
    assert.equal((await feed(env, B, `scope=account&since=${p1.cursor}`)).json.cursor, p1.cursor);
    await push(env, A, [setting('ui.name', 'N2', iso(Date.now() + 1000))]);
    const p2 = (await feed(env, B, `scope=account&since=${p1.cursor}`)).json;
    assert.deepEqual(p2.docs.map((x: any) => [x.key, x.data]), [['ui.name', 'N2']]); assert.ok(p2.cursor > p1.cursor);
  });
  it('pages with a limit and never skips or repeats a document', async () => {
    const ops = Array.from({ length: 12 }, (_, i) => setting(`apps.override.app${i}.exe`, 'Games'));
    await push(env, A, ops);
    const seen: string[] = []; let since = 0; let pages = 0;
    for (;;) {
      const r = (await feed(env, B, `scope=account&since=${since}&limit=5`)).json; pages += 1;
      for (const d of r.docs) seen.push(d.key); since = r.cursor;
      if (!r.hasMore) break;
    }
    assert.equal(new Set(seen).size, seen.length, 'no duplicates'); assert.ok(seen.filter((k) => k.startsWith('apps.override.')).length === 12);
    assert.ok(pages >= 3);
  });
  it('skipOwn leaves out what the asking device wrote itself', async () => {
    const all = (await feed(env, A, 'scope=account&since=0')).json.docs.length;
    const noOwn = (await feed(env, A, 'scope=account&since=0&skipOwn=true')).json.docs.length;
    assert.ok(all > 0); assert.equal(noOwn, 0);
    assert.equal((await feed(env, B, 'scope=account&since=0&skipOwn=true')).json.docs.length, all);
  });
  it('the device feed (restore) returns that device\'s documents of every kind, oldest first, and validates the target', async () => {
    await push(env, A, [dev('day', dayKey(), dayDoc(dayKey())), dev('apps', dayKey(), { version: 1, dayKey: dayKey(), apps: { 'a.exe': 5 }, hourly: [] }), dev('rollup', monthKey(), { version: 1 }), dev('health', monthKey(), { lines: [] })]);
    const r = (await feed(env, B, `scope=device&target=${A.id}&since=0`)).json;
    assert.deepEqual(r.docs.map((x: any) => x.kind), ['day', 'apps', 'rollup', 'health']); assert.ok(r.docs.every((x: any) => x.deviceId === A.id));
    assert.equal((await feed(env, B, 'scope=device&since=0')).status, 400);
    assert.equal((await feed(env, B, `scope=device&target=${randomUUID()}&since=0`)).status, 404);
  });
  it('rejects bad parameters', async () => {
    for (const q of ['scope=nope', 'scope=account&since=-1', 'scope=account&limit=0', 'scope=account&limit=9999', 'scope=account&since=abc']) assert.equal((await feed(env, A, q)).status, 400, q);
    assert.equal((await env.call('GET', '/v1/sync/changes?scope=account', { token: A.token })).status, 400);
  });
  it('a response is capped in size even when many large documents match', async () => {
    const e2 = await createTestEnv(); try {
      const a = await e2.register(); const d = await device(e2, a);
      for (let i = 0; i < 6; i += 1) await push(e2, d, [dev('rollup', `2026-0${i + 1}`, { version: 1, pad: 'x'.repeat(400_000) })]);
      const r = (await feed(e2, d, 'scope=device&target=' + d.id + '&since=0&limit=200')).json;
      assert.ok(r.docs.length < 6 && r.hasMore === true, `${r.docs.length} docs`);
      const rest = (await feed(e2, d, `scope=device&target=${d.id}&since=${r.cursor}&limit=200`)).json;
      assert.equal(r.docs.length + rest.docs.length, 6);
    } finally { await e2.close(); }
  });
  it('concurrent pushes from two devices never make the feed skip a document', async () => {
    const e2 = await createTestEnv(); try {
      const a = await e2.register(); const d1 = await device(e2, a, 'one'); const d2 = await device(e2, a, 'two');
      const batch = (d: typeof d1, tag: string) => push(e2, d, Array.from({ length: 10 }, (_, i) => setting(`apps.override.${tag}${i}.exe`, 'Games')));
      await Promise.all([batch(d1, 'a'), batch(d2, 'b'), batch(d1, 'c'), batch(d2, 'd')]);
      const keys = new Set<string>(); let since = 0;
      for (;;) { const r = (await feed(e2, d1, `scope=account&since=${since}&limit=7`)).json; r.docs.forEach((x: any) => keys.add(x.key)); since = r.cursor; if (!r.hasMore) break; }
      assert.equal(keys.size, 40);
    } finally { await e2.close(); }
  });
});

describe('sync: replacing a computer (claim) and restore feed', () => {
  let env: TestEnv; let acc: Acc; let old: Awaited<ReturnType<typeof device>>;
  before(async () => { env = await createTestEnv(); acc = await env.register(); old = await device(env, acc, 'Old PC'); await push(env, old, [dev('day', dayKey(1), dayDoc(dayKey(1), 5000)), dev('plant', 'ledger', { baseMs: 100, days: { [dayKey(1)]: 5000 } })]); });
  after(async () => { await env.close(); });

  it('a new computer claims the device: epoch rises, data stays, the old computer is refused', async () => {
    const newClient = randomUUID();
    const r = await env.call('POST', '/v1/sync/devices/claim', { token: acc.tokens.accessToken, body: { deviceId: old.id, clientDeviceId: newClient, name: 'New PC', platform: 'win32' } });
    assert.equal(r.status, 200); assert.equal(r.json.takenOver, true); assert.equal(r.json.device.epoch, old.epoch + 1); assert.equal(r.json.device.id, old.id); assert.equal(r.json.device.name, 'New PC');
    const stale = await push(env, old, [setting('ui.name', 'ghost')]);
    assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'device_superseded');
    const fresh = { ...old, epoch: r.json.device.epoch };
    assert.equal((await push(env, fresh, [setting('ui.name', 'back')])).status, 200);
    const docs = (await feed(env, fresh, `scope=device&target=${old.id}&since=0`)).json.docs;
    assert.deepEqual(docs.map((x: any) => x.kind).sort(), ['day', 'plant']);
    const again = await env.call('POST', '/v1/sync/devices/claim', { token: acc.tokens.accessToken, body: { deviceId: old.id, clientDeviceId: newClient, name: 'New PC' } });
    assert.equal(again.json.takenOver, false); assert.equal(again.json.device.epoch, fresh.epoch);
  });
  it('the stale epoch also blocks the old computer from pulling', async () => {
    const r = await env.call('GET', `/v1/sync/changes?deviceId=${old.id}&epoch=${old.epoch}&scope=account&since=0`, { token: acc.tokens.accessToken });
    assert.equal(r.status, 409);
  });
  it('an empty registration of the new computer is replaced; one with data of its own is not', async () => {
    const acc2 = await env.register(); const oldD = await device(env, acc2, 'old');
    const cid = randomUUID();
    await env.call('POST', '/v1/sync/devices/register', { token: acc2.tokens.accessToken, body: { clientDeviceId: cid, name: 'already registered, empty' } });
    const ok = await env.call('POST', '/v1/sync/devices/claim', { token: acc2.tokens.accessToken, body: { deviceId: oldD.id, clientDeviceId: cid, name: 'x' } });
    assert.equal(ok.status, 200);
    assert.equal((await env.call('GET', '/v1/sync/devices', { token: acc2.tokens.accessToken })).json.devices.length, 1);
    const acc3 = await env.register(); const oldE = await device(env, acc3, 'old'); const withData = await device(env, acc3, 'has data');
    await push(env, withData, [dev('day', dayKey(), dayDoc(dayKey()))]);
    const clash = await env.call('POST', '/v1/sync/devices/claim', { token: acc3.tokens.accessToken, body: { deviceId: oldE.id, clientDeviceId: withData.clientDeviceId, name: 'x' } });
    assert.equal(clash.status, 409); assert.equal(clash.json.error.code, 'device_already_registered');
  });
  it('cannot claim a device of another account', async () => {
    const other = await env.register();
    const r = await env.call('POST', '/v1/sync/devices/claim', { token: other.tokens.accessToken, body: { deviceId: old.id, clientDeviceId: randomUUID(), name: 'thief' } });
    assert.equal(r.status, 404);
  });
});

describe('sync: account isolation and quota', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ SYNC_USER_QUOTA_MB: '1' }); });
  after(async () => { await env.close(); });

  it('one account never sees or changes another account\'s documents, even with identical kinds and keys', async () => {
    const a = await env.register(); const b = await env.register();
    const da = await device(env, a); const db = await device(env, b);
    await push(env, da, [setting('ui.name', 'Alice'), dev('day', dayKey(), dayDoc(dayKey(), 111))]);
    await push(env, db, [setting('ui.name', 'Bob'), dev('day', dayKey(), dayDoc(dayKey(), 222))]);
    const fa = (await feed(env, da, 'scope=account&since=0')).json.docs; const fb = (await feed(env, db, 'scope=account&since=0')).json.docs;
    assert.deepEqual(fa.map((x: any) => x.data), ['Alice']); assert.deepEqual(fb.map((x: any) => x.data), ['Bob']);
    assert.equal((await feed(env, db, `scope=device&target=${da.id}&since=0`)).status, 404);
    assert.equal((await env.call('GET', `/v1/sync/changes?deviceId=${da.id}&scope=account&since=0`, { token: b.tokens.accessToken })).status, 404, 'B cannot use A\'s device id');
    assert.equal((await env.call('GET', `/v1/sync/status?deviceId=${da.id}`, { token: b.tokens.accessToken })).status, 404);
    assert.equal((await env.call('GET', '/v1/sync/devices', { token: b.tokens.accessToken })).json.devices.length, 1);
  });
  it('a document cannot be read through an ended session', async () => {
    const a = await env.register(); const d = await device(env, a);
    await env.call('POST', '/v1/auth/logout', { token: a.tokens.accessToken, body: {} });
    assert.equal((await push(env, d, [])).status, 401); assert.equal((await feed(env, d, 'scope=account&since=0')).status, 401);
  });
  it('the per-account storage quota stops uploads with a clear per-document reason, and smaller updates still work', async () => {
    const a = await env.register(); const d = await device(env, a);
    const outcomes: string[] = []; let reason = '';
    for (let i = 0; i < 4; i += 1) {
      const r = await push(env, d, [dev('rollup', `2026-0${i + 1}`, { version: 1, pad: `${i}`.repeat(300_000) })]);
      outcomes.push(r.json.results[0].outcome); if (r.json.results[0].outcome === 'rejected') reason = r.json.results[0].reason;
    }
    assert.deepEqual(outcomes, ['applied', 'applied', 'applied', 'rejected']); assert.match(reason, /quota/);
    const shrink = await push(env, d, [dev('rollup', '2026-01', { version: 1, pad: 'x' })]);
    assert.equal(shrink.json.results[0].outcome, 'applied');
    const st = (await env.call('GET', `/v1/sync/status?deviceId=${d.id}`, { token: a.tokens.accessToken })).json;
    assert.equal(st.limitBytes, 1024 * 1024); assert.ok(st.usedBytes > 0 && st.usedBytes < st.limitBytes); assert.equal(st.documents, 3);
  });
});
