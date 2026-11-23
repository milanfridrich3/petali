import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createTestEnv, type TestEnv } from './helpers';
import { call, device, errCode, setup } from './family-helpers';

const dayDoc = (key: string, ms: number) => ({ version: 1, dayKey: key, activeMs: ms, sessions: [{ start: 1, end: 2, activeMs: ms }] });
const push = (env: TestEnv, token: string, d: { id: string; epoch: number }, ops: unknown[]) => env.call('POST', '/v1/sync/push', { token, body: { deviceId: d.id, epoch: d.epoch, ops } });
const op = (key: string, ms: number) => ({ kind: 'day', key, scope: 'device', clientUpdatedAt: new Date().toISOString(), data: dayDoc(key, ms) });

describe('family devices', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000' }); });
  after(async () => { await env.close(); });

  it('only the owner links a device; devices of other accounts and unknown ids are "not found"; linking twice is harmless', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!; const dk = await device(env, kid.u, 'Kid PC'); const dp = await device(env, s.owner, 'Parent PC');
    const mine = (await call(env, kid.u, 'GET', '/me/devices')).json.devices; assert.equal(mine.length, 1); assert.equal(mine[0].linked, false);
    assert.equal(errCode(await call(env, s.owner, 'PUT', `/devices/${dk.id}/link`)), 'device_not_found', 'a parent cannot link a child\'s device');
    assert.equal(errCode(await call(env, s.owner, 'PUT', '/devices/123e4567-e89b-42d3-a456-426614174000/link')), 'device_not_found');
    assert.equal((await call(env, kid.u, 'PUT', `/devices/${dk.id}/link`)).json.changed, true);
    assert.equal((await call(env, kid.u, 'PUT', `/devices/${dk.id}/link`)).json.changed, false);
    assert.equal((await call(env, kid.u, 'PUT', `/devices/${dp.id}/link`)).status, 404, 'nor can a child link a parent\'s device');
    assert.equal((await call(env, kid.u, 'GET', '/me/devices')).json.devices[0].linked, true);
    assert.equal((await env.call('GET', '/v1/devices', { token: kid.u.token })).json.devices[0].id, dk.id, 'existing device management is unchanged');
  });

  it('devices that are not linked are invisible to the family, whoever asks', async () => {
    const s = await setup(env, 1); await device(env, s.kids[0]!.u, 'Hidden');
    assert.equal((await call(env, s.owner, 'GET', '/devices')).json.devices.length, 0);
    assert.equal((await call(env, s.owner, 'GET', `/members/${s.kids[0]!.memberId}/devices`)).json.devices.length, 0);
  });

  it('family device list names the owner of every device; details follow the owner\'s consent', async () => {
    const s = await setup(env, 1); const kid = s.kids[0]!; const dk = await device(env, kid.u, 'Kid PC'); const dp = await device(env, s.owner, 'Parent PC');
    await call(env, kid.u, 'PUT', `/devices/${dk.id}/link`); await call(env, s.owner, 'PUT', `/devices/${dp.id}/link`);
    const list = (await call(env, s.owner, 'GET', '/devices')).json.devices as any[]; assert.equal(list.length, 2);
    const k = list.find((d) => d.id === dk.id); const p = list.find((d) => d.id === dp.id);
    assert.equal(k.owner.memberId, kid.memberId); assert.equal(k.owner.petaliId, kid.u.petaliId); assert.equal(k.owner.role, 'child'); assert.equal(k.isMine, false); assert.equal(k.name, 'Kid PC');
    assert.equal(k.detail, null); assert.equal(k.detailHidden, true); assert.equal(k.detailReason, 'not_shared', 'private by default: no status, no last sync');
    assert.equal(p.isMine, true); assert.equal(p.detail.status, 'active'); assert.ok(p.detail.lastSeenAt); assert.equal(p.detail.hardware.cpu, 'Test CPU');
    await call(env, kid.u, 'PUT', '/me/sharing', { deviceInfo: true });
    const k2 = ((await call(env, s.owner, 'GET', '/devices')).json.devices as any[]).find((d) => d.id === dk.id);
    assert.equal(k2.detailHidden, false); assert.equal(k2.detail.status, 'active'); assert.ok(k2.detail.lastSeenAt); assert.equal(k2.detail.platform, 'win32'); assert.equal(k2.detail.appVersion, '1.5.0');
    assert.ok(!JSON.stringify(list).includes('clientDeviceId') && !JSON.stringify(list).includes(kid.u.id), 'no installation id or internal user id');
    await call(env, kid.u, 'PUT', '/me/sharing', { deviceInfo: false });
    assert.equal(((await call(env, s.owner, 'GET', '/devices')).json.devices as any[]).find((d) => d.id === dk.id).detail, null, 'withdrawing consent hides it again at once');
  });

  it('a child sees only their own family devices, unless granted devices.view; member device lists are permission-checked', async () => {
    const s = await setup(env, 2); const [k1, k2] = s.kids as [any, any]; const d1 = await device(env, k1.u, 'One'); const d2 = await device(env, k2.u, 'Two');
    await call(env, k1.u, 'PUT', `/devices/${d1.id}/link`); await call(env, k2.u, 'PUT', `/devices/${d2.id}/link`);
    let l = (await call(env, k1.u, 'GET', '/devices')).json.devices as any[]; assert.deepEqual(l.map((d) => d.id), [d1.id]); assert.equal(l[0].detail.status, 'active', 'own device: full detail');
    assert.equal(errCode(await call(env, k1.u, 'GET', `/members/${k2.memberId}/devices`)), 'permission_denied');
    assert.equal((await call(env, k1.u, 'GET', `/members/${k1.memberId}/devices`)).json.devices.length, 1);
    assert.equal((await call(env, s.owner, 'GET', `/members/${k2.memberId}/devices`)).json.devices.map((d: any) => d.id)[0], d2.id);
    await call(env, s.owner, 'PUT', `/members/${k1.memberId}/permissions`, { grant: ['devices.view'] });
    l = (await call(env, k1.u, 'GET', '/devices')).json.devices; assert.equal(l.length, 2, 'granted: ownership and names visible');
    assert.equal(l.find((d: any) => d.id === d2.id).detail, null, 'but still no details without k2\'s consent (and k1 lacks memberData.view)');
    assert.equal((await call(env, s.owner, 'GET', '/members')).json.members.find((m: any) => m.memberId === k2.memberId).deviceCount, 1);
  });

  it('cross-family device access is impossible', async () => {
    const a = await setup(env, 1); const b = await setup(env, 1); const db = await device(env, b.kids[0]!.u); await call(env, b.kids[0]!.u, 'PUT', `/devices/${db.id}/link`);
    assert.equal((await call(env, a.owner, 'GET', '/devices')).json.devices.length, 0);
    assert.equal(errCode(await call(env, a.owner, 'DELETE', `/devices/${db.id}/link`)), 'device_not_found');
    assert.equal(errCode(await call(env, a.owner, 'POST', `/devices/${db.id}/transfers`, { toMemberId: a.kids[0]!.memberId })), 'device_not_found');
    assert.equal(errCode(await call(env, a.owner, 'GET', `/members/${b.kids[0]!.memberId}/devices`)), 'member_not_found');
    assert.equal((await call(env, b.owner, 'GET', '/devices')).json.devices.length, 1);
  });

  it('unlinking: the owner always can; a parent can hide a child\'s device (nothing is deleted); a co-parent cannot touch a parent\'s', async () => {
    const s = await setup(env, 1, 1); const kid = s.kids[0]!; const co = s.pars[0]!; const dk = await device(env, kid.u, 'K'); const dc = await device(env, co.u, 'C');
    await call(env, kid.u, 'PUT', `/devices/${dk.id}/link`); await call(env, co.u, 'PUT', `/devices/${dc.id}/link`);
    assert.equal(errCode(await call(env, kid.u, 'DELETE', `/devices/${dc.id}/link`)), 'permission_denied');
    assert.equal((await call(env, s.owner, 'DELETE', `/devices/${dc.id}/link`)).status, 200, 'the family owner can');
    await call(env, co.u, 'PUT', `/devices/${dc.id}/link`);
    assert.equal((await call(env, co.u, 'DELETE', `/devices/${dk.id}/link`)).status, 200, 'a parent can hide a child\'s device from the family');
    assert.equal((await env.call('GET', '/v1/devices', { token: kid.u.token })).json.devices.length, 1, 'the device itself is untouched and still the child\'s');
    assert.equal((await call(env, kid.u, 'GET', '/me/devices')).json.devices[0].linked, false);
    await call(env, s.owner, 'PUT', `/devices/${(await device(env, s.owner)).id}/link`);
    const dOwner = ((await call(env, s.owner, 'GET', '/devices')).json.devices as any[]).find((d) => d.owner.memberId === s.ownerMemberId).id;
    assert.equal(errCode(await call(env, co.u, 'DELETE', `/devices/${dOwner}/link`)), 'owner_protected');
  });

  it('removing a device through Device Management removes its family link; removing a member leaves devices and links of the others alone', async () => {
    const s = await setup(env, 2); const [k1, k2] = s.kids as [any, any]; const d1 = await device(env, k1.u, 'One'); const d2 = await device(env, k2.u, 'Two');
    await call(env, k1.u, 'PUT', `/devices/${d1.id}/link`); await call(env, k2.u, 'PUT', `/devices/${d2.id}/link`);
    const rm = await env.call('POST', `/v1/devices/${d1.id}/remove`, { token: k1.u.token, body: { confirm: true, allowCurrent: true } }); assert.equal(rm.status, 200, rm.text);
    assert.deepEqual(((await call(env, s.owner, 'GET', '/devices')).json.devices as any[]).map((d) => d.id), [d2.id]);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM family_devices WHERE device_id = $1', [d1.id])).rows[0].n, 0);
    await call(env, s.owner, 'DELETE', `/members/${k2.memberId}`);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM family_devices')).rows.length, 1);
    assert.equal((await env.pool.query('SELECT revoked_at FROM devices WHERE id = $1', [d2.id])).rows[0].revoked_at, null, 'the removed member\'s device is not revoked');
  });
});

