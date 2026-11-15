// Usage, Device Health, Reports, Settings, More.
import { PASSWORD_HINT, passwordProblem } from './auth-rules.js';
import { APP_VERSION } from './version.js';
import { h, card, stat, empty, pill, badge, barChart, lineChart, clear, problemBox } from './ui.js';
import { resourceView, deviceView, problemText } from './view-kit.js';
import { duration, dateTime, dayLabel, num, withUnit, DASH, isNum, ago } from './format.js';
import { BASE } from './router.js';
import { ApiError } from './api.js';

const lang = (ctx) => { const l = ctx.language; return l === 'cs' ? 'cs' : 'en'; };
const appName = (id) => { const n = globalThis.PetaliAppNames; return n ? n.displayNameOr(id, id) : id; };
const appCategory = (id) => { const c = globalThis.PetaliAppCategories; return (c && c.builtinCategory(String(id).toLowerCase())) || 'Other'; };

// ---- usage ----
const RANGES = [['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
export function usageView(ctx) {
  return deviceView(ctx, {
    title: 'Usage', controls: [{ name: 'days', label: 'Period', default: '30', options: RANGES }],
    request: (id, o) => ({
      key: `summary:${id}:${o.days}`, path: `/v1/devices/${id}/summary?days=${o.days}`,
      render: (data, st, device) => {
        const s = data.summary; const out = []; const u = s.usage;
        out.push(h('p', { class: 'muted small', text: `${s.range.from} to ${s.range.to}` }));
        if (!u.daily.length) { out.push(empty('No usage in this period', 'Nothing has been synchronised for these days. Days with no record are not counted as zero.')); return out; }
        out.push(h('div', { class: 'grid stats' }, stat('PC Usage · Active Work', duration(u.activeMs), `${u.activeDays} active day${u.activeDays === 1 ? '' : 's'} of ${u.daily.length} recorded`), stat('Average per active day', u.activeDays ? duration(u.activeMs / u.activeDays) : DASH), stat('Sessions', num(u.daily.reduce((a, d) => a + d.sessions, 0)))));
        out.push(card({ icon: 'pcUsage', text: 'Active Work per day' }, barChart(u.daily.map((d) => ({ label: dayLabel(d.day), short: d.day.slice(8), value: d.activeMs / 3600000 })), { unitLabel: (v) => `${v.toFixed(1)} h`, ariaLabel: 'Active Work per day, hours' }), h('p', { class: 'muted small', text: 'Locked, sleeping and hibernating time is never counted as Active Work.' })));
        const a = s.apps;
        if (a.top.length || a.unknownMs) {
          const total = a.attributedMs || 1;
          out.push(card({ icon: 'activeApps', text: 'Applications' }, h('ul', { class: 'list rows' }, a.top.slice(0, 10).map((x) => h('li', { class: 'row' }, h('div', {}, h('strong', { text: appName(x.app) }), h('div', { class: 'muted small', text: appCategory(x.app) })), h('div', { class: 'right' }, h('span', { text: duration(x.ms) }), h('div', { class: 'muted small', text: `${Math.round((x.ms / total) * 100)} %` }))))),
            a.otherMs ? h('p', { class: 'muted small', text: `Other applications: ${duration(a.otherMs)}` }) : null, a.unknownMs ? h('p', { class: 'muted small', text: `Not attributed to an application: ${duration(a.unknownMs)}` }) : null));
          const cats = new Map(); for (const x of a.top) cats.set(appCategory(x.app), (cats.get(appCategory(x.app)) || 0) + x.ms);
          out.push(card({ icon: 'activeApps', text: 'Categories' }, h('ul', { class: 'list rows' }, [...cats.entries()].sort((x, y) => y[1] - x[1]).map(([c, ms]) => h('li', { class: 'row' }, h('span', { text: c }), h('span', { text: duration(ms) })))), h('p', { class: 'muted small', text: 'Built-in categories. Changes you made on your computer are not synchronised, so they may differ from the desktop app. Browsers are "Other" because Petali never reads what you do inside them.' })));
        } else out.push(card({ icon: 'activeApps', text: 'Applications' }, h('p', { class: 'muted', text: 'No application usage was synchronised for this period.' })));
        return out;
      },
      extra: [{ key: `performance:${id}:${o.days}`, path: `/v1/web/devices/${id}/performance?days=${o.days}`, render: (p) => [performanceCard(p)] }],
    }),
  });
}

function performanceCard(p) {
  if (!p.available) return card({ icon: 'performance', text: 'Hardware performance' }, h('p', { class: 'muted', text: 'No hardware readings were synchronised for this period. A missing reading is never shown as zero.' }));
  const rows = p.metrics.filter((m) => ['cpuUsage', 'cpuTemp', 'gpuUsage', 'gpuTemp', 'ramUsage', 'fan', 'cpuPower', 'gpuPower'].includes(m.id));
  const NAMES = { cpuUsage: 'CPU usage', cpuTemp: 'CPU temperature', gpuUsage: 'GPU usage', gpuTemp: 'GPU temperature', ramUsage: 'Memory usage', fan: 'Fan speed', cpuPower: 'CPU power', gpuPower: 'GPU power' };
  const temp = p.days.map((d) => ({ label: dayLabel(d.dayKey), short: d.dayKey.slice(8), avg: d.tempAvg, max: d.tempMax }));
  return card({ icon: 'performance', text: 'Hardware performance' }, h('p', { class: 'muted small', text: `Based on ${duration(p.minutes * 60000)} of readings on ${p.daysWithHardware} day${p.daysWithHardware === 1 ? '' : 's'}.` }),
    h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Metric', 'Average', 'Peak'].map((t) => h('th', { text: t })))), h('tbody', {}, rows.map((m) => h('tr', {}, h('td', { text: NAMES[m.id] }), h('td', { text: withUnit(m.avg, m.unit, m.decimals) }), h('td', { text: withUnit(m.max, m.unit, m.decimals) }))))),
    temp.some((t) => isNum(t.avg)) ? h('div', {}, h('h3', { class: 'sub', text: 'CPU temperature per day (average and peak)' }), lineChart(temp, { unit: ' °C', ariaLabel: 'CPU temperature per day' })) : null);
}

// ---- device health ----
const SEV = { info: 'neutral', warning: 'warn', critical: 'bad' };
const SEV_TEXT = { info: 'Info', warning: 'Warning', critical: 'Critical' };
export function healthView(ctx) {
  return deviceView(ctx, {
    title: 'Device Health', controls: [{ name: 'days', label: 'Period', default: '30', options: RANGES }],
    request: (id, o) => ({
      key: `health:${id}:${o.days}`, path: `/v1/web/devices/${id}/health?days=${o.days}`,
      render: (r) => {
        const HT = globalThis.PetaliHealthText; const l = lang(ctx); const hl = r.health; const out = [];
        const latest = r.latest;
        out.push(card({ icon: 'deviceHealth', text: 'Latest recorded status' }, latest
          ? h('div', {}, h('div', { class: 'verdict' }, badge(latest.status === 'healthy' ? 'good' : latest.status === 'warning' ? 'warn' : 'bad', HT ? HT.statusLabel(l, { status: latest.status }) : latest.status), h('span', { class: 'muted small', text: ` for the hour starting ${dateTime(latest.at)}` })),
            h('p', { class: 'muted small', text: `That hour: ${latest.minutes.healthy} min healthy, ${latest.minutes.warning} min warning, ${latest.minutes.critical} min critical. This is what the computer last reported, not a live reading.` }))
          : h('p', { class: 'muted', text: 'This computer has not reported a Device Health status yet. That does not mean it is healthy - nothing was recorded.' })));
        if (!hl.recorded) { out.push(empty('No health history in this period', 'Nothing about Device Health was synchronised for these days.')); return out; }
        out.push(h('div', { class: 'grid stats' }, stat('Problems detected', String(hl.episodeCount), `last ${r.range.days} days`), stat('Worst severity', hl.worst ? SEV_TEXT[hl.worst] : 'None'), stat('Checked for', hl.evaluatedMinutes ? duration(hl.evaluatedMinutes * 60000) : DASH, hl.statusMinutes ? `${hl.statusMinutes.warning + hl.statusMinutes.critical} min with a problem` : null)));
        if (!hl.problems.length) out.push(card({ icon: 'deviceHealth', text: 'Detected problems' }, h('p', { class: 'muted', text: 'No problems were recorded in this period.' })));
        else out.push(card({ icon: 'deviceHealth', text: 'Detected problems' }, h('ul', { class: 'list' }, hl.problems.map((p) => {
          const t = HT ? HT.problemText(l, { id: p.id, severity: p.severity, values: (hl.episodes.slice().reverse().find((e) => e.id === p.id) || {}).values || [] }) : { title: p.id, explanation: '', action: '' };
          return problemBox({ level: p.severity, title: t.title || p.id, level_text: SEV_TEXT[p.severity] || p.severity, meta: `${p.count} time${p.count === 1 ? '' : 's'}${p.totalMs !== null ? ` · ${duration(p.totalMs)} in total` : ''} · last ${ago(p.lastAt)}`, explanation: t.explanation, action: t.action });
        }))));
        if (hl.episodes.length) out.push(card({ icon: 'deviceHealth', text: 'History' }, h('ul', { class: 'list rows' }, hl.episodes.slice().reverse().map((e) => h('li', { class: 'row' }, h('div', {}, h('strong', { text: (HT && HT.problemText(l, { id: e.id, severity: e.severity, values: e.values }).title) || e.id }), h('div', { class: 'muted small', text: `${dateTime(e.start)}${e.end ? ` · ${e.durationMs !== null ? duration(e.durationMs) : 'interrupted'}` : ' · no end recorded'}` })), pill(SEV_TEXT[e.severity] || e.severity, SEV[e.severity] || 'neutral')))), hl.episodesShown < hl.episodeCount ? h('p', { class: 'muted small', text: `Showing the latest ${hl.episodesShown} of ${hl.episodeCount}.` }) : null));
        out.push(h('p', { class: 'muted small', text: 'Verdicts and recommendations come from the Petali desktop app\'s own Device Health rules; this page only shows what the computer recorded.' }));
        return out;
      },
    }),
  });
}

// ---- reports ----
const KINDS = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
const REASONS = { 'current-too-short': 'This period has too few days so far to compare fairly.', 'no-previous-data': 'There is no data for the previous period.', 'too-few-days': 'The previous period has too few recorded days to compare fairly.', 'not-applicable': 'Daily reports are not compared.' };
const periodTitle = (p) => (p.kind === 'daily' ? dayLabel(p.key) : p.kind === 'weekly' ? `Week of ${dayLabel(p.from)} – ${dayLabel(p.to)}` : new Date(`${p.key}-15T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }));
export function reportsView(ctx) {
  let key = null; let lastKind = null;
  return deviceView(ctx, {
    title: 'Reports', controls: [{ name: 'kind', label: 'Report', default: 'weekly', options: KINDS }],
    request: (id, o) => { if (o.kind !== lastKind) { key = null; lastKind = o.kind; } return {
      key: `report:${id}:${o.kind}:${key || 'current'}`, path: `/v1/web/devices/${id}/report?kind=${o.kind}${key ? `&key=${key}` : ''}`,
      render: (r, st, device, api) => {
        const out = []; const p = r.period; const u = r.usage; const hw = r.hardware; const hl = r.health;
        const go = (k) => { key = k; api.reload ? api.setOpts({}) : null; };
        out.push(h('div', { class: 'period-nav' }, h('button', { class: 'btn', type: 'button', disabled: !r.navigation.previous, 'aria-label': 'Previous period', onclick: () => go(r.navigation.previous) }, '‹'), h('div', {}, h('strong', { text: periodTitle(p) }), h('div', { class: 'muted small', text: `${p.from}${p.to !== p.from ? ` – ${p.to}` : ''}` })), h('button', { class: 'btn', type: 'button', disabled: !r.navigation.next, 'aria-label': 'Next period', onclick: () => go(r.navigation.next) }, '›')));
        out.push(h('p', { class: 'muted small', text: `${device ? device.name : r.device.name} · generated ${dateTime(r.generatedAt)}${p.incomplete ? ' · this period is not complete (still running, or before the history starts)' : ''}` }));
        out.push(card({ icon: 'pcUsage', text: 'PC Usage · Active Work' }, u.available ? h('div', { class: 'grid stats' }, stat('Total', duration(u.totalMs)), stat('Active days', `${u.activeDays} of ${u.knownDays} recorded`), stat('Average per recorded day', duration(u.avgPerKnownDayMs)), stat('Longest session', duration(u.longestSessionMs))) : h('p', { class: 'muted', text: 'No usage was synchronised for this period.' }),
          u.available && p.days > 1 ? barChart(u.days.map((d) => ({ label: dayLabel(d.dayKey), short: d.dayKey.slice(8), value: d.activeMs === null ? null : d.activeMs / 3600000 })), { unitLabel: (v) => `${v.toFixed(1)} h`, ariaLabel: 'Active Work per day, hours' }) : null,
          u.bestDay ? h('p', { class: 'muted small', text: `Busiest day: ${dayLabel(u.bestDay.dayKey)} (${duration(u.bestDay.ms)})` }) : null));
        if (r.apps.available) out.push(card({ icon: 'activeApps', text: 'Top applications' }, h('ul', { class: 'list rows' }, r.apps.top.slice(0, 6).map((x) => h('li', { class: 'row' }, h('span', { text: appName(x.app) }), h('span', { text: duration(x.ms) }))))));
        out.push(card({ icon: 'cpu', text: 'Hardware' }, hw.metrics.length ? h('div', {}, h('p', { class: 'muted small', text: `${duration(hw.minutes * 60000)} of readings on ${hw.daysWithHardware} day${hw.daysWithHardware === 1 ? '' : 's'}. Averages are weighted by readings.` }),
          h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Metric', 'Average', 'Peak'].map((t) => h('th', { text: t })))), h('tbody', {}, hw.metrics.filter((m) => ['cpuUsage', 'cpuTemp', 'gpuUsage', 'gpuTemp', 'ramUsage', 'fan'].includes(m.id)).map((m) => h('tr', {}, h('td', { text: ({ cpuUsage: 'CPU usage', cpuTemp: 'CPU temperature', gpuUsage: 'GPU usage', gpuTemp: 'GPU temperature', ramUsage: 'Memory usage', fan: 'Fan speed' })[m.id] }), h('td', { text: withUnit(m.avg, m.unit, m.decimals) }), h('td', { text: withUnit(m.max, m.unit, m.decimals) })))))) : h('p', { class: 'muted', text: 'No hardware readings were synchronised for this period.' })));
        const HT = globalThis.PetaliHealthText;
        out.push(card({ icon: 'deviceHealth', text: 'Device Health' }, hl.recorded ? h('div', {}, h('p', { text: hl.episodeCount ? `${hl.episodeCount} problem${hl.episodeCount === 1 ? '' : 's'} detected${hl.worst ? `, worst: ${SEV_TEXT[hl.worst]}` : ''}.` : 'No problems were detected.' }), hl.problems.length ? h('ul', { class: 'list rows' }, hl.problems.map((x) => h('li', { class: 'row' }, h('span', { text: (HT && HT.problemText(lang(ctx), { id: x.id, severity: x.severity, values: [] }).title) || x.id }), h('span', { text: `${x.count}×` })))) : null) : h('p', { class: 'muted', text: 'Nothing about Device Health was recorded for this period.' })));
        const c = r.comparison;
        out.push(card({ icon: 'performance', text: 'Compared with the previous period' }, c.available ? h('div', {}, h('p', { text: `Average Active Work per recorded day: ${duration(c.usage.currentAvgMs)} vs ${duration(c.usage.previousAvgMs)}${c.usage.deltaPct !== null ? ` (${c.usage.deltaPct > 0 ? '+' : ''}${c.usage.deltaPct} %)` : ''}.` }),
          Object.entries(c.metrics).map(([id, m]) => h('p', { class: 'small', text: `${({ cpuUsage: 'CPU usage', cpuTemp: 'CPU temperature', gpuUsage: 'GPU usage', gpuTemp: 'GPU temperature', ramUsage: 'Memory usage' })[id]}: ${num(m.currentAvg, 1)}${m.unit === '%' || m.unit === '°C' ? m.unit : ` ${m.unit}`} vs ${num(m.previousAvg, 1)}${m.unit === '%' || m.unit === '°C' ? m.unit : ` ${m.unit}`}` })),
          c.episodes ? h('p', { class: 'small', text: `Problems: ${c.episodes.current} vs ${c.episodes.previous}.` }) : null) : h('p', { class: 'muted', text: REASONS[c.reason] || 'No comparison is available.' })));
        return out;
      },
    }; },
  });
}

// ---- settings ----
export function settingsView(ctx) {
  const el = h('div', { class: 'view' }); const body = h('div'); el.append(h('h1', { text: 'Settings' }), body);
  const flash = h('p', { class: 'banner', hidden: true, role: 'status' });
  const say = (t, bad) => { flash.textContent = t; flash.hidden = false; flash.className = `banner ${bad ? 'banner-warn' : ''}`; };
  const online = () => ctx.onlineNow() && ctx.session.state().status === 'authenticated';
  const stops = []; const extra = { settings: null, events: null };
  const draw = (account, sessions) => {
    clear(body).append(flash);
    const u = account ? account.user : ctx.session.state().user;
    const nameInput = h('input', { id: 'dn', type: 'text', maxlength: 50, value: (u && u.displayName) || '', 'aria-label': 'Display name' });
    body.append(card({ icon: 'computerStatus', text: 'Account' }, h('dl', { class: 'kv' }, h('dt', { text: 'Email' }), h('dd', { text: (u && u.email) || DASH }), h('dt', { text: 'Email status' }), h('dd', { text: u && u.emailVerified ? 'Confirmed' : u && u.emailVerified === false ? 'Not confirmed yet' : DASH }), h('dt', { text: 'Petali ID' }), h('dd', { class: 'mono' }, (u && u.petaliId) || DASH, ' ', u && u.petaliId ? copyButton(u.petaliId) : null), h('dt', { text: 'Sign-in' }), h('dd', { text: u && u.hasPassword === false ? 'Google' : 'Email and password' }), u && u.createdAt ? [h('dt', { text: 'Created' }), h('dd', { text: dateTime(u.createdAt) })] : null),
      online() && account ? h('div', { class: 'field' }, h('label', { for: 'dn', text: 'Display name' }), h('div', { class: 'inline' }, nameInput, h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await ctx.api.patch('/v1/account/profile', { displayName: nameInput.value.trim() || null }); ctx.session.updateUser(r.user); await ctx.cache.del(ctx.session.userId(), 'account'); say('Saved.'); } catch (e) { say(e instanceof ApiError ? e.message : 'Could not save.', true); } } }, 'Save'))) : h('p', { class: 'muted small', text: online() ? '' : 'Account changes need a connection to the Petali server.' })));
    const sched = ctx.theme.getSchedule(); const fmt = (t) => t;
    const modeNote = { auto: `Night from ${fmt(sched.from)} to ${fmt(sched.to)} on this device's clock${ctx.theme.hasCustomSchedule() ? ', the schedule you set in the Petali desktop app' : ' (change it in the Petali desktop app, under Settings)'}.`, day: 'Always light on this device.', night: 'Always dark on this device.' }[ctx.theme.getMode()];
    body.append(card({ icon: 'plant', text: 'Appearance' }, h('p', { class: 'muted small', id: 'theme-note', text: modeNote }), h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' }, [['auto', 'Automatic'], ['day', 'Day'], ['night', 'Night']].map(([v, l]) => h('button', { type: 'button', class: 'seg-b', 'aria-pressed': String(ctx.theme.getMode() === v), onclick: () => { ctx.theme.setMode(v); draw(account, sessions); } }, l))), h('p', { class: 'muted small', text: 'The choice is saved on this device and used every time you sign in here.' })));
    if (online() && account) body.append(languageCard(ctx, say), alertsCard(ctx, extra, say));
    if (online()) body.append(sessionsCard(ctx, sessions, () => load(), say));
    if (online() && account) {
      const hasPw = !(u && u.hasPassword === false);
      body.append(hasPw ? passwordCard(ctx, say) : noPasswordCard(), hasPw ? emailCard(ctx, say, () => load()) : h('span'), activityCard(extra.events), deletionCard(ctx, u, hasPw, say, () => load()));
    }
    body.append(installCardLite(ctx), card({ icon: 'storage', text: 'This browser' }, h('p', { class: 'muted', text: 'Petali ID keeps saved copies of the views you open so they can be shown offline. They are labelled as saved copies and belong to this account only.' }),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await ctx.cache.wipeAll(); ctx.api.forget(); say('Saved data removed from this browser. Signing you in again…'); await ctx.session.logout(); } }, 'Remove saved data and sign out')),
      card(null, h('button', { class: 'btn btn-danger-o', type: 'button', onclick: () => ctx.session.logout() }, 'Sign out')));
  };
  let account = null; let sessions = null;
  async function load() {
    draw(account, sessions);
    if (!online()) return;
    try {
      account = await ctx.api.get('/v1/account'); const s = await ctx.api.get('/v1/account/sessions'); sessions = s.sessions; draw(account, sessions);
      try { extra.settings = (await ctx.api.get('/v1/account/settings')).settings; extra.events = (await ctx.api.get('/v1/account/security-events?limit=20')).events; draw(account, sessions); } catch { /* these two cards just stay out until the next visit */ }
    } catch (e) { say(problemText(e), true); }
  }
  load();
  return { el, title: 'Settings', stop() { stops.forEach((f) => f()); } };
}
function languageCard(ctx, say) {
  const cur = ctx.language || 'en';
  return card({ icon: 'sensors', text: 'Language' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Language' }, [['en', 'English'], ['cs', 'Čeština']].map(([v, l]) => h('button', { type: 'button', class: 'seg-b', 'aria-pressed': String(cur === v), onclick: async () => { try { await ctx.api.patch('/v1/account/settings', { language: v }); ctx.language = v; say('Saved. Texts from the desktop app\'s Device Health rules now use this language.'); } catch (e) { say(e instanceof ApiError ? e.message : 'Could not save.', true); } } }, l))));
}
function sessionsCard(ctx, sessions, reload, say) {
  if (!sessions) return h('span');
  const rows = sessions.map((s) => h('li', { class: 'row' }, h('div', {}, h('strong', { text: s.deviceLabel || 'Session' }), s.current ? pill('This session', 'good') : null, h('div', { class: 'muted small', text: `Last used ${ago(s.lastUsedAt)}` })), s.current ? null : h('button', { class: 'btn', type: 'button', onclick: async () => { try { await ctx.api.del(`/v1/account/sessions/${s.id}`); reload(); } catch (e) { say(problemText(e), true); } } }, 'Sign out')));
  return card({ icon: 'computerStatus', text: 'Signed-in sessions' }, h('ul', { class: 'list rows' }, rows), sessions.length > 1 ? h('button', { class: 'btn', type: 'button', onclick: async () => { try { await ctx.api.del('/v1/account/sessions'); reload(); } catch (e) { say(problemText(e), true); } } }, 'Sign out all other sessions') : null);
}
function passwordCard(ctx, say) {
  const cur = h('input', { id: 'pw0', type: 'password', autocomplete: 'current-password' }); const nw = h('input', { id: 'pw1', type: 'password', autocomplete: 'new-password' });
  return card({ icon: 'sensors', text: 'Change password' }, h('div', { class: 'field' }, h('label', { for: 'pw0', text: 'Current password' }), cur), h('div', { class: 'field' }, h('label', { for: 'pw1', text: 'New password' }), nw),
    h('p', { class: 'muted small', text: PASSWORD_HINT }),
    h('button', { class: 'btn', type: 'button', onclick: async () => { const bad = passwordProblem(nw.value); if (bad) { say(bad, true); nw.focus(); return; } try { await ctx.api.put('/v1/account/password', { currentPassword: cur.value, newPassword: nw.value }); cur.value = ''; nw.value = ''; say('Password changed. Other sessions were signed out.'); } catch (e) { say(e instanceof ApiError ? e.message : 'Could not change the password.', true); } } }, 'Change password'));
}

