/* Petali ID service worker. Scope: /id/ only (see manifest + Netlify headers); it never sees the marketing site.
 *
 * WHAT IT CACHES (explicit allow-list): the app shell - /id/index.html, the stylesheet, the JavaScript modules, the vendored desktop modules, the
 * manifest, the icons and the logo. Nothing else.
 * WHAT IT NEVER TOUCHES: /id/api/* (every API response, the session endpoints, tokens, cookies - always straight to the network), non-GET requests,
 * other origins, and any page outside /id/. Account data is NOT cached here at all: the app keeps its own account-tagged copies in IndexedDB,
 * which logout and account switching wipe.
 * NAVIGATION: network first (4 s), then the cached shell, so every /id/... route opens offline and always shows the app, never the landing page. */
const VERSION = 'v4-1.5.0';      // bumping this drops every older cached shell, so an installed PWA never keeps running an outdated theme/auth script
const PREFIX = 'petali-id-';
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const SHELL_ENTRY = '/id/index.html';
const PRECACHE = [
  '/id/index.html', '/id/manifest.webmanifest', '/id/css/app.css',
  '/id/js/app.js', '/id/js/api.js', '/id/js/cache.js', '/id/js/data.js', '/id/js/format.js', '/id/js/router.js', '/id/js/session.js', '/id/js/ui.js', '/id/js/theme.js', '/id/js/auth-rules.js', '/id/js/version.js',
  '/id/js/view-kit.js', '/id/js/views-auth.js', '/id/js/views-main.js', '/id/js/views-more.js',
  '/id/vendor/health-text.js', '/id/vendor/plant-visuals.js', '/id/vendor/plant-species.js', '/id/vendor/app-categories.js', '/id/vendor/app-names.js', '/id/vendor/theme-schedule.js', '/id/vendor/widget-icons.js', '/id/js/theme-boot.js',
  '/id/icons/icon-192.png', '/id/icons/apple-touch-icon.png', '/logo-mark.png',
];
const NAV_TIMEOUT_MS = 4000;
const isIdPath = (p) => p === '/id' || p.startsWith('/id/');
const isApi = (p) => p.startsWith('/id/api/') || p === '/id/api';
const isShellAsset = (p) => PRECACHE.includes(p) || /^\/id\/(js|css|vendor|icons)\//.test(p);

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(PRECACHE.map(async (url) => { const res = await fetch(new Request(url, { cache: 'reload' })); if (!res.ok) throw new Error(`precache ${url}: ${res.status}`); await cache.put(url, res); }));
}

self.addEventListener('install', (event) => { event.waitUntil(precache().then(() => self.skipWaiting())); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== SHELL_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); }); }

async function navigate(request) {
  try {
    const res = await withTimeout(fetch(request), NAV_TIMEOUT_MS);
    const type = res.headers && res.headers.get && res.headers.get('content-type') || '';
    if (res.ok && !res.redirected && /text\/html/.test(type)) { const cache = await caches.open(SHELL_CACHE); await cache.put(SHELL_ENTRY, res.clone()); }
    return res;
  } catch {
    const cached = await caches.match(SHELL_ENTRY, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    return new Response('Petali ID is offline and has not been opened on this device yet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function staticAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((res) => { if (res.ok && res.type === 'basic') cache.put(request, res.clone()); return res; });
  if (cached) { refresh.catch(() => {}); return cached; }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url.pathname)) return;                                   // never intercepted, never cached
  if (req.mode === 'navigate') { if (isIdPath(url.pathname)) event.respondWith(navigate(req)); return; }     // the landing page and everything else: untouched
  if (url.pathname === '/id/sw.js' || !isShellAsset(url.pathname)) return;
  event.respondWith(staticAsset(req));
});

// The page asks for a clean slate on logout / account switch. (No account data is stored here; this also drops stale shell copies.)
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'clear-caches') return;
  event.waitUntil((async () => { for (const key of await caches.keys()) if (key.startsWith(PREFIX)) await caches.delete(key); try { await precache(); } catch { /* the next online visit rebuilds it */ } })());
});