describe('family device ownership transfer', () => {
  let env: TestEnv;
  before(async () => { env = await createTestEnv({ RATE_LIMIT_FAMILY_INVITE_MAX: '100000' }); });
  after(async () => { await env.close(); });

  async function ready() {
    const s = await setup(env, 1, 1); const kid = s.kids[0]!; const d = await device(env, kid.u, 'Laptop'); await call(env, kid.u, 'PUT', `/devices/${d.id}/link`);
    await push(env, kid.u.token, d, [op('2026-02-01', 7000)]);
    return { s, kid, d };
  }

  it('a parent cannot start or force a hand-over of a child\'s device; the child cannot be made to receive silently', async () => {
    const { s, kid, d } = await ready();
    assert.equal(errCode(await call(env, s.owner, 'POST', `/devices/${d.id}/transfers`, { toMemberId: s.ownerMemberId })), 'device_not_found');
    assert.equal((await env.pool.query('SELECT user_id FROM devices WHERE id = $1', [d.id])).rows[0].user_id, kid.u.id);
    const own = await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: s.ownerMemberId }); assert.equal(own.status, 201, own.text);
    assert.equal((await env.pool.query('SELECT user_id FROM devices WHERE id = $1', [d.id])).rows[0].user_id, kid.u.id, 'offering does not move anything');
    assert.equal(errCode(await call(env, kid.u, 'POST', `/transfers/${own.json.transfer.id}/accept`)), 'transfer_not_found', 'the offerer cannot accept their own offer');
    assert.equal(errCode(await call(env, s.pars[0]!.u, 'POST', `/transfers/${own.json.transfer.id}/accept`)), 'transfer_not_found', 'a third member cannot accept');
    assert.equal(errCode(await call(env, s.pars[0]!.u, 'POST', `/transfers/${own.json.transfer.id}/cancel`)), 'transfer_not_found');
    assert.equal(errCode(await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: kid.memberId })), 'cannot_transfer_to_self');
    assert.equal(errCode(await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: s.pars[0]!.memberId })), 'transfer_exists', 'one open hand-over per device');
    assert.equal((await call(env, s.pars[0]!.u, 'GET', '/transfers')).json.transfers.length, 0, 'other members do not even see the offer');
  });

  it('accepting moves the device and its own history to the receiver; the giver\'s sessions on it end; the family link follows', async () => {
    const { s, kid, d } = await ready(); const co = s.pars[0]!;
    await env.pool.query(`INSERT INTO sync_documents (user_id, device_id, kind, doc_key, data, data_hash, size_bytes, client_updated_at) VALUES ($1, NULL, 'settings', 'account', '{}'::jsonb, 'h', 2, now())`, [kid.u.id]);
    const t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).json.transfer;
    assert.equal(t.status, 'pending'); assert.equal((await call(env, co.u, 'GET', '/transfers')).json.transfers[0].device.name, 'Laptop');
    const acc = await call(env, co.u, 'POST', `/transfers/${t.id}/accept`); assert.equal(acc.status, 200, acc.text); assert.equal(acc.json.transfer.status, 'accepted');
    const row = (await env.pool.query('SELECT user_id, epoch, revoked_at FROM devices WHERE id = $1', [d.id])).rows[0];
    assert.equal(row.user_id, co.u.id); assert.equal(row.epoch, d.epoch + 1); assert.equal(row.revoked_at, null);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM sync_documents WHERE device_id = $1 AND user_id = $2', [d.id, co.u.id])).rows[0].n, 1, 'the device\'s own history moved');
    assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM sync_documents WHERE user_id = $1 AND device_id IS NULL`, [kid.u.id])).rows[0].n, 1, 'the giver keeps account-wide data');
    assert.equal((await env.call('GET', '/v1/devices', { token: kid.u.token })).status, 401, 'the giver\'s only sign-in was bound to that computer, so it ended');
    const again = await env.call('POST', '/v1/auth/login', { body: { email: kid.u.email, password: kid.u.password } });
    assert.equal((await env.call('GET', '/v1/devices', { token: again.json.tokens.accessToken })).json.devices.length, 0, 'gone from the giver\'s account');
    assert.deepEqual((await env.call('GET', '/v1/devices', { token: co.u.token })).json.devices.map((x: any) => x.id), [d.id]);
    assert.equal((await push(env, again.json.tokens.accessToken, d, [op('2026-02-02', 1)])).status, 404, 'the old owner can no longer sync it');
    const fd = ((await call(env, s.owner, 'GET', '/devices')).json.devices as any[]).find((x) => x.id === d.id); assert.equal(fd.owner.memberId, co.memberId);
    assert.equal((await call(env, { token: again.json.tokens.accessToken }, 'GET', '/me/devices')).json.devices.length, 0);
    assert.ok((await call(env, s.owner, 'GET', '/audit?limit=100')).json.events.some((e: any) => e.action === 'device_transferred'));
    assert.equal(errCode(await call(env, co.u, 'POST', `/transfers/${t.id}/accept`)), 'transfer_already_used', 'single use');
  });

  it('the previous owner\'s sign-ins bound to that computer end', async () => {
    const { s, kid, d } = await ready();
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL', [kid.u.id, d.id])).rows[0].n, 1);
    const t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: s.ownerMemberId })).json.transfer; await call(env, s.owner, 'POST', `/transfers/${t.id}/accept`);
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL', [kid.u.id, d.id])).rows[0].n, 0);
    assert.equal((await env.call('GET', '/v1/account', { token: kid.u.token })).status, 401, 'that session is over');
  });

  it('decline, cancel and expiry leave everything as it was', async () => {
    const { s, kid, d } = await ready(); const co = s.pars[0]!;
    let t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).json.transfer;
    assert.equal((await call(env, co.u, 'POST', `/transfers/${t.id}/decline`)).json.transfer.status, 'declined');
    assert.equal(errCode(await call(env, co.u, 'POST', `/transfers/${t.id}/accept`)), 'transfer_declined');
    t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).json.transfer;
    assert.equal((await call(env, kid.u, 'POST', `/transfers/${t.id}/cancel`)).json.transfer.status, 'cancelled');
    assert.equal((await call(env, co.u, 'POST', `/transfers/${t.id}/accept`)).status, 410);
    t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).json.transfer;
    await env.pool.query(`UPDATE family_device_transfers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    const late = await call(env, co.u, 'POST', `/transfers/${t.id}/accept`); assert.equal(late.status, 410); assert.equal(errCode(late), 'transfer_expired');
    assert.equal((await env.pool.query('SELECT user_id FROM devices WHERE id = $1', [d.id])).rows[0].user_id, kid.u.id);
    assert.equal((await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).status, 201, 'a new offer is possible afterwards');
  });

  it('an offer dies with its preconditions: device removed, unlinked or the receiver removed from the family', async () => {
    let r = await ready(); let t = (await call(env, r.kid.u, 'POST', `/devices/${r.d.id}/transfers`, { toMemberId: r.s.ownerMemberId })).json.transfer;
    await call(env, r.kid.u, 'DELETE', `/devices/${r.d.id}/link`);
    assert.equal((await call(env, r.s.owner, 'POST', `/transfers/${t.id}/accept`)).status, 410, 'unlinking cancels the offer');
    r = await ready(); t = (await call(env, r.kid.u, 'POST', `/devices/${r.d.id}/transfers`, { toMemberId: r.s.ownerMemberId })).json.transfer;
    await call(env, r.s.owner, 'DELETE', `/members/${r.kid.memberId}`);
    assert.equal((await env.pool.query('SELECT user_id FROM devices WHERE id = $1', [r.d.id])).rows[0].user_id, r.kid.u.id);
    assert.equal(errCode(await call(env, r.s.owner, 'POST', `/transfers/${t.id}/accept`)), 'transfer_not_found');
    r = await ready(); t = (await call(env, r.kid.u, 'POST', `/devices/${r.d.id}/transfers`, { toMemberId: r.s.ownerMemberId })).json.transfer;
    await env.call('POST', `/v1/devices/${r.d.id}/remove`, { token: r.kid.u.token, body: { confirm: true, allowCurrent: true } });
    assert.equal((await call(env, r.s.owner, 'POST', `/transfers/${t.id}/accept`)).status, 410, 'a removed device cannot be handed over');
  });

  it('a receiver at the device limit, or one that already has a record of that computer, cannot accept', async () => {
    const { s, kid, d } = await ready(); const co = s.pars[0]!;
    for (let i = 0; i < 20; i += 1) await device(env, co.u, `Fill ${i}`);
    const t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).json.transfer;
    assert.equal(errCode(await call(env, co.u, 'POST', `/transfers/${t.id}/accept`)), 'device_limit');
    assert.equal((await env.pool.query('SELECT user_id FROM devices WHERE id = $1', [d.id])).rows[0].user_id, kid.u.id, 'a refused accept changes nothing');
    const x = await ready(); const cid = (await env.pool.query('SELECT client_device_id FROM devices WHERE id = $1', [x.d.id])).rows[0].client_device_id;
    await env.pool.query(`INSERT INTO devices (user_id, name, client_device_id, revoked_at) VALUES ($1,'old',$2, now())`, [x.s.pars[0]!.u.id, cid]);
    const t2 = (await call(env, x.kid.u, 'POST', `/devices/${x.d.id}/transfers`, { toMemberId: x.s.pars[0]!.memberId })).json.transfer;
    assert.equal(errCode(await call(env, x.s.pars[0]!.u, 'POST', `/transfers/${t2.id}/accept`)), 'transfer_conflict');
  });

  it('two parallel accepts move the device exactly once', async () => {
    const { s, kid, d } = await ready(); const co = s.pars[0]!;
    const t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).json.transfer;
    const rs = await Promise.all([1, 2, 3].map(() => call(env, co.u, 'POST', `/transfers/${t.id}/accept`)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.ok(rs.every((r) => r.status < 500));
    assert.equal((await env.pool.query('SELECT epoch FROM devices WHERE id = $1', [d.id])).rows[0].epoch, d.epoch + 1);
  });

  it('after the hand-over the receiver\'s own computer can use the moved device (sync works for the new owner)', async () => {
    const { s, kid, d } = await ready(); const co = s.pars[0]!;
    const t = (await call(env, kid.u, 'POST', `/devices/${d.id}/transfers`, { toMemberId: co.memberId })).json.transfer; await call(env, co.u, 'POST', `/transfers/${t.id}/accept`);
    const reg = await env.call('POST', '/v1/sync/devices/register', { token: co.u.token, body: { clientDeviceId: d.clientDeviceId, name: 'Laptop', platform: 'win32' } });
    assert.equal(reg.status, 200, reg.text); assert.equal(reg.json.device.id, d.id); assert.equal(reg.json.created, false);
    const p = await push(env, co.u.token, { id: d.id, epoch: reg.json.device.epoch }, [op('2026-02-03', 9)]); assert.equal(p.status, 200, p.text);
    const sum = await env.call('GET', `/v1/devices/${d.id}/summary?days=365`, { token: co.u.token }); assert.equal(sum.json.summary.usage.activeMs, 7009, 'history moved with it, new data added');
    const relog = await env.call('POST', '/v1/auth/login', { body: { email: kid.u.email, password: kid.u.password } });
    const back = await env.call('POST', '/v1/sync/devices/register', { token: relog.json.tokens.accessToken, body: { clientDeviceId: d.clientDeviceId, name: 'x' } });
    assert.equal(errCode(back), 'device_in_use_by_another_account', 'the previous owner cannot re-register it silently');
  });
});
