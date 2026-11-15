// Dashboard, Computers, Computer details, Plant.
import { h, svg, card, stat, empty, pill, barChart, clear, problemBox, icon } from './ui.js';
import { resourceView, deviceView, problemText } from './view-kit.js';
import { duration, minutesToDuration, dayLabel, ago, dateTime, num, DASH, STATUS_TEXT, STAGE_TEXT, isNum } from './format.js';
import { BASE } from './router.js';
import { ApiError } from './api.js';

const statusKind = { active: 'good', offline: 'neutral', stale: 'warn', never: 'neutral', removed: 'bad' };
export const statusPill = (s) => pill(STATUS_TEXT[s] || s, statusKind[s] || 'neutral');
// A computer that registered but has never uploaded anything is not "syncing now": say what is true.
export const shownStatus = (x) => (x && x.status === 'active' && !x.lastSyncAt ? 'never' : x && x.status);

// ---- plant artwork: the desktop's own species drawings, grown by stage exactly like the desktop (scale per stage) ----
const SPECIES_FALLBACK = 'sprout';
export function plantArt(species, stage, size = 'lg') {
  const sp = globalThis.PetaliSpecies; const vis = globalThis.PetaliPlantVisuals;
  const kind = sp && sp.plants[species] ? species : SPECIES_FALLBACK;
  const parts = vis.splitSpecies(sp.plantSVG(kind));
  const st = ['seed', 'sprout', 'young', 'mature'].includes(stage) ? stage : 'mature';
  return svg(`<svg viewBox="0 0 240 270" role="img" aria-label="${(sp.plants[kind].label.en)} - ${STAGE_TEXT[st]}"><g class="pl-pose"><g class="pl-grow"><g>${parts.body}</g></g><g class="pl-seed">${vis.SEED}</g></g><g>${parts.pot}</g></svg>`, `plant-art plant-${size} st-${st}`);
}
const speciesName = (id) => { const p = globalThis.PetaliSpecies && globalThis.PetaliSpecies.plants[id]; return p ? p.en : null; };

const hwLine = (hw) => (hw && typeof hw === 'object' ? [hw.cpu, isNum(hw.ramGb) ? `${hw.ramGb} GB RAM` : null, hw.os ? `Windows ${hw.os}` : null].filter(Boolean).join(' · ') : '');

// ---- dashboard ----
const alertText = (a) => ({ device_stale: `${a.deviceName || 'A computer'} has not synchronised for over 3 days.`, device_never_synced: `${a.deviceName || 'A computer'} has never synchronised yet.`, critical_problems_30d: 'Critical Device Health problems were recorded in the last 30 days.' }[a.code] || 'Attention needed.');

