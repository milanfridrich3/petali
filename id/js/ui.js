// Tiny DOM helpers and shared components. Text is ALWAYS inserted as text (never innerHTML), so account data can never inject markup.
import { DASH } from './format.js';
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v; else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v); else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
export const svg = (markup, cls) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); const n = t.content.firstElementChild; if (cls) n.setAttribute('class', cls); return n; };
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

// The desktop's own 24x24 stroke icons (vendor/widget-icons.js), drawn exactly as the desktop widgets draw them.
export function icon(name) {
  const paths = globalThis.PetaliIcons && globalThis.PetaliIcons[name]; if (!paths) return null;
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('aria-hidden', 'true'); for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) el.setAttribute(k, v); el.innerHTML = paths; return el;
}
export const brandMark = (cls = '') => h('span', { class: `brand-mark ${cls}`.trim() }, icon('plant') || null);
// Card with the desktop's widget title (small accent icon + muted 12px title). `title` is a string or { icon, text }.
export const card = (title, ...body) => { const t = typeof title === 'string' ? { text: title } : title; return h('section', { class: 'card' }, t ? h('h2', { class: 'card-title' }, t.icon ? icon(t.icon) : null, t.text) : null, ...body); };
// Widget tile: icon + label on top, big mono value, small hint. A value that starts with a number ("19 h 30 min", "2 problems") is drawn as mono numbers
// with small muted units, like the desktop widgets (.wd-value / .wd-unit). opts: { icon, tone }; the icon is chosen from the label when not given.
const AUTO_ICON = [[/computer/i, 'computerStatus'], [/health|problem|severity/i, 'deviceHealth'], [/sync/i, 'performance'], [/growth|daily limit|contributing/i, 'plant'], [/usage|active work|average|total|session|longest|busiest/i, 'pcUsage']];
export function unitize(text) {
  const parts = String(text).split(/(\d+(?:[.,]\d+)?)/).filter((x) => x !== '');
  return h('span', {}, parts.map((p) => (/^\d/.test(p) ? p : h('span', { class: 'u', text: p }))));
}
export function stat(label, value, hint, opts = {}) {
  const name = opts.icon ?? (AUTO_ICON.find(([re]) => re.test(label)) || [])[1];
  const v = typeof value === 'string' && /^\d/.test(value) ? unitize(value) : value;
  return h('div', { class: 'stat' }, h('div', { class: 'stat-l' }, name ? icon(name) : null, label), h('div', { class: `stat-v ${opts.tone ? `tone-${opts.tone}` : ''} ${value === DASH ? 'na' : ''}`.trim() }, v), hint ? h('div', { class: 'stat-h', text: hint }) : null);
}

export const empty = (title, text, action) => h('div', { class: 'empty' }, h('div', { class: 'empty-t', text: title }), h('p', { text }), action || null);
export const skeleton = (lines = 3) => h('div', { class: 'skeleton', 'aria-hidden': 'true' }, Array.from({ length: lines }, () => h('i')));
export const pill = (text, kind = 'neutral') => h('span', { class: `pill pill-${kind}`, text });
export const badge = (kind, text) => h('span', { class: `badge badge-${kind}`, text });
export const errorBox = (message, onRetry) => h('div', { class: 'error-box', role: 'alert' }, h('p', { text: message }), onRetry ? h('button', { class: 'btn', type: 'button', onclick: onRetry }, 'Try again') : null);

// "Cloud snapshot" / "Saved copy" / "Cloud data" provenance line shown on every data view.
export function provenance({ source = 'cloud-snapshot', syncedAt, cached, savedAt, what }) {
  const bits = [];
  if (cached) bits.push(h('strong', { text: 'Saved copy' }), ` from ${savedAt}`);
  else bits.push(h('strong', { text: source === 'cloud-ledger' ? 'Cloud data' : 'Cloud snapshot' }));
  if (syncedAt) bits.push(` · last synchronised ${syncedAt}`);
  if (what) bits.push(` · ${what}`);
  return h('p', { class: `prov ${cached ? 'prov-cached' : ''}` }, bits);
}

