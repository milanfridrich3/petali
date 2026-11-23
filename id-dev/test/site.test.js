import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function walk(dir, out = []) { for (const n of readdirSync(dir)) { if (['node_modules', '.git'].includes(n)) continue; const p = join(dir, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }

// -- a small Netlify rules reader/simulator (static files first, then rules in order; "force" rules win over files) --
function parseToml(text) {
  const rules = []; const headers = []; let cur = null; let inValues = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (line === '[[redirects]]') { cur = { force: false }; rules.push(cur); inValues = false; continue; }
    if (line === '[[headers]]') { cur = { values: {} }; headers.push(cur); inValues = false; continue; }
    if (line === '[headers.values]') { inValues = true; continue; }
    const m = /^(\w[\w-]*)\s*=\s*(.+)$/.exec(line); if (!m || !cur) continue;
    const v = m[2].startsWith('"') ? m[2].replace(/^"|"$/g, '') : m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
    (inValues ? cur.values : cur)[m[1]] = v;
  }
  return { rules, headers };
}
const toml = parseToml(read('netlify.toml'));

// -- Netlify request semantics, as documented (docs.netlify.com "Redirect options"):
//    * rules match a path WITHOUT regard to a trailing slash, and a rule cannot add or remove one;
//    * rules run in order; a rule that is not forced applies only when no file matches; a forced rule always applies;
//    * status 200 = rewrite (same URL, other content); 301/302 = redirect; 404 = show 404;
//    * a directory with an index.html requested WITHOUT its trailing slash is redirected to the slash form (Pretty URLs / directory handling).
const unslash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
function fileFor(p, rootDir) { const c = p === '/' ? ['index.html'] : [p.slice(1), `${p.slice(1).replace(/\/$/, '')}/index.html`]; for (const f of c) { const a = join(rootDir, f); if (existsSync(a) && statSync(a).isFile()) return f; } return null; }
const ruleMatches = (from, p) => { const f = unslash(from); const q = unslash(p); return f.endsWith('/*') ? q.startsWith(f.slice(0, -1)) || q === f.slice(0, -2) : f === q; };
function hop(p, rules, rootDir) {
  const exact = p === '/' ? 'index.html' : p.slice(1); const isFile = existsSync(join(rootDir, exact)) && statSync(join(rootDir, exact)).isFile();
  const dirIndex = !isFile && existsSync(join(rootDir, exact, 'index.html')) && p !== '/';
  const hasFile = isFile || dirIndex || p === '/';
  for (const r of rules) {
    if (!ruleMatches(r.from, p) || (hasFile && !r.force)) continue;
    const to = r.to.replace(':splat', p.slice(unslash(r.from).length - 1).replace(/^\//, ''));
    if (r.status === 200) return { served: 'rewrite', status: 200, to, rule: r.from };
    if (r.status >= 300) return { redirect: to, status: r.status, rule: r.from };
    return { status: r.status, rule: r.from };
  }
  if (dirIndex && !p.endsWith('/')) return { redirect: `${p}/`, status: 301, rule: '(directory)' };      // Netlify's own, one-way, directory handling
  const f = fileFor(p, rootDir);
  return f ? { served: 'file', status: 200, file: f } : { status: 404 };
}
// Follows redirects like a browser. Returns the chain and the final answer; throws on a loop (ERR_TOO_MANY_REDIRECTS).
export function request(path, rules = toml.rules, rootDir = ROOT, max = 10) {
  const chain = [path]; let p = path;
  for (let i = 0; i < max; i += 1) {
    const r = hop(p, rules, rootDir);
    if (r.redirect === undefined) return { ...r, chain, final: p };
    if (!r.redirect.startsWith('/')) return { ...r, chain, final: r.redirect };
    p = r.redirect; chain.push(p);
  }
  throw new Error(`ERR_TOO_MANY_REDIRECTS: ${chain.join(' -> ')}`);
}
const resolve = request;

describe('Netlify routing (simulated with Netlify\'s documented rule semantics)', () => {
  it('REGRESSION: the Phase 5 rule "/id -> /id/ (301, forced)" loops on /id and /id/ - the simulator reproduces ERR_TOO_MANY_REDIRECTS', () => {
    const phase5 = [{ from: '/id/api/*', to: 'https://petali-v2.onrender.com/:splat', status: 200, force: true }, { from: '/id', to: '/id/', status: 301, force: true }, { from: '/id/*', to: '/id/index.html', status: 200 }];
    assert.throws(() => request('/id', phase5), /ERR_TOO_MANY_REDIRECTS: \/id -> \/id\/ -> \/id\//);
    assert.throws(() => request('/id/', phase5), /ERR_TOO_MANY_REDIRECTS/);
  });
  it('the shipped configuration has NO redirect rule for the app: nothing under /id can redirect (rewrites only)', () => {
    // (the only non-200 rules for /id are the explicit 404 guards of the removed support route: never a redirect, never the app shell)
    const guard = (x) => /^\/id\/support(\/\*)?$/.test(x.from) && x.status === 404;
    for (const r of toml.rules.filter((x) => x.from.startsWith('/id') && !x.from.startsWith('/id-dev') && !guard(x))) assert.ok(r.status === 200, `${r.from} must be a rewrite (200), not ${r.status}`);
    assert.ok(!existsSync(join(ROOT, '_redirects')), 'no _redirects file may add rules behind the back of netlify.toml');
  });
  it('/support serves the standalone page in one rewrite, and /id/support (any depth) is 404 instead of the app shell', () => {
    const s = request('/support'); assert.equal(s.status, 200); assert.equal(s.to, '/support.html'); assert.equal(s.chain.length, 1); assert.equal(request('/support/').to, '/support.html');
    for (const u of ['/id/support', '/id/support/', '/id/support/x']) { const r = request(u); assert.equal(r.status, 404, u); assert.ok(r.chain.length <= 2 && !r.chain.includes('/support') && !r.chain.includes('/id/index.html'), `${u}: ${r.chain.join(' -> ')}`); }
    assert.equal(request('/id/settings').to, '/id/index.html');
  });
  it('/, /id, /id/ and the nested routes each answer in at most one hop and never loop', () => {
    const urls = ['/', '/id', '/id/', '/id/login', '/id/register', '/id/computers', '/id/computers/3f2b8c1e-5d4a-4e7b-9a10-1c2d3e4f5a6b', '/id/plant', '/id/usage', '/id/health', '/id/reports', '/id/settings', '/id/more', '/id/computers/', '/id/plant/'];
    for (const u of urls) { const r = request(u); assert.equal(r.status, 200, u); assert.equal(r.chain.length, 1, `${u} must not redirect: ${r.chain.join(' -> ')}`); }
  });
  it('the landing page is still served at / (and feedback.html), the app shell at /id and /id/', () => {
    assert.deepEqual([request('/').served, request('/').file], ['file', 'index.html']); assert.equal(request('/feedback.html').file, 'feedback.html');
    for (const u of ['/id', '/id/', '/id/plant', '/id/health', '/id/settings', '/id/whatever/deep']) { const r = request(u); assert.equal(r.to ?? `/${r.file}`, '/id/index.html', u); }
  });
  it('real files are served as files, not rewritten', () => { for (const p of ['/id/sw.js', '/id/manifest.webmanifest', '/id/js/app.js', '/id/css/app.css', '/id/icons/icon-192.png', '/id/vendor/health-text.js']) { const r = request(p); assert.equal(r.served, 'file', p); assert.equal(r.file, p.slice(1), p); } });
  it('the API proxy comes first, is forced and targets the Petali Cloud', () => {
    assert.equal(toml.rules[0].from, '/id/api/*'); assert.equal(toml.rules[0].force, true); assert.equal(toml.rules[0].status, 200);
    const r = request('/id/api/v1/web/session/refresh'); assert.equal(r.to, 'https://petali-v2.onrender.com/v1/web/session/refresh');
  });
  it('there is no /app route and developer files are not served', () => { for (const p of ['/app', '/app/login', '/app/dashboard']) assert.equal(request(p).status, 404, p); assert.equal(request('/id-dev/test/site.test.js').status, 404); assert.equal(request('/id-dev/package.json').status, 404); });
  it('the service worker is never cached and may control exactly /id/', () => {
    const h = toml.headers.find((x) => x.for === '/id/sw.js').values; assert.match(h['Cache-Control'], /no-cache/); assert.equal(h['Service-Worker-Allowed'], '/id/');
    assert.equal(toml.headers.find((x) => x.for === '/id/manifest.webmanifest').values['Content-Type'].split(';')[0], 'application/manifest+json');
    assert.equal(toml.headers.find((x) => x.for === '/id/api/*').values['Cache-Control'], 'no-store');
  });
  it('the app, not the server, moves /id to /id/ (history.replaceState: no HTTP redirect, so no loop possible)', () => {
    const app = read('id/js/app.js'); assert.match(app, /url\.pathname === BASE\) \{ history\.replaceState\(\{\}, '', `\$\{BASE\}\/\$\{url\.search\}`\)/); assert.ok(!/location\.(replace|assign|href\s*=)\([^)]*\/id/.test(app), 'no full-page navigation to /id');
  });
  it('CSP: scripts only from self, no inline script, framing denied, requests only to self', () => {
    const csp = toml.headers.find((x) => x.for === '/id/*').values['Content-Security-Policy'];
    assert.match(csp, /script-src 'self'(;|$)/); assert.ok(!/unsafe-inline|unsafe-eval/.test(csp.split('style-src')[0])); assert.match(csp, /connect-src 'self'/); assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(read('id/index.html')), 'index.html has no inline script');
  });
});

describe('manifest and PWA files', () => {
  const m = JSON.parse(read('id/manifest.webmanifest'));
  it('is a valid, installable manifest that starts at /id/ inside the /id/ scope', () => {
    assert.equal(m.name, 'Petali ID'); assert.ok(m.short_name && m.short_name.length <= 12); assert.equal(m.display, 'standalone'); assert.equal(m.start_url, '/id/'); assert.equal(m.scope, '/id/'); assert.ok(m.start_url.startsWith(m.scope)); assert.equal(m.id, '/id/');
    assert.match(m.theme_color, /^#[0-9a-f]{6}$/i); assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
    const sizes = m.icons.map((i) => i.sizes); assert.ok(sizes.includes('192x192') && sizes.includes('512x512')); assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
    for (const i of m.icons) { assert.ok(existsSync(join(ROOT, i.src.slice(1))), i.src); assert.ok(i.src.startsWith('/id/')); }
    for (const s of m.shortcuts) assert.ok(s.url.startsWith('/id/'));
  });
  it('icons have the declared sizes', () => { for (const i of m.icons) { const b = readFileSync(join(ROOT, i.src.slice(1))); const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)]; assert.equal(`${w}x${h}`, i.sizes, i.src); } });
  it('the shell links the manifest, declares the viewport and mobile metadata, and loads only same-origin scripts', () => {
    const html = read('id/index.html');
    for (const s of ['rel="manifest" href="/id/manifest.webmanifest"', 'viewport-fit=cover', 'name="theme-color"', 'apple-mobile-web-app-capable', 'rel="apple-touch-icon"', 'noindex']) assert.ok(html.includes(s), s);
    for (const m2 of html.matchAll(/<script[^>]*src="([^"]+)"/g)) assert.ok(m2[1].startsWith('/id/'), m2[1]);
  });
  it('the service worker precache list only names files that exist', () => {
    const sw = read('id/sw.js'); const list = [...sw.slice(sw.indexOf('const PRECACHE'), sw.indexOf('];', sw.indexOf('const PRECACHE'))).matchAll(/'(\/[^']+)'/g)].map((x) => x[1]);
    assert.ok(list.length > 20); for (const p of list) assert.ok(existsSync(join(ROOT, p.slice(1))), p);
    for (const f of walk(join(ROOT, 'id/js'))) assert.ok(list.includes(`/${relative(ROOT, f)}`), `${f} is missing from the precache`);
    for (const f of walk(join(ROOT, 'id/vendor'))) assert.ok(list.includes(`/${relative(ROOT, f)}`), `${f} is missing from the precache`);
  });
  it('registers the worker with scope /id/', () => { assert.match(read('id/js/app.js'), /serviceWorker\.register\('\/id\/sw\.js', \{ scope: '\/id\/' \}\)/); });
});

describe('site rules', () => {
  it('there is no /app route anywhere in the site, the app or its configuration', () => {
    const files = walk(ROOT).filter((f) => !f.includes('/id-dev/node_modules') && !f.includes('/id-dev/test/') && /\.(js|html|toml|webmanifest|css|json|txt|xml)$/.test(f) && !f.includes('package-lock'));
    for (const f of files) { const t = readFileSync(f, 'utf8'); assert.ok(!/["'`(=]\/app(\/|["'`)\s])/.test(t) && !/petali\.netlify\.app\/app/.test(t), `${relative(ROOT, f)} refers to /app`); }
  });
  it('the landing page keeps its content and only gains the Open Petali entry points', () => {
    const html = read('index.html'); assert.ok(html.includes('href="/id/"')); assert.equal((html.match(/href="\/id\/"/g) || []).length, 2);
    for (const s of ['id="download"', 'feedback.html', 'og:image', 'class="nav-links"']) assert.ok(html.includes(s), s);
    assert.ok(!/serviceWorker|manifest/.test(html), 'the landing page registers no worker and links no manifest');
  });
  it('no secrets: no .env files, no tokens in source', () => { assert.ok(!walk(ROOT).some((f) => /\.env($|\.)/.test(f) && !f.endsWith('.env.example'))); for (const f of walk(join(ROOT, 'id')).filter((x) => /\.(js|html)$/.test(x))) assert.ok(!/(JWT_[A-Z_]*SECRET|BEGIN (RSA )?PRIVATE KEY|ptr_[A-Za-z0-9]{20})/.test(readFileSync(f, 'utf8')), f); });
  it('the web app never stores credentials in browser storage', () => {
    for (const f of walk(join(ROOT, 'id/js'))) { const t = readFileSync(f, 'utf8'); for (const m2 of t.matchAll(/(localStorage|sessionStorage)\.(setItem|getItem)\(([^)]*)\)/g)) assert.match(m2[3], /THEME_KEY|petali-id-theme|petali-id-schedule/, `${relative(ROOT, f)}: ${m2[0]}`); }
  });
  it('vendored desktop modules are exactly what the desktop sources produce', () => {
    const tool = join(ROOT, '..', 'app-and-cloud', 'tools', 'sync-web-shared.js'); if (!existsSync(tool)) return;
    const r = spawnSync('node', [tool, '--check'], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  });
});

describe('visual identity (Petali desktop design system)', () => {
  const css = read('id/css/app.css');
  const DAY = ['#17312c', '#55706a', '#25664a', '#4b9b72', '#cce8cc', '#f8c768', 'rgba(255,255,255,.65)', 'rgba(35,82,69,.14)', '#c98a1b', '#d04a45', '#f9fbf5', '#d8f1ef', '#ebf5e9', '#f9f7ee'];
  const NIGHT = ['#e5f0ea', '#a9bdb7', '#9fd9b6', '#81c79f', '#244e4b', 'rgba(16,41,54,.48)', 'rgba(201,231,223,.14)', '#e8b04a', '#ef6f6a', '#12303a', '#0c203c', '#153d52', '#1c433c'];
  it('uses the desktop app\'s colour tokens for day and night', () => { for (const t of [...DAY, ...NIGHT]) assert.ok(css.includes(t), `token ${t} missing from app.css`); });
  it('those tokens really are the desktop\'s (checked against renderer/index.html when it is next to this project)', () => {
    const f = join(ROOT, '..', 'app-and-cloud', 'renderer', 'index.html'); if (!existsSync(f)) return;
    const desktop = readFileSync(f, 'utf8').replace(/\s+/g, '').toLowerCase();
    for (const t of [...DAY, ...NIGHT]) assert.ok(desktop.includes(t.toLowerCase().replace(/\s+/g, '')), `${t} is not a desktop token`);
  });
  it('uses the desktop typography (Manrope + DM Mono) and loads exactly those fonts', () => {
    assert.match(css, /--sans:Manrope/); assert.match(css, /--mono:'DM Mono'/); const html = read('id/index.html'); assert.ok(html.includes('family=Manrope') && html.includes('family=DM+Mono')); assert.ok(!/Fraunces|Work\+Sans|Work Sans/.test(css + html));
  });
  it('card, button and segmented-control geometry follow the desktop (20px cards, 13px buttons, 10px segments, blurred surfaces)', () => {
    assert.match(css, /\.card\{[^}]*border-radius:20px/); assert.match(css, /\.btn\{[^}]*border-radius:13px/); assert.match(css, /\.seg-b\{[^}]*border-radius:10px/); assert.match(css, /backdrop-filter:blur\(14px\)/);
  });
  it('day/night is the desktop schedule (vendored theme-schedule.js), applied before first paint and as a class on <html>', () => {
    const html = read('id/index.html'); assert.ok(html.indexOf('/id/vendor/theme-schedule.js') < html.indexOf('/id/js/theme-boot.js') && html.indexOf('/id/js/theme-boot.js') < html.indexOf('/id/css/app.css'));
    assert.match(read('id/js/theme.js'), /PetaliThemeSchedule/); assert.match(css, /html\.night\{/);
  });
  it('icons are the desktop\'s (vendored ICONS table), not hand-drawn ones', () => { assert.ok(read('id/vendor/widget-icons.js').includes('const ICONS')); assert.ok(!/<path d="M3 11l9-8/.test(read('id/js/app.js'))); });
  it('no inline styles are needed (CSP) and every colour in views comes from CSS', () => { for (const f of walk(join(ROOT, 'id/js'))) assert.ok(!/style="|setAttribute\('style'|cssText/.test(readFileSync(f, 'utf8')), f); });
});

// Regression: "only the scrollbar scrolls". overflow-x:hidden on BOTH html and body makes body a scroll container (overflow-y computes to auto), and
// overscroll-behavior-y:none on that body then cuts scroll chaining to the viewport, so wheel / touchpad / touch input is swallowed. The real-browser
// proof is e2e/scroll-check.py; these are the cheap static guards.
describe('native page scrolling (body must never be a scroll container)', () => {
  const css = read('id/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = (sel) => [...css.matchAll(/(?<=^|\})\s*([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel)).map((m) => m[2]).join(';');
  it('body sets no overflow / overflow-y / overscroll-behavior that would turn it into a trapping scroll container', () => {
    const b = decls('body');
    assert.ok(!/(^|;)\s*overflow(-y)?\s*:\s*(hidden|auto|scroll)/.test(b), `body: ${b}`);
    assert.ok(!/overscroll-behavior/.test(b), 'overscroll-behavior belongs on html (the viewport), not on body');
    assert.ok(!/overflow-x\s*:\s*(hidden|auto|scroll)/.test(b), 'body overflow-x must be clip (no scroll container) - hidden/auto/scroll force overflow-y:auto');
  });
  it('no shared "html,body" rule sets overflow-x hidden (it makes body a scroll container)', () => {
    assert.ok(!/(^|\})\s*html\s*,\s*body\s*\{[^}]*overflow/.test(css) && !/(^|\})\s*body\s*,\s*html\s*\{[^}]*overflow/.test(css));
  });
  it('horizontal overflow is still contained on the viewport (html) and clipped on body', () => {
    assert.match(decls('html'), /overflow-x\s*:\s*hidden/); assert.match(css, /@supports\s*\(overflow:\s*clip\)\s*\{\s*body\s*\{\s*overflow-x\s*:\s*clip/);
  });
  it('no scroll-blocking script: no wheel/touch listeners and no preventDefault on scroll events in the app', () => {
    for (const f of walk(join(ROOT, 'id/js'))) { const t = readFileSync(f, 'utf8'); assert.ok(!/addEventListener\(\s*['"](wheel|mousewheel|touchstart|touchmove|scroll)['"]/.test(t), relative(ROOT, f)); assert.ok(!/['"](wheel|touchmove)['"][^;]*preventDefault/.test(t), relative(ROOT, f)); }
    assert.ok(!/touch-action\s*:\s*none/.test(css), 'touch-action:none blocks swipe scrolling');
  });
});