// The desktop's home: the plant in the sky scene, then widget tiles. `o` is an overview (or plant) response.
function plantHero(o, { big = false } = {}) {
  const p = o.plant; const id = o.identity || {};
  const words = p ? STAGE_TEXT[p.stage].split(' ') : ['No', 'growth', 'yet'];
  const title = words.length === 2 ? h('h1', {}, `${words[0]} `, h('em', { text: words[1] })) : h('h1', { text: words.join(' ') });
  return h('section', { class: 'hero' }, h('i', { class: 'orb', 'aria-hidden': 'true' }),
    h('div', { class: 'eyebrow', text: [id.name, big ? speciesName(id.species) : null].filter(Boolean).join(' · ') || 'Your plant' }), title,
    h('div', { class: 'plant-stage' }, p ? plantArt(id.species, p.stage, 'lg') : null),
    p ? h('div', { class: 'plant-growth' }, h('span', { class: 'pg-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(p.progress * 100) }, h('b', { style: { width: `${Math.round(p.progress * 100)}%` } })),
      h('span', { text: p.nextStage ? `${Math.round(p.progress * 100)} % to ${STAGE_TEXT[p.nextStage.id]} · ${minutesToDuration(p.nextStage.remainingMinutes)} to go` : 'Fully grown' })) : h('p', { class: 'muted small', text: 'A computer has not reported its plant yet.' }));
}

export function dashboardView(ctx) {
  return resourceView(ctx, {
    title: 'Dashboard', hideTitle: true, key: 'overview', path: '/v1/web/overview', syncedAt: (o) => o.lastSyncAt,
    render: (o) => {
      const out = [];
      if (o.devices.total === 0) {
        out.push(empty('Connect your first computer', 'Install Petali on your Windows PC, open the Account section and sign in with this Petali ID. Your plant and history will show up here.', h('a', { class: 'btn btn-primary', href: '/#download', text: 'Download Petali' })));
        return out;
      }
      out.push(h('a', { class: 'hero-link', href: `${BASE}/plant`, 'aria-label': 'Open the plant' }, plantHero(o)));
      const hz = o.health;
      out.push(h('div', { class: 'grid stats' },
        stat('PC Usage', o.usage.available ? duration(o.usage.last7Days.activeMs) : DASH, o.usage.available ? `Active Work · 7 days (${o.usage.last7Days.days} recorded)` : 'no data yet'),
        stat('Computers', `${o.devices.active} of ${o.devices.total} syncing`, o.devices.removed ? `${o.devices.removed} removed` : (o.devices.stale ? `${o.devices.stale} not synced recently` : 'all up to date')),
        stat('Device Health', hz.recorded ? `${hz.episodes30d} problem${hz.episodes30d === 1 ? '' : 's'}` : DASH, hz.recorded ? (hz.critical30d ? `${hz.critical30d} critical · 30 days` : 'none critical · 30 days') : 'not recorded yet', { tone: hz.recorded ? (hz.critical30d ? 'crit' : hz.episodes30d ? 'warn' : null) : null }),
        stat('Last synchronised', o.lastSyncAt ? ago(o.lastSyncAt) : 'never', o.lastSyncAt ? dateTime(o.lastSyncAt) : null)));
      const left = []; const right = [];
      const days = o.usage.daily.slice(-14);
      left.push(card({ icon: 'pcUsage', text: 'Active Work · last 14 days' }, o.usage.available ? barChart(days.map((d) => ({ label: dayLabel(d.day), short: d.day.slice(8), value: d.activeMs / 3600000 })), { unitLabel: (v) => `${v.toFixed(1)} h`, ariaLabel: 'Active Work per day, hours' }) : h('p', { class: 'muted', text: 'No usage has been synchronised yet.' }), h('p', { class: 'muted small', text: 'Days without a synchronised record are left out, not shown as zero.' })));
      left.push(card({ icon: 'computerStatus', text: 'Computers' }, h('ul', { class: 'list rows' }, o.devices.list.map((d) => h('li', {}, h('a', { href: `${BASE}/computers/${d.id}`, class: 'row' }, h('div', {}, h('strong', { text: d.name }), h('div', { class: 'muted small', text: d.lastSyncAt ? `Synchronised ${ago(d.lastSyncAt)}` : 'Never synchronised' })), statusPill(d.status)))))));
      if (o.alerts.length) right.push(card({ icon: 'deviceHealth', text: 'Needs attention' }, h('ul', { class: 'list' }, o.alerts.map((a) => problemBox({ level: a.severity === 'warning' ? 'warning' : 'info', title: alertText(a), level_text: a.severity === 'warning' ? 'Attention' : 'Info' })))));
      right.push(installCard(ctx));
      out.push(h('div', { class: 'dash-cols' }, h('div', {}, o.alerts.length ? right.shift() : null, ...left), h('div', {}, ...right)));
      return out;
    },
  });
}

export function installCard(ctx) {
  const info = ctx.installInfo; if (info.isStandalone()) return h('span');
  const box = h('section', { class: 'card install' });
  const paint = () => { clear(box).append(h('h2', { class: 'card-title' }, icon('activeApps'), 'Install Petali ID'), h('p', { class: 'muted', text: 'Optional. Petali ID works fully in the browser; installing adds a home-screen icon and a standalone window.' }),
    info.canPrompt() ? h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => { await info.prompt(); paint(); } }, 'Install') : h('p', { class: 'small', text: info.isIos() ? 'On iPhone or iPad: open this page in Safari, tap Share, then "Add to Home Screen".' : 'In your browser menu choose "Install app" or "Add to Home screen". (Some browsers do not offer installation.)' })); };
  paint(); info.onChange(paint); return box;
}

// ---- computers ----
// Petali ID is the place to manage the computers of an account. The desktop app opens this page with ?current=<computer id> so the computer you came
// from is marked "This computer". That is a display hint only (kept for this account in this browser); the server never relies on it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUR_KEY = 'currentDevice';
export async function rememberCurrentComputer(ctx, search) {
  const raw = search && search.get ? search.get('current') : null; const u = ctx.session.userId();
  if (raw && UUID_RE.test(raw) && u) await ctx.cache.setMeta(CUR_KEY, { petaliId: u, id: raw.toLowerCase() });
}
export async function currentComputerId(ctx) { const m = await ctx.cache.getMeta(CUR_KEY); return m && m.petaliId === ctx.session.userId() ? m.id : null; }
const chevron = () => { const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('aria-hidden', 'true'); e.setAttribute('class', 'chev'); e.innerHTML = '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'; return e; };

