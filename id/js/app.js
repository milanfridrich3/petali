// Petali ID application shell: routing, navigation, global banners, theme, install prompt, service worker.
import { createApi } from './api.js';
import { createCache } from './cache.js';
import { createSession } from './session.js';
import { createData } from './data.js';
import { createTheme } from './theme.js';
import { BASE, matchRoute, loginUrl, nextFromSearch } from './router.js';
import { h, clear, icon, brandMark } from './ui.js';
import { authView, verifyView, verificationNotice, resendButton, EMAIL_CONFIRMATION_AVAILABLE } from './views-auth.js';
import { dashboardView, computersView, computerView, plantView } from './views-main.js';
import { usageView, healthView, reportsView, settingsView, moreView, notFoundView } from './views-more.js';

const root = document.getElementById('app');
const cache = createCache();
let ctx;
let current = null;          // { stop() } of the view on screen
let slowNotice = false;
const api = createApi({ onSlow: () => { slowNotice = true; paintBanner(); }, onAuthLost: () => session.authLost() });
let langFor = null;
let pendingNotice = null;      // { kind, text, at } from the register response, shown in the banner for a few minutes
const session = createSession({ api, cache, beforeAdopt: (r) => { pendingNotice = r && r.emailVerification ? { ...verificationNotice(r.emailVerification, r.user && r.user.email), at: Date.now() } : null; }, onChange: (st) => { if (st.user && langFor !== `${st.status}:${st.user.petaliId}`) { langFor = `${st.status}:${st.user.petaliId}`; loadLanguage(); loadAppearance(); } if (st.status === 'anonymous') theme.setSchedule(null); route(); } });
const data = createData({ api, cache, session });

const NAV = [
  ['dashboard', `${BASE}/`, 'Dashboard', 'activeApps'],
  ['computers', `${BASE}/computers`, 'Computers', 'computerStatus'],
  ['plant', `${BASE}/plant`, 'Plant', 'plant'],
  ['usage', `${BASE}/usage`, 'Usage', 'sensors'],
  ['more', `${BASE}/more`, 'More', null],
];
const MORE_ICON = '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>';
const MORE_ROUTES = new Set(['more', 'health', 'reports', 'settings']);

const shell = {
  header: h('header', { class: 'topbar' }), main: h('main', { id: 'view', tabindex: '-1' }), nav: h('nav', { class: 'tabbar', 'aria-label': 'Petali ID' }), banner: h('div', { class: 'banners', role: 'status', 'aria-live': 'polite' }),
};

function navIcon(name) { if (name) return icon(name); const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('aria-hidden', 'true'); for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) e.setAttribute(k, v); e.innerHTML = MORE_ICON; return e; }

// The PWA scope is /id/, so the dashboard's address inside the app is always /id/ (never the out-of-scope /id).
const inScope = (p) => (p === BASE ? `${BASE}/` : p.startsWith(`${BASE}?`) ? `${BASE}/${p.slice(BASE.length)}` : p);
function navigate(rawPath, { replace = false } = {}) {
  const path = inScope(rawPath); if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path); route(); }

function paintChrome(routeInfo) {
  const st = session.state(); const authed = st.status === 'authenticated' || st.status === 'offline';
  clear(shell.header).append(h('a', { class: 'brand', href: `${BASE}/`, 'aria-label': 'Petali ID' }, brandMark(), 'petali', h('span', { class: 'brand-badge', text: 'ID' })), ...(authed && st.user ? [h('span', { class: 'who', text: st.user.displayName || st.user.email || '' })] : []));   // never append null: Element.append would write the text "null"
  clear(shell.nav);
  if (authed && !routeInfo.public) for (const [name, href, label, ic] of NAV) shell.nav.append(h('a', { href, class: 'tab', 'aria-current': routeInfo.name === name || (name === 'more' && MORE_ROUTES.has(routeInfo.name)) || (name === 'computers' && routeInfo.name === 'computer') ? 'page' : null }, navIcon(ic), h('span', { text: label })));
  shell.nav.hidden = !(authed && !routeInfo.public);
  document.body.classList.toggle('has-nav', authed && !routeInfo.public);
  document.body.classList.toggle('is-auth', routeInfo.name === 'login' || routeInfo.name === 'register' || st.status === 'unreachable');
}

function paintBanner() {
  const st = session.state(); clear(shell.banner);
  if (st.status === 'offline') shell.banner.append(h('div', { class: 'banner banner-warn' }, 'The Petali server cannot be reached. You are seeing saved copies; nothing here is live.', h('button', { class: 'link', type: 'button', onclick: () => session.retry() }, 'Try again')));
  else if (typeof navigator !== 'undefined' && navigator.onLine === false) shell.banner.append(h('div', { class: 'banner banner-warn' }, 'You are offline. Saved copies are shown where available; nothing here is live.'));
  else if (slowNotice) shell.banner.append(h('div', { class: 'banner' }, 'The Petali server is waking up. This can take up to a minute.'));
  if (st.status === 'authenticated' && st.user && st.user.emailVerified === false) shell.banner.append(verifyBanner());
}

