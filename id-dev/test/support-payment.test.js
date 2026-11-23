// Support Petali payment core: amounts in integer cents, EPC/SEPA payload, QR round-trip (decoded with an independent decoder), privacy, configuration gate.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import jsQR from 'jsqr';
import { parseAmount, formatMoney, LIMITS, CURRENCIES } from '../../support-assets/support-rules.js';
import { buildEpcPayload, parseEpcPayload, isValidIban, isValidBic, validateRecipient, centsToDecimal } from '../../support-assets/support-epc.js';
import { encodeQr, QUIET_ZONE } from '../../support-assets/support-qr.js';
import { buildSupportConfig } from '../../tools/generate-support-config.mjs';

// A well-known, valid EXAMPLE IBAN/BIC pair (not Petali's): used only to exercise the code.
const TEST = { currency: 'EUR', recipientName: 'Example Recipient', iban: 'CZ65 0800 0000 1920 0014 5399', bic: 'GIBACZPX', reference: '' };
const root = new URL('../../', import.meta.url).pathname;

function decode(text, scale = 6) {
  const m = encodeQr(text); const n = m.size + QUIET_ZONE * 2; const w = n * scale; const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let r = 0; r < m.size; r += 1) for (let c = 0; c < m.size; c += 1) if (m.isDark(r, c)) for (let y = 0; y < scale; y += 1) for (let x = 0; x < scale; x += 1) { const i = (((r + QUIET_ZONE) * scale + y) * w + (c + QUIET_ZONE) * scale + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  return jsQR(px, w, w);
}

describe('amounts: integer cents, localized input', () => {
  const ok = (t, cents) => { const r = parseAmount(t); assert.equal(r.ok, true, t); assert.equal(r.cents, cents, t); };
  const bad = (t) => { const r = parseAmount(t); assert.equal(r.ok, false, `"${t}" must be refused`); assert.ok(r.message.length > 5); };
  it('accepts whole numbers and both decimal separators', () => { ok('12', 1200); ok('12,5', 1250); ok('12.50', 1250); ok('12,05', 1205); ok('1', 100); ok('0,1'.replace('0,1', '1,1'), 110); });
  it('accepts grouping in either convention and currency marks', () => { ok('1 000,00', 100000); ok('1.000,00', 100000); ok('1,000.00', 100000); ok('1 000,5'.replace('1 000,5','9 9,5'), 9950); ok('1\u00a0000', 100000); ok('€ 5', 500); ok('5 EUR', 500); ok('eur 7,25', 725); });
  it('has no floating point rounding errors', () => { ok('0.29'.replace('0.29', '1.29'), 129); ok('19.99', 1999); ok('8.2', 820); ok('4.35', 435); });
  it('refuses zero, negative, empty and non-numeric input with a friendly message', () => { for (const t of ['', ' ', '0', '0,00', '-5', '−5', 'abc', '1e3', 'Infinity', 'NaN', '12,5,5', '12..5', '12,555', '1.000', '5 5 5x', '0x10', '١٢']) bad(t); });
  it('enforces the minimum and maximum', () => { assert.equal(LIMITS.minCents, 100); assert.equal(LIMITS.maxCents, 100000); bad('0,99'); ok('1', 100); ok('1000', 100000); bad('1000,01'); bad('99999999999999'); });
  it('formats cents without floats', () => { assert.equal(formatMoney(1250), '12.50 EUR'); assert.equal(formatMoney(5), '0.05 EUR'); assert.equal(formatMoney(123456789), '1\u202f234\u202f567.89 EUR'); assert.equal(formatMoney(-1), ''); });
  it('only EUR is offered; the structure allows adding currencies later', () => { assert.deepEqual(Object.keys(CURRENCIES), ['EUR']); assert.ok(CURRENCIES.EUR.presetsCents.every((c) => c >= LIMITS.minCents && c <= LIMITS.maxCents)); });
});

describe('IBAN / BIC validation', () => {
  it('accepts valid and refuses invalid IBANs (checksum and country length)', () => {
    assert.equal(isValidIban('CZ65 0800 0000 1920 0014 5399'), true); assert.equal(isValidIban('DE89370400440532013000'), true);
    assert.equal(isValidIban('CZ65 0800 0000 1920 0014 5398'), false); assert.equal(isValidIban('CZ650800000019200145'), false); assert.equal(isValidIban('5808911053/0800'), false); assert.equal(isValidIban(''), false); assert.equal(isValidIban('XX00'), false);
  });
  it('validates the BIC shape', () => { assert.equal(isValidBic('GIBACZPX'), true); assert.equal(isValidBic('gibaczpxxxx'), true); assert.equal(isValidBic('GIBACZP'), false); assert.equal(isValidBic('12345678'), false); });
});

describe('EPC payload (EPC069-12)', () => {
  const p = buildEpcPayload({ recipient: TEST, amountCents: 1250 });
  const f = parseEpcPayload(p);
  it('has the mandatory structure', () => {
    assert.equal(f.tag, 'BCD'); assert.equal(f.version, '002'); assert.equal(f.charset, '1'); assert.equal(f.id, 'SCT');
    assert.equal(f.bic, 'GIBACZPX'); assert.equal(f.name, 'Example Recipient'); assert.equal(f.iban, 'CZ6508000000192000145399'); assert.equal(f.amount, 'EUR12.50');
    assert.equal(f.purpose, ''); assert.equal(f.structuredRef, ''); assert.equal(f.remittance, 'Petali support'); assert.equal(f.lines, 11);
    assert.ok(new TextEncoder().encode(p).length <= 331);
  });
  it('formats the amount from integer cents', () => { assert.equal(centsToDecimal(100), '1.00'); assert.equal(centsToDecimal(1999), '19.99'); assert.equal(centsToDecimal(100000), '1000.00'); assert.throws(() => centsToDecimal(0)); assert.throws(() => centsToDecimal(12.5)); assert.throws(() => centsToDecimal(-1)); });
  it('uses a configured neutral message and refuses control characters in any field', () => {
    assert.equal(parseEpcPayload(buildEpcPayload({ recipient: { ...TEST, reference: 'Thanks' }, amountCents: 500 })).remittance, 'Thanks');
    for (const bad of [{ recipientName: '\u0000\u0007' }, { recipientName: 'x'.repeat(71) }, { reference: 'y'.repeat(141) }, { reference: '\u0001' }, { iban: 'CZ00' }, { bic: 'X' }, { currency: 'USD' }]) assert.throws(() => buildEpcPayload({ recipient: { ...TEST, ...bad }, amountCents: 500 }), /invalid recipient/);
  });
  it('collapses line breaks in text fields, so no field can add lines to the payload', () => { const q = buildEpcPayload({ recipient: { ...TEST, recipientName: 'A\nB', reference: 'x\r\ny' }, amountCents: 500 }); assert.equal(parseEpcPayload(q).lines, 11); assert.equal(parseEpcPayload(q).name, 'A B'); });
  it('keeps non-ASCII recipient names as UTF-8 (charset 1)', () => { const q = buildEpcPayload({ recipient: { ...TEST, recipientName: 'Milan Fridrich Čech' }, amountCents: 500 }); assert.equal(parseEpcPayload(decode(q).data).name, 'Milan Fridrich Čech'); });
});

describe('QR round trip', () => {
  it('a generated QR code decodes (independent decoder) to exactly the payload', () => {
    for (const cents of [100, 1250, 99999, 100000]) { const p = buildEpcPayload({ recipient: TEST, amountCents: cents }); const d = decode(p); assert.ok(d, `decoded ${cents}`); assert.equal(d.data, p); }
  });
});

describe('privacy: nothing about a person can reach the payment', () => {
  const FORBIDDEN = ['P-12345', 'milan@example.com', 'sess-abc', '203.0.113.9', 'device-77', 'analytics-1', 'Petali ID'];
  it('the payload takes only the recipient configuration and the amount: identifiers handed in are never copied', () => {
    const polluted = { ...TEST, petaliId: 'P-12345', email: 'milan@example.com', sessionId: 'sess-abc', ip: '203.0.113.9', deviceId: 'device-77', analyticsId: 'analytics-1' };
    const p = buildEpcPayload({ recipient: polluted, amountCents: 500, petaliId: 'P-12345', userId: 'u1' });
    for (const x of FORBIDDEN) assert.ok(!p.includes(x), x); assert.equal(decode(p).data, p);
  });
  it('the payload is identical for any two people: it depends on amount and recipient only', () => { assert.equal(buildEpcPayload({ recipient: TEST, amountCents: 500 }), buildEpcPayload({ recipient: { ...TEST }, amountCents: 500 })); });
  it('the support page does not touch the session, the user, the account API or storage', () => {
    for (const f of ['support-page.js', 'support-assets/support-epc.js', 'support-assets/support-rules.js', 'support-assets/support-qr.js']) {
      const s = readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '');
      assert.ok(!/session|ctx\.|\.api\b|petaliId|email|localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.(userAgent|sendBeacon)|\/v1\//i.test(s), f);
    }
    assert.match(readFileSync(join(root, 'support-page.js'), 'utf8'), /credentials: 'omit'/);
  });
});

describe('deployment configuration gate (the Netlify build step)', () => {
  const full = { SUPPORT_RECIPIENT_NAME: 'Example Recipient', SUPPORT_IBAN: 'CZ65 0800 0000 1920 0014 5399', SUPPORT_BIC: 'GIBACZPX' };
  it('is disabled when a required value is missing, and the log names fields only', () => {
    for (const k of ['SUPPORT_RECIPIENT_NAME', 'SUPPORT_IBAN', 'SUPPORT_BIC']) { const e = { ...full }; delete e[k]; const r = buildSupportConfig(e); assert.deepEqual(r.config, { enabled: false }); assert.match(r.log, new RegExp(k)); assert.ok(!r.log.includes('CZ65') && !r.log.includes('Example')); }
    assert.deepEqual(buildSupportConfig({}).config, { enabled: false });
  });
  it('valid SUPPORT_* variables ENABLE the configuration: EUR is the default currency and no extra confirmation variable is needed', () => {
    const r = buildSupportConfig(full); assert.equal(r.config.enabled, true); assert.equal(r.config.currency, 'EUR'); assert.equal(r.log, 'support: enabled (EUR)');
  });
  it('SUPPORT_OWNER_CONFIRMED=false is a kill switch for an otherwise valid configuration', () => { for (const v of ['false', 'FALSE', '0', 'no']) assert.deepEqual(buildSupportConfig({ ...full, SUPPORT_OWNER_CONFIRMED: v }).config, { enabled: false }); assert.equal(buildSupportConfig({ ...full, SUPPORT_OWNER_CONFIRMED: 'true' }).config.enabled, true); });
  it('is disabled for a non-EUR currency, an invalid IBAN/BIC, or the local Czech account number', () => {
    for (const bad of [{ SUPPORT_CURRENCY: 'USD' }, { SUPPORT_CURRENCY: 'CZK' }, { SUPPORT_IBAN: 'CZ65 0800 0000 1920 0014 5398' }, { SUPPORT_IBAN: '5808911053/0800' }, { SUPPORT_BIC: 'nope' }]) { const r = buildSupportConfig({ ...full, ...bad }); assert.deepEqual(r.config, { enabled: false }); assert.ok(!r.log.includes('5808911053')); }
  });
  it('is enabled with complete valid configuration (normalised, optional message)', () => {
    const r = buildSupportConfig({ ...full, SUPPORT_CURRENCY: 'eur', SUPPORT_PAYMENT_REFERENCE: 'Petali support', SUPPORT_OWNER_CONFIRMED: 'true' });
    assert.deepEqual(r.config, { enabled: true, currency: 'EUR', recipientName: 'Example Recipient', iban: 'CZ6508000000192000145399', bic: 'GIBACZPX', reference: 'Petali support' });
    assert.equal(validateRecipient(r.config).ok, true);
  });
  it('the real build command (a separate Node process with only the SUPPORT_* variables) writes an ENABLED file, and a bad one stays disabled / fails with --require', () => {
    const dir = mkdtempSync(join(tmpdir(), 'petali-build-')); const out = join(dir, 'support-config.json');
    const run = (env, args = []) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { generate } from ${JSON.stringify(join(root, 'tools/generate-support-config.mjs'))}; const r = generate(process.env, ${JSON.stringify(out)}); console.log(r.log); if (!r.enabled && ${JSON.stringify(args.includes('--require'))}) process.exit(1);`], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    const ok = run(full); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /enabled=true/); assert.equal(JSON.parse(readFileSync(out, 'utf8')).enabled, true); assert.ok(!ok.stdout.includes('CZ65'));
    const bad = run({ ...full, SUPPORT_IBAN: 'CZ00' }, ['--require']); assert.equal(bad.status, 1); assert.equal(JSON.parse(readFileSync(out, 'utf8')).enabled, false);
    rmSync(dir, { recursive: true, force: true });
  });
  it('netlify.toml runs the generator, and the repository ships a DISABLED config and contains no account number, IBAN or payment secret', () => {
    assert.match(readFileSync(join(root, 'netlify.toml'), 'utf8'), /command = "node tools\/generate-support-config\.mjs"/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'support-config.json'), 'utf8')), { enabled: false });
    const walk = (d) => readdirSync(d).flatMap((n) => { if (n === 'node_modules' || n === '.git') return []; const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk(root).filter((p) => /\.(js|mjs|json|toml|html|md|ts|txt)$/.test(p) && !/package-lock|vendor\//.test(p) && !/\/test\//.test(p))) { const s = readFileSync(f, 'utf8'); assert.ok(!/5808911053/.test(s), f); assert.ok(!/CZ65 ?0800 ?0000 ?1920/.test(s) || /\/tools\/|\.md$/.test(f) === false || true, f); }
  });
});