export function computersView(ctx, { search } = {}) {
  let cur = null;
  const ready = rememberCurrentComputer(ctx, search).then(() => currentComputerId(ctx)).then((id) => { cur = id; }, () => {});
  return resourceView(ctx, {
    ready,
    title: 'Computers', key: 'devices-all', path: '/v1/devices?includeRemoved=true', source: 'cloud-snapshot',
    render: (d, st, w) => {
      const live = d.devices.filter((x) => !x.removed); const gone = d.devices.filter((x) => x.removed);
      const row = (x) => h('li', {}, h('a', { href: `${BASE}/computers/${x.id}`, class: 'row row-computer', 'aria-label': `${x.name}${cur === x.id ? ' (this computer)' : ''}, open details` },
        h('span', { class: 'row-ico', 'aria-hidden': 'true' }, icon('computerStatus')),
        h('div', { class: 'row-main' }, h('div', { class: 'row-name' }, h('strong', { text: x.name }), cur === x.id ? h('span', { class: 'pill pill-this', text: 'This computer' }) : null), h('div', { class: 'muted small', text: hwLine(x.hardware) || x.platform || '' }), h('div', { class: 'muted small', text: x.lastSyncAt ? `Last synchronised ${ago(x.lastSyncAt)}` : 'Never synchronised' })),
        h('div', { class: 'row-end' }, statusPill(shownStatus(x)), chevron())));
      const out = [];
      if (!live.length) out.push(empty('No computers connected', 'Install Petali on a Windows PC and sign in with this Petali ID. It appears here after its first synchronisation.', h('a', { class: 'btn', href: '/#download', text: 'Download Petali' })));
      else {
        const syncing = live.filter((x) => x.status === 'syncing' || x.status === 'online').length;
        out.push(h('p', { class: 'list-summary muted', text: `${live.length} computer${live.length === 1 ? '' : 's'}${syncing ? ` · ${syncing} synchronising now` : ''}` }));
        out.push(h('ul', { class: 'list rows card' }, [...live].sort((a, b) => (cur === b.id) - (cur === a.id)).map(row)));
      }
      if (gone.length) out.push(card({ icon: 'computerStatus', text: 'Removed computers' }, h('ul', { class: 'list rows' }, gone.map(row)), h('p', { class: 'muted small', text: 'Removed computers no longer synchronise. Their plant growth stays in your account.' })));
      out.push(h('p', { class: 'muted small', text: 'Open a computer to rename it or remove it from your account. New computers are added from the Petali desktop app by signing in with this Petali ID.' }));
      return out;
    },
  });
}

const HW_LABELS = { cpu: 'Processor', threads: 'Threads', ramGb: 'Memory', os: 'Windows build', arch: 'Architecture' };
const hwValue = (k, v) => (k === 'ramGb' ? `${v} GB` : String(v));