// "Confirm your email" strip for an account whose email is not confirmed yet. Says what the server really did with the registration email.
function verifyBanner() {
  if (pendingNotice && Date.now() - pendingNotice.at > 300000) pendingNotice = null;
  // This release has no email service: say so plainly, offer nothing that cannot work, and never block anything.
  if (!EMAIL_CONFIRMATION_AVAILABLE) return h('div', { class: 'banner verify-banner' }, h('span', { class: 'vb-msg', role: 'status' }, pendingNotice ? pendingNotice.text : 'Your email is not confirmed yet. Email confirmation is not available yet; Petali ID works normally in the meantime.'));
  const msg = h('span', { class: 'vb-msg', role: 'status' }, pendingNotice ? pendingNotice.text : 'Confirm your email address to finish setting up your Petali ID.');
  const box = h('div', { class: `banner verify-banner ${pendingNotice && pendingNotice.kind === 'warn' ? 'banner-warn' : ''}` }, msg, ' ', resendButton(ctx, { label: 'Send a new link', onDone: (k, t) => { msg.textContent = t; box.classList.toggle('banner-warn', k !== 'ok'); } }));
  return box;
}
async function route() {
  const url = new URL(location.href); const r = matchRoute(url.pathname);
  if (r.name === 'outside') { location.replace(url.pathname); return; }
  if (url.pathname === BASE) { history.replaceState({}, '', `${BASE}/${url.search}`); return route(); }
  const st = session.state();
  if (st.status === 'booting') { clear(shell.main).append(h('div', { class: 'splash' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { text: 'Opening Petali ID…' }))); paintChrome({ public: true, name: 'boot' }); return; }
  const authed = st.status === 'authenticated' || st.status === 'offline';
  if (!authed && !r.public && st.status !== 'unreachable') { navigate(loginUrl(url.pathname + url.search), { replace: true }); return; }
  if (authed && r.public && !r.always) { navigate(nextFromSearch(url.search), { replace: true }); return; }
  if (current) { current.stop(); current = null; }
  paintChrome(r); paintBanner();
  const params = { route: r, search: url.searchParams };
  let view;
  if (st.status === 'unreachable') view = authView(ctx, { mode: 'unreachable', next: BASE });
  else switch (r.name) {
    case 'login': view = authView(ctx, { mode: 'login', next: nextFromSearch(url.search), search: url.searchParams }); break;
    case 'register': view = authView(ctx, { mode: 'register', next: nextFromSearch(url.search), search: url.searchParams }); break;
    case 'verify': view = verifyView(ctx, params); break;
    case 'dashboard': view = dashboardView(ctx, params); break;
    case 'computers': view = computersView(ctx, params); break;
    case 'computer': view = computerView(ctx, params); break;
    case 'plant': view = plantView(ctx, params); break;
    case 'usage': view = usageView(ctx, params); break;
    case 'health': view = healthView(ctx, params); break;
    case 'reports': view = reportsView(ctx, params); break;
    case 'settings': view = settingsView(ctx, params); break;
    case 'more': view = moreView(ctx, params); break;
    default: view = notFoundView(ctx);
  }
  current = view; clear(shell.main).append(view.el);
  document.title = `${view.title || 'Petali ID'} · Petali ID`;
  shell.main.focus({ preventScroll: true }); window.scrollTo(0, 0);
}

// ---- theme: Automatic / Day / Night, see js/theme.js (the schedule comes from the desktop app's setting, default 22:00-06:00) ----
export const theme = createTheme();

// ---- install ----
const install = { deferred: null, listeners: new Set() };
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ua = navigator.userAgent || '';
export const installInfo = {
  isStandalone: standalone,
  isIos: () => /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1),
  canPrompt: () => !!install.deferred,
  async prompt() { const d = install.deferred; if (!d) return 'unavailable'; install.deferred = null; d.prompt(); const c = await d.userChoice; install.listeners.forEach((f) => f()); return c.outcome; },
  onChange(f) { install.listeners.add(f); return () => install.listeners.delete(f); },
};
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); install.deferred = e; install.listeners.forEach((f) => f()); });
window.addEventListener('appinstalled', () => { install.deferred = null; install.listeners.forEach((f) => f()); });

// ---- start ----
ctx = { api, cache, session, data, navigate, installInfo, theme, language: 'en', onlineNow: () => navigator.onLine !== false };
document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download')) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || (u.pathname !== BASE && !u.pathname.startsWith(`${BASE}/`))) return;     // the landing page and everything else: normal navigation
  e.preventDefault(); navigate(u.pathname + u.search);
});
window.addEventListener('popstate', route);
window.addEventListener('online', () => { slowNotice = false; paintBanner(); session.retry().then(() => route()); });
window.addEventListener('offline', paintBanner);
theme.start();
root.append(h('div', { class: 'stars', 'aria-hidden': 'true' }), shell.header, shell.banner, shell.main, shell.nav);
route();
// the account language (cs/en) selects the wording of Device Health texts; a saved copy is used when offline
async function loadAppearance() {      // the night schedule the user set in the desktop app; keeps the last known one when the server cannot be reached
  try { if (session.state().status !== 'authenticated') return; const r = await api.get('/v1/web/appearance'); theme.setSchedule(r && r.autoNight ? r.autoNight : null); } catch { /* keep what is saved */ }
}
async function loadLanguage() {
  try { if (session.state().status === 'authenticated') { const r = await api.get('/v1/account/settings'); ctx.language = r.settings.language || 'en'; await cache.setMeta('language', ctx.language); } else ctx.language = (await cache.getMeta('language')) || 'en'; } catch { ctx.language = (await cache.getMeta('language')) || 'en'; }
}
session.boot().then(() => { slowNotice = false; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/id/sw.js', { scope: '/id/' }).catch(() => { /* the app works without it */ });