// ---- account features the desktop app already had (Phase 7 parity): copy ID, security alerts, change email, activity, deletion ----
function copyButton(text) {
  const b = h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Copy Petali ID' }, 'Copy');
  b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; } setTimeout(() => { b.textContent = 'Copy'; }, 1800); };
  return b;
}
function alertsCard(ctx, extra, say) {
  if (!extra.settings) return h('span');
  const box = h('input', { type: 'checkbox', id: 'sec-alerts', checked: extra.settings.securityAlerts !== false });
  box.onchange = async () => { try { await ctx.api.patch('/v1/account/settings', { securityAlerts: box.checked }); extra.settings.securityAlerts = box.checked; say('Saved.'); } catch (e) { box.checked = !box.checked; say(e instanceof ApiError ? e.message : 'Could not save.', true); } };
  return card({ icon: 'sensors', text: 'Security alerts' }, h('label', { class: 'check', for: 'sec-alerts' }, box, ' Tell me about important security events on this account'), h('p', { class: 'muted small', text: 'Stored in your Petali account, the same setting as in the desktop app.' }));
}
function noPasswordCard() {
  return card({ icon: 'sensors', text: 'Password' }, h('p', { class: 'muted', text: 'This account was created with Google and has no Petali password, so you sign in with Continue with Google. Changing the email address or password is not available for it.' }));
}
function emailCard(ctx, say, reload) {
  const ne = h('input', { id: 'em1', type: 'email', autocomplete: 'email', maxlength: 254 }); const pw = h('input', { id: 'em2', type: 'password', autocomplete: 'current-password', maxlength: 128 });
  return card({ icon: 'computerStatus', text: 'Change email' }, h('div', { class: 'field' }, h('label', { for: 'em1', text: 'New email address' }), ne), h('div', { class: 'field' }, h('label', { for: 'em2', text: 'Current password' }), pw),
    h('p', { class: 'muted small', text: 'The new address must be confirmed with a link we send to it. Other sessions stay signed in.' }),
    h('button', { class: 'btn', type: 'button', onclick: async () => { if (!ne.value.trim() || !pw.value) { say('Enter the new email and your current password.', true); return; } try { await ctx.api.put('/v1/account/email', { newEmail: ne.value.trim(), currentPassword: pw.value }); pw.value = ''; ne.value = ''; say('Email changed. Confirm it with the link we sent to the new address.'); ctx.cache.del(ctx.session.userId(), 'account'); reload(); } catch (e) { pw.value = ''; say(e instanceof ApiError ? e.message : 'Could not change the email.', true); } } }, 'Change email'));
}
const EVENT_TEXT = { register: 'Account created', login: 'Signed in', login_failed: 'Failed sign-in attempt', logout: 'Signed out', refresh_reuse_detected: 'Suspicious sign-in reuse (session ended)', password_changed: 'Password changed', email_changed: 'Email changed', session_revoked: 'Device signed out', sessions_revoked: 'Devices signed out', deletion_requested: 'Deletion requested', deletion_cancelled: 'Deletion cancelled', settings_changed: 'Account settings changed' };
function activityCard(events) {
  if (!events) return h('span');
  return card({ icon: 'activeApps', text: 'Recent activity' }, events.length ? h('ul', { class: 'list rows' }, events.map((e) => h('li', { class: 'row' }, h('div', {}, h('strong', { text: `${EVENT_TEXT[e.type] || e.type}${e.detail && /^google/.test(e.detail) ? ' with Google' : ''}` }), h('div', { class: 'muted small', text: `${dateTime(e.createdAt)}${e.ipAddress ? ` · ${e.ipAddress}` : ''}` }))))) : h('p', { class: 'muted', text: 'No activity yet.' }));
}
function deletionCard(ctx, u, hasPw, say, reload) {
  const pending = u && u.deletionRequestedAt;
  if (pending) return card({ icon: 'storage', text: 'Delete account' }, h('p', { class: 'banner banner-warn', text: `Deletion requested ${dateTime(u.deletionRequestedAt)}. Nothing has been erased yet.` }), h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await ctx.api.del('/v1/account/deletion-request'); ctx.session.updateUser(r.user); say('Deletion request cancelled.'); reload(); } catch (e) { say(e instanceof ApiError ? e.message : 'Could not cancel.', true); } } }, 'Cancel the request'));
  if (!hasPw) return card({ icon: 'storage', text: 'Delete account' }, h('p', { class: 'muted', text: 'Deleting a Google-created account needs a Petali password, which this account does not have yet. This is not available for it yet.' }));
  const pw = h('input', { id: 'del-pw', type: 'password', autocomplete: 'current-password', maxlength: 128 });
  return card({ icon: 'storage', text: 'Delete account' }, h('p', { class: 'muted small', text: 'This records a deletion request, which you can cancel. Nothing is erased until the request is processed.' }), h('div', { class: 'field' }, h('label', { for: 'del-pw', text: 'Confirm with your password' }), pw),
    h('button', { class: 'btn btn-danger-o', type: 'button', onclick: async () => { if (!pw.value) { say('Enter your password to confirm.', true); return; } try { const r = await ctx.api.post('/v1/account/deletion-request', { password: pw.value }); pw.value = ''; ctx.session.updateUser(r.user); say('Deletion requested. You can cancel it here at any time.'); reload(); } catch (e) { pw.value = ''; say(e instanceof ApiError ? e.message : 'Could not request deletion.', true); } } }, 'Request deletion'));
}
function installCardLite(ctx) {
  const i = ctx.installInfo;
  return card({ icon: 'activeApps', text: 'Install' }, h('p', { class: 'muted', text: i.isStandalone() ? 'Petali ID is running as an installed app.' : 'Petali ID works in the browser without installing. To install it: ' + (i.isIos() ? 'in Safari tap Share, then "Add to Home Screen".' : i.canPrompt() ? 'use the button below.' : 'use "Install app" in your browser menu, if it is offered.') }), !i.isStandalone() && i.canPrompt() ? h('button', { class: 'btn', type: 'button', onclick: () => i.prompt() }, 'Install') : null);
}