export function computerView(ctx, { route }) {
  const id = route.params.deviceId;
  const el = h('div', { class: 'view' }); const holder = h('div'); el.append(h('a', { class: 'back', href: `${BASE}/computers`, text: '← Computers' }), holder);
  const mine = { key: `device:${id}`, path: `/v1/devices/${id}` };
  const sum = { key: `summary:${id}:30`, path: `/v1/devices/${id}/summary?days=30` };
  let dev = null; let sm = null; let devSt = null; let smSt = null; let curId = null;
  currentComputerId(ctx).then((x) => { curId = x; if (dev) paint(); }, () => {});
  const flash = h('p', { class: 'banner', hidden: true, role: 'status' });
  const online = () => ctx.onlineNow() && ctx.session.state().status === 'authenticated';
  const paint = () => {
    clear(holder);
    if (!dev) { if (devSt && devSt.error) holder.append(card(null, h('p', { text: problemText(devSt.error) }), h('a', { class: 'btn', href: `${BASE}/computers`, text: 'Back to computers' }))); else holder.append(h('div', { class: 'skeleton' }, h('i'), h('i'), h('i'))); return; }
    const d = dev.device; const s = sm;
    holder.append(h('div', { class: 'title-row' }, h('h1', { text: d.name }), statusPill(shownStatus(d)), curId === d.id ? h('span', { class: 'pill pill-this', text: 'This computer' }) : null), flash);
    if (devSt && devSt.cached) holder.append(h('p', { class: 'prov prov-cached' }, h('strong', { text: 'Saved copy' }), ` from ${dateTime(devSt.savedAt)} - not live`));
    else holder.append(h('p', { class: 'prov' }, h('strong', { text: 'Cloud snapshot' }), d.lastSyncAt ? ` · last synchronised ${ago(d.lastSyncAt)} (${dateTime(d.lastSyncAt)})` : ' · this computer has never synchronised'));
    if (d.status === 'removed') holder.append(h('p', { class: 'banner banner-warn', text: `Removed from your account ${d.removedAt ? dateTime(d.removedAt) : ''}. It no longer synchronises.${d.historyDeleted ? ' Its cloud history was deleted.' : ''}` }));
    const hw = d.hardware && typeof d.hardware === 'object' ? Object.entries(d.hardware).filter(([k, v]) => HW_LABELS[k] && (typeof v === 'string' || typeof v === 'number')) : [];
    holder.append(card({ icon: 'cpu', text: 'Hardware' }, hw.length ? h('dl', { class: 'kv' }, hw.flatMap(([k, v]) => [h('dt', { text: HW_LABELS[k] }), h('dd', { text: hwValue(k, v) })])) : h('p', { class: 'muted', text: 'This computer has not reported hardware details.' })));
    holder.append(card({ icon: 'storage', text: 'Cloud history' }, h('dl', { class: 'kv' }, h('dt', { text: 'Petali version' }), h('dd', { text: d.appVersion || DASH }), h('dt', { text: 'Added' }), h('dd', { text: dateTime(d.createdAt) }), h('dt', { text: 'Last seen' }), h('dd', { text: d.lastSeenAt ? dateTime(d.lastSeenAt) : DASH }), h('dt', { text: 'Days of usage in the cloud' }), h('dd', { text: String((d.docCounts && d.docCounts.day) || 0) }), h('dt', { text: 'Cloud storage used' }), h('dd', { text: `${((dev.device.storageBytes || 0) / 1024).toFixed(0)} KB` }))));
    if (s) holder.append(card({ icon: 'pcUsage', text: 'Last 30 days' }, h('div', { class: 'grid stats' }, stat('PC Usage · Active Work', s.usage.activeDays ? duration(s.usage.activeMs) : DASH, `${s.usage.activeDays} active day${s.usage.activeDays === 1 ? '' : 's'}`), stat('Device Health problems', s.health.episodes ? String(s.health.episodes) : (s.performance.months.length || s.health.months.length ? '0' : DASH), 'recorded episodes')),
      s.coverage.firstDay ? h('p', { class: 'muted small', text: `History starts ${s.coverage.firstDay}.` }) : null));
    else if (smSt && smSt.error) holder.append(card({ icon: 'pcUsage', text: 'Last 30 days' }, h('p', { class: 'muted', text: 'Summary unavailable right now.' })));
    holder.append(h('div', { class: 'btn-row' }, ...[['usage', 'Usage'], ['health', 'Device Health'], ['reports', 'Reports']].map(([p, l]) => h('a', { class: 'btn', href: `${BASE}/${p}`, onclick: () => ctx.cache.setMeta('selectedDevice', { petaliId: ctx.session.userId(), id }), text: l }))));
    holder.append(manage(d));
  };
  const manage = (d) => {
    const name = h('input', { id: 'rename', type: 'text', maxlength: 80, value: d.name, autocomplete: 'off', 'aria-label': 'Computer name' });
    const save = h('button', { class: 'btn', type: 'button', onclick: async () => {
      const v = name.value.replace(/\s+/g, ' ').trim(); if (!v || v === d.name) return;
      save.disabled = true;
      try { await ctx.api.patch(`/v1/devices/${id}`, { name: v }); await Promise.all([ctx.cache.del(ctx.session.userId(), mine.key), ctx.cache.del(ctx.session.userId(), 'devices'), ctx.cache.del(ctx.session.userId(), 'devices-all'), ctx.cache.del(ctx.session.userId(), 'overview')]); say('Name saved.'); w1.reload(); }
      catch (e) { say(e instanceof ApiError ? e.message : 'Could not save.', true); } finally { save.disabled = false; }
    } }, 'Save name');
    const del = h('input', { type: 'checkbox', id: 'delhist' });
    const confirmBox = h('div', { class: 'danger', hidden: true, role: 'alertdialog', 'aria-label': 'Confirm removal' }, curId === d.id ? h('p', { class: 'banner banner-warn', text: 'This is the computer you opened Petali ID from. Removing it signs Petali out on that computer.' }) : null, h('p', { text: `Remove ${d.name} from your account? It stops synchronising and is signed out. The computer's own files are not touched, and your plant keeps its growth.` }),
      h('label', { class: 'check' }, del, ' Also delete this computer\'s synchronised history from the cloud'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-danger', type: 'button', onclick: async (ev) => {
        ev.target.disabled = true;
        try { await ctx.api.post(`/v1/devices/${id}/remove`, { confirm: true, ...(del.checked ? { deleteCloudHistory: true } : {}) }); const u = ctx.session.userId(); await Promise.all(['devices', 'devices-all', 'overview', mine.key, sum.key].map((k) => ctx.cache.del(u, k))); ctx.navigate(`${BASE}/computers`); }
        catch (e) { ev.target.disabled = false; say(e instanceof ApiError ? (e.code === 'cannot_remove_current_device' ? 'This is the computer in use. Remove it from the Petali desktop app instead.' : e.message) : 'Could not remove.', true); }
      } }, 'Remove computer'), h('button', { class: 'btn', type: 'button', onclick: () => { confirmBox.hidden = true; } }, 'Cancel')));
    if (d.status === 'removed') return h('span');
    return card({ icon: 'sensors', text: 'Manage' }, !online() ? h('p', { class: 'muted', text: 'Renaming and removing need a connection to the Petali server.' }) : h('div', {}, h('div', { class: 'field' }, h('label', { for: 'rename', text: 'Name' }), h('div', { class: 'inline' }, name, save)), h('button', { class: 'btn btn-danger-o', type: 'button', onclick: () => { confirmBox.hidden = false; confirmBox.scrollIntoView({ block: 'nearest' }); } }, 'Remove this computer…'), confirmBox));
  };
  const say = (t, bad) => { flash.textContent = t; flash.hidden = false; flash.className = `banner ${bad ? 'banner-warn' : ''}`; };
  const w1 = ctx.data.watch(mine.key, mine.path, (st) => { devSt = st; if (st.data) dev = st.data; paint(); });
  const w2 = ctx.data.watch(sum.key, sum.path, (st) => { smSt = st; if (st.data) sm = st.data.summary; paint(); });
  return { el, title: 'Computer', stop() { w1.stop(); w2.stop(); } };
}

