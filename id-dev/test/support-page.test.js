// The standalone public Support page (support.html + support-page.js) and the marketing-site changes (Lite download, Support navigation).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, before } from 'node:test';
import { JSDOM } from 'jsdom';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const READY = { enabled: true, currency: 'EUR', recipientName: 'Example Recipient', iban: 'CZ6508000000192000145399', bic: 'GIBACZPX', reference: 'Petali support' };

describe('marketing site: downloads, navigation, footer', () => {
  const index = read('index.html');
  const FULL = 'https://github.com/milanfridrich3/petali/releases/latest/download/Petali_Setup.exe';
  const LITE = 'https://github.com/milanfridrich3/petali/releases/latest/download/Petali_Setup_Lite.exe';
  const anchor = (href) => new RegExp(`<a ([^>]*)href="${href.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"([^>]*)>([\\s\\S]*?)</a>`).exec(index);
  it('the full download keeps the exact label "Download Petali" and the exact URL', () => {
    const a = anchor(FULL); assert.ok(a); assert.equal(a[3].replace(/<svg[\s\S]*?<\/svg>/, '').trim(), 'Download Petali'); assert.match(a[1] + a[2], /class="btn only-desktop"/);
  });
  it('the Lite download is next to it, labelled exactly "Download Petali Lite", with the exact URL, and is visually secondary', () => {
    const a = anchor(LITE); assert.ok(a); assert.equal(a[3].trim(), 'Download Petali Lite'); assert.match(a[1] + a[2], /btn btn-lite only-desktop/);
    assert.ok(index.indexOf(LITE) > index.indexOf(FULL) && index.indexOf(LITE) - index.indexOf(FULL) < 900, 'adjacent');
    assert.match(index, /\.download \.btn-lite\{background:transparent;/); assert.equal((index.match(/Petali_Setup_Lite\.exe/g) || []).length, 1); assert.equal((index.match(/releases\/latest\/download\/Petali_Setup\.exe/g) || []).length, 1);
    assert.match(index, /Petali Lite: Smaller installer · no administrator rights · limited sensor monitoring/);
  });
  it('Support is in the navigation next to Feedback, and the footer link goes to /support (not into Petali ID)', () => {
    assert.match(index, /<a href="feedback\.html">Feedback<\/a>\s*<a href="\/support">Support<\/a>/);
    assert.match(index, /<a href="\/support"[^>]*>Support Petali \(optional, one-time\)<\/a>/); assert.ok(!/href="[^"]*\/id\/support/.test(index)); assert.ok(!/href="support\.html"/.test(index));
  });
});

