// Shared building blocks for the data views: a view that loads one saved-copy-then-network resource, and a view scoped to one computer.
import { ApiError } from './api.js';
import { h, clear, skeleton, errorBox, empty, provenance, pill } from './ui.js';
import { ago, dateTime, STATUS_TEXT } from './format.js';

export const problemText = (e) => (e instanceof ApiError ? (e.code === 'offline' ? e.message : e.code === 'email_not_verified' ? 'Confirm your email address to see this. Open the link in the message Petali sent you, or ask for a new one with the button at the top.' : e.transient ? 'The Petali server could not be reached. Saved data is shown where available.' : e.status === 404 ? 'This item was not found in your account.' : e.message) : 'Something went wrong.');

// Provenance + status lines for a loaded state. `syncedAt` is when the DATA was last synchronised by a computer (not when this page loaded).
export function notes(st, { syncedAt, source, what } = {}) {
  const out = [];
  out.push(provenance({ source, syncedAt: syncedAt ? `${ago(syncedAt)} (${dateTime(syncedAt)})` : null, cached: st.cached, savedAt: st.savedAt ? dateTime(st.savedAt) : '', what }));
  if (st.cached && st.loading) out.push(h('p', { class: 'muted small', text: 'Refreshing…' }));
  if (st.cached && st.error) out.push(h('p', { class: 'banner banner-warn', text: `Could not refresh: ${problemText(st.error)} Showing the saved copy.` }));
  if (st.cached && st.offline) out.push(h('p', { class: 'banner banner-warn', text: 'You are offline. This is the last saved copy, not live data.' }));
  return out;
}

export function resourceView(ctx, { title, key, path, render, syncedAt, source, what, hideTitle, ready }) {
  const el = h('div', { class: 'view' }); const body = h('div');
  el.append(h('h1', { text: title, class: hideTitle ? 'sr' : null }), body);
  let stopped = false;
  const w = ctx.data.watch(key, path, (st) => { if (ready) ready.then(() => { if (!stopped) paint(st); }); else paint(st); });
  function paint(st) {
    clear(body);
    if (!st.data) { if (st.loading) body.append(skeleton(5)); else if (st.error && st.error.code === 'email_not_verified') body.append(empty('Confirm your email', 'Open the link in the message Petali sent you. Use the button at the top if you need a new one. This page unlocks as soon as your email is confirmed.')); else if (st.error) body.append(errorBox(problemText(st.error), () => w.reload())); return; }
    body.append(...notes(st, { syncedAt: syncedAt ? syncedAt(st.data) : null, source, what: what ? what(st.data) : null }), ...render(st.data, st, w));
  }
  return { el, title, stop() { stopped = true; w.stop(); }, reload: w.reload };
}

const SEL_KEY = 'selectedDevice';
// A view about ONE computer of the account: a chooser on top, optional controls (period...), then the resource for the choice.
// Switching computers only changes what is displayed; it never touches the computer or its local data.
export function deviceView(ctx, { title, controls = [], request, wantId }) {
  const el = h('div', { class: 'view' }); const chooser = h('div', { class: 'chooser' }); const ctl = h('div', { class: 'controls' }); const body = h('div');
  el.append(h('h1', { text: title }), chooser, ctl, body);
  let list = []; let sel = wantId || null; let inner = null; let stopped = false;
  const opts = Object.fromEntries(controls.map((c) => [c.name, c.default]));
  const devs = ctx.data.watch('devices', '/v1/devices', (st) => {
    if (stopped) return;
    if (!st.data) { clear(chooser); if (st.loading) chooser.append(skeleton(1)); else if (st.error) { clear(body).append(errorBox(problemText(st.error), () => devs.reload())); } return; }
    list = (st.data.devices || []).filter((d) => !d.removed);
    paint(st);
    if (!sel || !list.some((d) => d.id === sel)) { ctx.cache.getMeta(SEL_KEY).then((m) => { if (stopped) return; const pick = m && m.petaliId === ctx.session.userId() && list.some((d) => d.id === m.id) ? m.id : (list[0] && list[0].id) || null; if (pick !== sel) { sel = pick; paint(st); load(); } else if (!inner) load(); }); } else if (!inner) load();
  });
  function paint(st) {
    clear(chooser);
    if (!list.length) { clear(body).append(empty('No computers yet', 'Install Petali on a Windows PC and sign in with this Petali ID. Its synchronised data will appear here.', h('a', { class: 'btn', href: '/#download', text: 'Download Petali' }))); return; }
    chooser.append(h('label', { class: 'sr', for: 'dev-sel', text: 'Computer' }), h('select', { id: 'dev-sel', class: 'select', onchange: (e) => { sel = e.target.value; ctx.cache.setMeta(SEL_KEY, { petaliId: ctx.session.userId(), id: sel }); load(); } }, list.map((d) => h('option', { value: d.id, selected: d.id === sel, text: `${d.name}${d.status === 'stale' ? ' (not synced recently)' : ''}` }))));
    if (st && st.cached) chooser.append(h('span', { class: 'muted small', text: 'saved list' }));
  }
  controls.forEach((c) => ctl.append(h('div', { class: 'seg', role: 'group', 'aria-label': c.label }, c.options.map(([v, l]) => h('button', { type: 'button', class: 'seg-b', 'aria-pressed': String(opts[c.name] === v), onclick: () => { opts[c.name] = v; clear(ctl).append(...rebuild()); load(); } }, l)))));
  function rebuild() { return controls.map((c) => h('div', { class: 'seg', role: 'group', 'aria-label': c.label }, c.options.map(([v, l]) => h('button', { type: 'button', class: 'seg-b', 'aria-pressed': String(opts[c.name] === v), onclick: () => { opts[c.name] = v; clear(ctl).append(...rebuild()); load(); } }, l)))); }
  let extras = [];
  function stopInner() { if (inner) inner.stop(); extras.forEach((x) => x.stop()); inner = null; extras = []; }
  function load() {
    stopInner(); clear(body);
    if (!sel) return;
    const device = list.find((d) => d.id === sel); const r = request(sel, { ...opts }, device);
    const holder = h('div'); body.append(holder);
    const api = { opts, setOpts: (o) => { Object.assign(opts, o); clear(ctl).append(...rebuild()); load(); } };
    inner = ctx.data.watch(r.key, r.path, (st) => {
      if (stopped) return; clear(holder);
      if (!st.data) { if (st.loading) holder.append(skeleton(5)); else if (st.error) holder.append(errorBox(problemText(st.error), () => inner.reload())); return; }
      holder.append(...notes(st, { syncedAt: device && device.lastSyncAt, source: 'cloud-snapshot', what: device ? device.name : null }), ...r.render(st.data, st, device, { ...api, reload: () => inner.reload() }));
    });
    for (const x of r.extra || []) {
      const eh = h('div'); body.append(eh);
      extras.push(ctx.data.watch(x.key, x.path, (st) => { if (stopped) return; clear(eh); if (!st.data) { if (st.loading) eh.append(skeleton(3)); else if (st.error) eh.append(errorBox(problemText(st.error))); return; } eh.append(...x.render(st.data, st, device)); }));
    }
  }
  return { el, title, stop() { stopped = true; devs.stop(); stopInner(); } };
}
export { pill, STATUS_TEXT };