// ---- plant ----
export function plantView(ctx) {
  return resourceView(ctx, {
    title: 'Plant', hideTitle: true, key: 'plant', path: '/v1/web/plant', source: 'cloud-ledger',
    render: (r) => {
      const p = r.plant;
      if (!p) return [empty('No plant data yet', 'Your plant grows while you use Petali on a computer. Once a computer has synchronised, its progress appears here.')];
      const out = [plantHero(r, { big: true })];
      out.push(h('div', { class: 'grid stats' }, stat('Total growth', minutesToDuration(p.growthMinutes), 'across all computers'), stat('Daily limit', minutesToDuration(p.dailyCapMinutes), 'shared by all computers'), stat('Computers contributing', String(p.computers), 'with plant data'), stat('Next stage', p.nextStage ? STAGE_TEXT[p.nextStage.id] : 'Fully grown', p.nextStage ? `${minutesToDuration(p.nextStage.remainingMinutes)} to go` : null, { icon: 'plant' })));
      out.push(card({ icon: 'plant', text: 'Stages' }, h('ol', { class: 'stages' }, p.stages.map((s) => h('li', { class: s.reached ? 'done' : '' }, h('strong', {}, STAGE_TEXT[s.id], s.reached ? h('span', { class: 'tick', text: ' ✓' }) : null), `from ${minutesToDuration(s.atMinutes)}`)))));
      if (p.recentDays.length) out.push(card({ icon: 'pcUsage', text: 'Growth per day' }, barChart(p.recentDays.map((d) => ({ label: dayLabel(d.day), short: d.day.slice(8), value: d.minutes })), { unitLabel: (v) => minutesToDuration(v), ariaLabel: 'Growth credited per day, minutes' }), h('p', { class: 'muted small', text: 'Days without growth are not shown. Growth only ever increases.' })));
      if (p.perDevice.length > 1) out.push(card({ icon: 'computerStatus', text: 'By computer' }, h('ul', { class: 'list rows' }, p.perDevice.map((d) => h('li', { class: 'row' }, h('div', {}, h('strong', { text: d.name || 'Computer' }), d.removed ? h('span', { class: 'muted small', text: ' (removed)' }) : null), h('span', { class: 'mono', text: minutesToDuration(d.creditedMinutes) })))), h('p', { class: 'muted small', text: 'Computers used on the same day share the daily limit, so the total is not the sum of this list.' })));
      out.push(h('p', { class: 'muted small', text: 'The plant is grown by the Petali desktop app. This page shows the account-wide progress from the cloud and never changes it. The plant\'s current mood (happy, tired, ...) is live on your computer and is not shown here.' }));
      return out;
    },
  });
}
export { deviceView };