// ---- more ----
export function moreView(ctx) {
  const st = ctx.session.state(); const u = st.user || {};
  const link = (href, title, text) => h('li', {}, h('a', { href, class: 'row' }, h('div', {}, h('strong', { text: title }), h('div', { class: 'muted small', text })), h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' })));
  const el = h('div', { class: 'view' }, h('h1', { text: 'More' }), card(null, h('div', { class: 'who-card' }, h('strong', { text: u.displayName || u.email || 'Your account' }), h('div', { class: 'muted small', text: u.email || '' }))),
    h('ul', { class: 'list rows card' }, link(`${BASE}/health`, 'Device Health', 'Problems and recommendations'), link(`${BASE}/reports`, 'Reports', 'Daily, weekly and monthly'), link(`${BASE}/settings`, 'Settings', 'Account, sessions, appearance'), link('/', 'Petali website', 'Downloads and release notes')),
    h('button', { class: 'btn btn-danger-o', type: 'button', onclick: () => ctx.session.logout() }, 'Sign out'));
  el.append(h('p', { class: 'muted small ver', text: `Petali ID ${APP_VERSION}` }));
  return { el, title: 'More', stop() {} };
}

export function notFoundView() {
  return { el: h('div', { class: 'view' }, empty('Page not found', 'This page does not exist in Petali ID.', h('a', { class: 'btn btn-primary', href: `${BASE}/`, text: 'Go to the dashboard' }))), title: 'Not found', stop() {} };
}
