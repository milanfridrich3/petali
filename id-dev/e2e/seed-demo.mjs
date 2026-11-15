import { randomUUID } from 'node:crypto';
const B = 'http://127.0.0.1:8788'; const H = 3600000; const NOW = Date.now(); const iso = (m = NOW) => new Date(m).toISOString(); const dk = (n) => new Date(NOW - n * 864e5).toISOString().slice(0, 10);
const call = async (m, p, body, token, extra = {}) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
const reg = await call('POST', '/v1/web/session/register', { email: 'demo@example.com', password: 'Correct-horse-battery-9', displayName: 'Demo User' }, null, { origin: 'http://localhost:8899', 'x-petali-web': '1' });
if (reg.s !== 201) { console.log('register', reg.s, JSON.stringify(reg.j)); process.exit(1); }
const tok = reg.j.accessToken;
async function dev(name) { const r = await call('POST', '/v1/sync/devices/register', { clientDeviceId: randomUUID(), name, platform: 'win32', appVersion: '1.4.0', hardware: { cpu: 'Intel Core i5-1235U', threads: 12, ramGb: 16, os: '10.0.22631', arch: 'x64' } }, tok); return { id: r.j.device.id, epoch: r.j.device.epoch }; }
const push = async (d, ops) => { const r = await call('POST', '/v1/sync/push', { deviceId: d.id, epoch: d.epoch, ops }, tok); const bad = (r.j.results || []).filter((x) => !['applied', 'unchanged'].includes(x.outcome)); if (bad.length) console.log('push issues', JSON.stringify(bad)); };
const doc = (kind, key, data, scope = 'device') => ({ kind, key, scope, clientUpdatedAt: iso(), data });
const a = await dev('Desk PC'); const b = await dev('Laptop');
const ops = [];
for (let i = 0; i < 14; i++) { const k = dk(i); const ms = (i % 5 === 3 ? 0 : (2 + (i % 4)) * H); if (ms) ops.push(doc('day', k, { version: 1, dayKey: k, activeMs: ms, sessions: [{ start: 1, end: 2, activeMs: ms / 2 }, { start: 3, end: 4, activeMs: ms / 2 }] })); }
for (let i = 0; i < 7; i++) { const k = dk(i); ops.push(doc('apps', k, { version: 1, dayKey: k, apps: { 'chrome.exe': 2 * H, 'Code.exe': H, 'Discord.exe': 0.5 * H, 'steam.exe': 0.7 * H }, unknownMs: 0.2 * H, hourly: [] })); }
ops.push(doc('plant', 'ledger', { baseMs: 3 * H, days: Object.fromEntries([1, 2, 3, 4].map((i) => [dk(i), 3 * H])) }));
const month = dk(1).slice(0, 7); const days = {};
for (let i = 1; i < 6; i++) { const k = dk(i); if (k.slice(0, 7) !== month) continue; const t = Date.parse(`${k}T10:00:00Z`); const bk = (cpu, temp) => ({ t, n: 60, cpu: [cpu, cpu + 25], temp: [temp, temp + 8], ram: [48, 60], hsm: [50, 8, 2] }); days[k] = { hw: { ...bk(30 + i, 55 + i), t: Date.parse(`${k}T00:00:00Z`), minutes: 240 }, hourly: [bk(30 + i, 55 + i)] }; }
ops.push(doc('rollup', month, { version: 1, month, days }));
const t0 = Date.parse(`${dk(1)}T10:00:00Z`);
ops.push(doc('health', month, { lines: [{ k: 'start', id: 'cpuOverheat', t: t0 + 6e5, sev: 'warning', v: [{ key: 'temp', value: 91, unit: '°C' }, { key: 'limit', value: 85, unit: '°C' }] }, { k: 'sev', id: 'cpuOverheat', t: t0 + 9e5, sev: 'critical' }, { k: 'end', id: 'cpuOverheat', t: t0 + 24e5 }, { k: 'start', id: 'ramHigh', t: t0 + 3e6, sev: 'warning', v: [{ key: 'percent', value: 91, unit: '%' }] }, { k: 'end', id: 'ramHigh', t: t0 + 36e5 }] }));
ops.push(doc('setting', 'ui.plant', 'fern', 'account'), doc('setting', 'ui.name', 'Fernando', 'account'));
await push(a, ops);
await push(b, [doc('day', dk(1), { version: 1, dayKey: dk(1), activeMs: 1.5 * H, sessions: [{ start: 1, end: 2, activeMs: 1.5 * H }] }), doc('plant', 'ledger', { baseMs: 0, days: { [dk(1)]: 1 * H } })]);
console.log('seeded', a.id, b.id);