// ---- charts (inline SVG; the desktop's .sv-chart look: hairline grid, mono axis labels, accent bars, dashed peak line) ----
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, a = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); return e; };
const grid = (root, w, pad, ih, top) => { for (const f of [0, 0.5, 1]) { const y = top + ih - f * ih; root.append(sv('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, class: 'grid-line' })); } };
// ---- column / point highlighting (the same interaction as the desktop app's Statistics charts) -------------------------------------------------
// Hover (mouse, pen): the column under the pointer gets a soft band behind it and the other columns step back; leaving the chart restores everything.
// Touch: tapping a column selects it (band + a small readout); tapping another column moves it, tapping anywhere else clears it.
// Keyboard: with the chart focused, Left/Right/Home/End move the highlight and Escape or leaving the chart clears it.
// The band, the readout and the focus dot are drawn once with the chart and only shown/hidden afterwards (opacity / hidden attribute on absolutely
// positioned or SVG elements), so nothing ever changes size or moves the layout. The native <title> tooltips stay as they were.
const outsideClear = new Set();
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { for (const f of [...outsideClear]) f(e.target); }, true);
function wireHighlight(host, svg) {
  const cfg = svg && svg.petaliHl; if (!cfg || !cfg.n) return;
  const tip = h('div', { class: 'chart-tip', role: 'tooltip', hidden: true }); host.append(tip);
  svg.setAttribute('tabindex', '0'); let active = -1;
  const vbW = () => (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || cfg.width;
  const indexAt = (clientX) => { const r = svg.getBoundingClientRect(); if (!r.width) return -1; const x = (clientX - r.left) * (vbW() / r.width); return cfg.hit(x); };
  function show(i) {
    if (i < 0 || i >= cfg.n) { clearAll(); return; }
    if (i === active) return; active = i;
    cfg.show(i); svg.classList.add('has-active');
    const t = cfg.tip(i); clear(tip).append(h('strong', { text: t.head }), ...t.rows.map((r) => h('div', {}, h('span', { text: r[0] }), r[1] ? h('b', { text: r[1] }) : null)));
    tip.hidden = false;
    const hw = host.clientWidth || 300; const tw = tip.offsetWidth || 120; const cx = cfg.centerPx(i, hw / vbW());
    tip.style.left = `${Math.max(2, Math.min(hw - tw - 2, cx - tw / 2))}px`;
  }
  function clearAll() { if (active < 0 && tip.hidden) return; active = -1; cfg.hide(); svg.classList.remove('has-active'); tip.hidden = true; }
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; show(indexAt(e.clientX)); });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') clearAll(); });
  svg.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { const i = indexAt(e.clientX); if (i === active) clearAll(); else show(i); } });
  svg.addEventListener('keydown', (e) => {
    const k = e.key; if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(k)) return;
    e.preventDefault(); if (k === 'Escape') { clearAll(); return; }
    const next = k === 'Home' ? 0 : k === 'End' ? cfg.n - 1 : (k === 'ArrowLeft' || k === 'ArrowUp') ? Math.max(0, (active < 0 ? 0 : active - 1)) : Math.min(cfg.n - 1, active + 1);
    active = -2; show(next);
  });
  svg.addEventListener('blur', clearAll);
  const outside = (target) => { if (!host.isConnected) { outsideClear.delete(outside); return; } if (active >= 0 && !svg.contains(target)) clearAll(); };
  outsideClear.add(outside);
}
// A chart host draws at the container's real pixel width (and again when it changes), so axis text keeps its natural size on a phone and on a desktop.
function chartHost(draw) {
  const host = h('div', { class: 'chart-wrap' }); let last = 0;
  const paint = () => { const w = Math.max(260, Math.round(host.clientWidth || 340)); if (w === last && host.firstChild) return; last = w; const svg = draw(w); clear(host).append(svg); wireHighlight(host, svg); };
  paint();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => paint()).observe(host);
  return host;
}
// bars: [{ label, short, value|null }]. null = no data: a flat hairline (never a zero-height "0" bar).
export function barChart(bars, opts = {}) { return chartHost((w) => drawBars(w, bars, opts)); }
function drawBars(w, bars, { height = 150, unitLabel = (v) => String(v), ariaLabel = 'Chart' } = {}) {
  const pad = { t: 14, b: 22, l: 6, r: 6 };
  const max = Math.max(1, ...bars.map((b) => (typeof b.value === 'number' ? b.value : 0)));
  const bw = (w - pad.l - pad.r) / Math.max(1, bars.length); const ih = height - pad.t - pad.b;
  const root = sv('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, class: 'chart', role: 'img', 'aria-label': ariaLabel });
  grid(root, w, pad, ih, pad.t);
  const band = sv('rect', { class: 'chart-band', x: 0, y: 10, width: bw, height: Math.max(0, height - 34), rx: 3 }); root.append(band);
  const top = sv('text', { x: w - pad.r, y: pad.t - 4, 'text-anchor': 'end', class: 'axis' }); top.textContent = unitLabel(max); root.append(top);
  const barEls = [];
  bars.forEach((b, i) => {
    const x = pad.l + i * bw;
    if (typeof b.value === 'number') {
      const bh = Math.max(b.value > 0 ? 2 : 0, (b.value / max) * ih);
      const r = sv('rect', { x: x + bw * 0.2, y: pad.t + ih - bh, width: bw * 0.6, height: bh, rx: 2, class: 'bar' });
      const t = sv('title'); t.textContent = `${b.label}: ${unitLabel(b.value)}`; r.append(t); root.append(r); barEls.push(r);
    } else { const r = sv('rect', { x: x + bw * 0.2, y: pad.t + ih - 3, width: bw * 0.6, height: 3, rx: 1.5, class: 'bar-none' }); const t = sv('title'); t.textContent = `${b.label}: no data`; r.append(t); root.append(r); barEls.push(r); }
    const every = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor((w - 12) / 34)))); if (i % every === 0) { const tx = sv('text', { x: x + bw / 2, y: height - 7, 'text-anchor': 'middle', class: 'axis' }); tx.textContent = b.short ?? b.label; root.append(tx); }
  });
  // one transparent column per slot carries the native tooltip over the whole column (not only over the bar itself)
  bars.forEach((b, i) => { const hit = sv('rect', { x: pad.l + i * bw, y: 0, width: bw, height, class: 'chart-hit', fill: 'transparent' }); const t = sv('title'); t.textContent = typeof b.value === 'number' ? `${b.label}: ${unitLabel(b.value)}` : `${b.label}: no data`; hit.append(t); root.append(hit); });
  let lastOn = -1;
  root.petaliHl = {
    n: bars.length, width: w,
    hit: (x) => { const i = Math.floor((x - pad.l) / bw); return i >= 0 && i < bars.length && x >= pad.l && x <= w - pad.r ? i : -1; },
    show: (i) => { band.setAttribute('x', String(pad.l + i * bw)); band.classList.add('on'); if (lastOn >= 0 && barEls[lastOn]) barEls[lastOn].classList.remove('is-active'); if (barEls[i]) barEls[i].classList.add('is-active'); lastOn = i; },
    hide: () => { band.classList.remove('on'); if (lastOn >= 0 && barEls[lastOn]) barEls[lastOn].classList.remove('is-active'); lastOn = -1; },
    tip: (i) => ({ head: bars[i].label, rows: [[typeof bars[i].value === 'number' ? unitLabel(bars[i].value) : 'No data', '']] }),
    centerPx: (i, k) => (pad.l + (i + 0.5) * bw) * k,
  };
  return root;
}
// line: points [{ label, short, avg|null, max|null }]; a gap for missing values.
export function lineChart(points, opts = {}) { return chartHost((w) => drawLines(w, points, opts)); }
function drawLines(w, points, { height = 150, unit = '', ariaLabel = 'Chart' } = {}) {
  const pad = { t: 14, b: 22, l: 6, r: 6 }; const ih = height - pad.t - pad.b;
  const vals = points.flatMap((p) => [p.avg, p.max]).filter((v) => typeof v === 'number');
  const root = sv('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, class: 'chart', role: 'img', 'aria-label': ariaLabel });
  grid(root, w, pad, ih, pad.t);
  if (!vals.length) return root;
  const lo = Math.min(...vals); const hi = Math.max(...vals); const span = Math.max(1e-6, hi - lo);
  const X = (i) => pad.l + (points.length === 1 ? (w - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (w - pad.l - pad.r));
  const Y = (v) => pad.t + (1 - (v - lo) / span) * ih;
  for (const [key, cls] of [['max', 'line-max'], ['avg', 'line-avg']]) {
    let d = '';
    points.forEach((p, i) => { if (typeof p[key] === 'number') d += `${d && !d.endsWith('|') ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p[key]).toFixed(1)}`; else d += '|'; });
    for (const seg of d.split('|').filter(Boolean)) root.append(sv('path', { d: seg, class: cls, fill: 'none' }));
  }
  const t1 = sv('text', { x: w - pad.r, y: pad.t - 4, 'text-anchor': 'end', class: 'axis' }); t1.textContent = `${Math.round(hi)}${unit}`; root.append(t1);
  const guide = sv('line', { class: 'chart-guide', x1: 0, x2: 0, y1: 10, y2: height - 24 }); root.insertBefore(guide, root.querySelector('path'));
  const focus = sv('circle', { class: 'chart-focus', r: 5, cx: 0, cy: 0 });
  points.forEach((p, i) => { if (typeof p.avg === 'number') { const c = sv('circle', { cx: X(i), cy: Y(p.avg), r: 2.8, class: 'dot' }); const t = sv('title'); t.textContent = `${p.label}: ${p.avg}${unit}${typeof p.max === 'number' ? ` (peak ${p.max}${unit})` : ''}`; c.append(t); root.append(c); } });
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor((w - 12) / 40)))); points.forEach((p, i) => { if (i % every === 0) { const tx = sv('text', { x: X(i), y: height - 7, 'text-anchor': 'middle', class: 'axis' }); tx.textContent = p.short ?? p.label; root.append(tx); } });
  root.append(focus);
  const nearest = (x) => { let best = -1; let bd = Infinity; points.forEach((p, i) => { const d = Math.abs(X(i) - x); if (d < bd) { bd = d; best = i; } }); const step = points.length > 1 ? (w - pad.l - pad.r) / (points.length - 1) : w; return bd <= step / 2 + 1 && x >= pad.l - 4 && x <= w - pad.r + 4 ? best : -1; };
  root.petaliHl = {
    n: points.length, width: w, hit: nearest,
    show: (i) => { guide.setAttribute('x1', X(i)); guide.setAttribute('x2', X(i)); guide.classList.add('on'); const v = typeof points[i].avg === 'number' ? points[i].avg : points[i].max; if (typeof v === 'number') { focus.setAttribute('cx', X(i)); focus.setAttribute('cy', Y(v)); focus.classList.add('on'); } else focus.classList.remove('on'); },
    hide: () => { guide.classList.remove('on'); focus.classList.remove('on'); },
    tip: (i) => { const p = points[i]; const rows = []; if (typeof p.avg === 'number') rows.push([`${p.avg}${unit}`, 'average']); if (typeof p.max === 'number') rows.push([`${p.max}${unit}`, 'peak']); if (!rows.length) rows.push(['No data', '']); return { head: p.label, rows }; },
    centerPx: (i, k) => X(i) * k,
  };
  return root;
}
// One Device Health problem in the desktop's .hp style: severity dot + title + level, explanation, measured values, recommendation.
export function problemBox({ level, title, level_text, explanation, meta, action }) {
  return h('li', { class: `problem hp lv-${level === 'critical' ? 'crit' : level === 'warning' ? 'warn' : 'info'}` },
    h('div', { class: 'hp-h' }, h('i', { class: 'hp-dot' }), h('b', { text: title }), h('em', { text: level_text })),
    meta ? h('p', { class: 'hp-v', text: meta }) : null, explanation ? h('p', { class: 'hp-w', text: explanation }) : null, action ? h('p', { class: 'hp-a' }, h('span', { text: 'Recommended: ' }), action) : null);
}
export { DASH };
