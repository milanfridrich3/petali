// Support Petali exists ONLY as the standalone public page /support. Petali ID has no support page (/id/support does not exist) and the page's code is not nested under id/.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { matchRoute } from '../../id/js/router.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const walk = (d) => readdirSync(d).flatMap((n) => { if (n === 'node_modules' || n === '.git') return []; const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const toml = read('netlify.toml');
const OLD = ['/id', 'support'].join('/');                  // the removed route, assembled so that this test does not contain it literally
const rules = [...toml.matchAll(/\[\[redirects\]\]\s+from = "([^"]+)"\s+to = "([^"]+)"\s+status = (\d+)(\s+force = true)?/g)].map((m) => ({ from: m[1], to: m[2], status: Number(m[3]), force: !!m[4] }));

describe('Support Petali is a standalone public page at /support', () => {
  it('/support is a forced 200 rewrite to support.html (the clean URL stays in the address bar)', () => {
    const r = rules.find((x) => x.from === '/support'); assert.ok(r); assert.deepEqual(r, { from: '/support', to: '/support.html', status: 200, force: true }); assert.ok(existsSync(join(ROOT, 'support.html')));
  });
  it('the shared payment code lives in the neutral support-assets/ folder, not under id/', () => {
    for (const f of ['support-rules.js', 'support-epc.js', 'support-qr.js', 'qrcode-generator.js', 'LICENSE-qrcode-generator.txt']) { assert.ok(existsSync(join(ROOT, 'support-assets', f)), f); assert.ok(!existsSync(join(ROOT, 'id/js', f)) && !existsSync(join(ROOT, 'id/vendor', f)), `${f} must not remain under id/`); }
  });
  it('the standalone page, its script and its assets do not import from, link to or mention Petali ID', () => {
    const files = ['support.html', 'support-page.js', ...walk(join(ROOT, 'support-assets')).map((p) => relative(ROOT, p)).filter((f) => /\.js$/.test(f))];
    for (const f of files) {
      const s = read(f);
      assert.ok(!/from\s+['"][^'"]*\bid\//.test(s) && !/import\s*\(/.test(s) && !/['"]\.\.\/id\b/.test(s), `${f} imports from id/`);
      assert.ok(!/(href|src|from)\s*=?\s*['"]\/?id\//.test(s) && !/\/id\//.test(s.replace(/\/\/.*$/gm, '')), `${f} references /id/`);
    }
  });
  it('nothing under id/ imports the support code, and the service worker does not cache it', () => {
    for (const f of walk(join(ROOT, 'id')).filter((p) => /\.(js|html|webmanifest)$/.test(p))) assert.ok(!/support-(rules|epc|qr)|views-support|qrcode|Support Petali|\/support\b|support-config/i.test(readFileSync(f, 'utf8')), `${relative(ROOT, f)} mentions the support page`);
    assert.ok(!existsSync(join(ROOT, 'id/js/views-support.js')));
  });
  it('support-config.json is generated at the website root (not under id/) and is never cached', () => {
    assert.ok(existsSync(join(ROOT, 'support-config.json'))); assert.ok(!existsSync(join(ROOT, 'id/support-config.json')));
    assert.match(read('tools/generate-support-config.mjs'), /join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', 'support-config\.json'\)/);
    assert.match(toml, /for = "\/support-config\.json"\s+\[headers\.values\]\s+Cache-Control = "no-store"/);
  });
});

describe('the old Petali ID support route is gone', () => {
  it('/id/support (and below it) is a forced 404 rule, placed BEFORE the /id/* app-shell rule, and is never redirected', () => {
    const i1 = rules.findIndex((x) => x.from === OLD), i2 = rules.findIndex((x) => x.from === `${OLD}/*`), catchAll = rules.findIndex((x) => x.from === '/id/*');
    assert.ok(i1 >= 0 && i2 >= 0 && catchAll >= 0); assert.ok(i1 < catchAll && i2 < catchAll, 'must precede /id/*');
    for (const i of [i1, i2]) assert.deepEqual({ to: rules[i].to, status: rules[i].status, force: rules[i].force }, { to: '/404.html', status: 404, force: true });
    assert.ok(!rules.some((x) => x.status >= 300 && x.status < 400 && (x.from.startsWith(OLD) || x.from === '/support.html' && false)), 'no redirect of the old route');
  });
  it('the app router has no support route: the path is "notfound" inside Petali ID', () => { assert.equal(matchRoute(OLD).name, 'notfound'); assert.equal(matchRoute(`${OLD}/`).name, 'notfound'); });
  it('no source file in the website project references the removed route', () => {
    // The only mentions allowed are the 404 guards that make the route NOT exist (Netlify rules, the two local stand-in servers) and the browser rehearsal that checks the 404.
    const GUARDS = ['netlify.toml', 'id-dev/dev-server.mjs', 'id-dev/e2e/rehearsal-server.mjs', 'id-dev/e2e/rehearsal-browser.py', 'id-dev/test/site.test.js', 'id-dev/test/support-standalone.test.js'];
    const hits = walk(ROOT).filter((p) => /\.(js|mjs|json|toml|html|md|ts|txt|py|sh|webmanifest|css)$/.test(p) && !/package-lock/.test(p)).map((p) => relative(ROOT, p)).filter((f) => read(f).includes(OLD));
    assert.deepEqual(hits.filter((f) => !GUARDS.includes(f)), []);
    for (const f of ['id-dev/dev-server.mjs', 'id-dev/e2e/rehearsal-server.mjs']) assert.match(read(f), /404/);
  });
});