describe('support.html: public, standalone, independent of Petali ID', () => {
  const html = read('support.html'); const js = read('support-page.js');
  it('is modelled on the Feedback page (same header, fonts, card styling) with support-specific copy', () => {
    const fb = read('feedback.html');
    for (const k of ['--leaf-dark', 'class="back-link"', 'class="mark"', 'beta-tag', 'Fraunces', 'class="card"', 'class="intro"']) assert.ok(html.includes(k) && fb.includes(k), k);
    assert.match(html, /<title>Support Petali — Petali<\/title>/); assert.match(html, /Voluntary/); assert.match(html, /does not unlock features and is not the purchase of a product/); assert.match(html, /Petali cannot see whether a payment was made/);
  });
  it('does not use or mention Petali ID, login, accounts state, cookies, storage, the Petali API or the desktop app', () => {
    for (const [name, src] of [['support.html', html], ['support-page.js', js.replace(/\/\/.*$/gm, '')]]) assert.ok(!/\/id\/|petali id|session|(?<!bank-)login|sign in|accessToken|cookie|localStorage|sessionStorage|indexedDB|\/v1\/|ui\.js|router\.js|petaliAPI/i.test(src), name);
    assert.match(js, /credentials: 'omit'/); assert.match(js, /referrerPolicy: 'no-referrer'/); assert.ok(!/<a[^>]*href="\/?id\//.test(html), 'no link into Petali ID');
  });
  it('reuses the existing payment implementation instead of creating another', () => {
    assert.match(js, /from '\.\/support-assets\/support-rules\.js'/); assert.match(js, /from '\.\/support-assets\/support-epc\.js'/); assert.match(js, /from '\.\/support-assets\/support-qr\.js'/);
    assert.ok(!/BCD|SCT|mod ?97|% 97|qrcode\(/.test(js), 'no second EPC/IBAN/QR implementation');
  });
  it('reads the one deployment configuration', () => { assert.match(js, /CONFIG_URL = '\/support-config\.json'/); });
});

describe('support-page.js in a DOM', () => {
  let dom; let initSupportPage;
  before(async () => {
    dom = new JSDOM(read('support.html').replace(/<script type="module"[^>]*><\/script>/, ''), { url: 'https://petali.netlify.app/support', pretendToBeVisual: true });
    globalThis.document = dom.window.document; dom.window.__PETALI_SUPPORT_TEST__ = true;
    ({ initSupportPage } = await import('../../support-page.js'));
  });
  const calls = [];
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError('bad'); return body; } });
  const mount = async (fetchImpl) => { dom.window.document.getElementById('supportApp').innerHTML = ''; const p = initSupportPage(dom.window.document, { fetchImpl: async (u, i) => { calls.push({ u, i }); return fetchImpl(u, i); } }); await new Promise((r) => setTimeout(r, 20)); return p; };
  const text = () => dom.window.document.getElementById('supportApp').textContent.replace(/\s+/g, ' ');
  const pickRadio = (v) => { const i = dom.window.document.getElementById(`amt-${v}`); i.checked = true; i.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const type = (v) => { const i = dom.window.document.getElementById('support-custom'); i.value = v; i.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const $ = (s) => dom.window.document.querySelector(s);

  it('safe disabled state: "available soon", no QR code, no amount choices (disabled, missing, bad JSON, non-EUR, invalid IBAN)', async () => {
    for (const r of [resp(200, { enabled: false }), resp(404, {}), resp(200, undefined), resp(200, { ...READY, currency: 'USD' }), resp(200, { ...READY, iban: 'CZ6508000000192000145398' })]) {
      await mount(async () => r); assert.match(text(), /Support will be available soon/); assert.equal($('.qr-code'), null); assert.equal($('.chips'), null);
    }
  });
  it('enabled: quick amounts, a custom EUR amount, the QR code with amount and currency, and copyable payment details', async () => {
    calls.length = 0; await mount(async () => resp(200, READY));
    assert.equal(calls.length, 1); assert.equal(calls[0].u, '/support-config.json'); assert.equal(calls[0].i.credentials, 'omit'); assert.equal(calls[0].i.cache, 'no-store');
    assert.ok($('.chips') && $('#amt-custom')); for (const c of [300, 500, 1000, 2500]) assert.ok($(`#amt-${c}`), String(c));
    pickRadio(1000); assert.ok($('.qr-code')); assert.match($('.qr-code').getAttribute('aria-label'), /10\.00 EUR/); assert.match(text(), /10\.00 EUR/);
    for (const k of ['Recipient', 'IBAN', 'BIC', 'Amount', 'Message']) assert.ok([...dom.window.document.querySelectorAll('.pay-k')].some((e) => e.textContent === k), k);
    assert.match(text(), /CZ65 0800 0000 1920 0014 5399/); assert.equal(dom.window.document.querySelectorAll('.copy').length, 5);
    assert.ok(!/received|completed|payment successful|thank you for your payment/i.test(text()), 'never claims a payment happened');
  });
  it('custom amount: localized decimals, friendly validation, QR only for a valid amount', async () => {
    await mount(async () => resp(200, READY)); pickRadio('custom'); type('12,5'); assert.match(text(), /12\.50 EUR/); assert.ok($('.qr-code'));
    for (const [v, re] of [['0', /greater than zero|smallest/], ['-3', /positive/], ['abc', /digits only/], ['5,5555', /two decimal/], ['5000', /largest/]]) { type(v); assert.equal($('.qr-code'), null, v); assert.match($('#support-custom-error').textContent, re, v); }
    type('25.00'); assert.match(text(), /25\.00 EUR/);
  });
  it('only the static configuration is requested: no account, session or API request is made, and nothing is stored', async () => {
    calls.length = 0; await mount(async () => resp(200, READY)); pickRadio(500); type('');
    assert.ok(calls.every((c) => c.u === '/support-config.json')); assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.document.cookie, '');
  });
  it('configuration unreachable: a friendly message and a working retry', async () => {
    let up = false; const p = await mount(async () => { if (!up) throw new TypeError('offline'); return resp(200, READY); });
    assert.match(text(), /could not be loaded/); up = true; [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Try again').click(); await new Promise((r) => setTimeout(r, 20)); assert.ok($('.chips')); p.stop();
  });
});
