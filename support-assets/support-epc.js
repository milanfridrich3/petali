// Support Petali - EPC / SEPA credit transfer QR payload (EPC069-12, "Quick Response Code: Guidelines to Enable the Data Capture for the Initiation of a SEPA Credit Transfer").
// Pure functions, no I/O. The payload is built ONLY from public recipient configuration and the chosen amount: there is no parameter through which a Petali
// account, e-mail address, session, device or any other identifier could enter it.
export const EPC = Object.freeze({ SERVICE_TAG: 'BCD', VERSION: '002', CHARSET_UTF8: '1', IDENTIFICATION: 'SCT', CURRENCY: 'EUR', MAX_NAME: 70, MAX_REMITTANCE: 140, MAX_BYTES: 331, MAX_CENTS: 99999999999 });

// IBAN length per SEPA country (ISO 13616). A SEPA QR can only be paid to a SEPA IBAN.
const IBAN_LENGTH = { AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22 };
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export const normalizeIban = (s) => String(s ?? '').replace(/[\s\u00a0]+/g, '').toUpperCase();
export const normalizeBic = (s) => String(s ?? '').replace(/[\s\u00a0]+/g, '').toUpperCase();

// ISO 7064 mod 97-10, computed in chunks so no big number is needed.
export function isValidIban(raw) {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (IBAN_LENGTH[iban.slice(0, 2)] !== iban.length) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (let i = 0; i < digits.length; i += 7) rem = Number(String(rem) + digits.slice(i, i + 7)) % 97;
  return rem === 1;
}
export const isValidBic = (raw) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalizeBic(raw));

// A text field of the payload: one line, no control characters, within the length the standard allows.
const cleanLine = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s !== '' && s.length <= max && !CONTROL.test(s) ? s : null; };

// cents (a positive safe integer) -> "12.50". Integer arithmetic only.
export function centsToDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > EPC.MAX_CENTS) throw new RangeError('amount out of range');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// The recipient configuration that is allowed to produce a QR code. Returns { ok: true, value } with normalised fields, or { ok: false, problems: [field names] }.
// Problems name FIELDS only, never values, so they are safe to log.
export function validateRecipient(raw) {
  const problems = []; const o = raw && typeof raw === 'object' ? raw : {};
  if (o.currency !== EPC.CURRENCY) problems.push('currency');
  const name = cleanLine(o.recipientName, EPC.MAX_NAME); if (!name) problems.push('recipientName');
  const iban = normalizeIban(o.iban); if (!isValidIban(iban)) problems.push('iban');
  const bic = normalizeBic(o.bic); if (!isValidBic(bic)) problems.push('bic');
  const reference = o.reference === undefined || o.reference === null || o.reference === '' ? 'Petali support' : cleanLine(o.reference, EPC.MAX_REMITTANCE); if (!reference) problems.push('reference');
  return problems.length ? { ok: false, problems } : { ok: true, value: { currency: EPC.CURRENCY, recipientName: name, iban, bic, reference } };
}

// The payload text. Throws on anything invalid: a QR code is never built from unchecked input.
export function buildEpcPayload({ recipient, amountCents }) {
  const r = validateRecipient(recipient);
  if (!r.ok) throw new Error(`invalid recipient: ${r.problems.join(', ')}`);
  const v = r.value;
  const lines = [EPC.SERVICE_TAG, EPC.VERSION, EPC.CHARSET_UTF8, EPC.IDENTIFICATION, v.bic, v.recipientName, v.iban, `${EPC.CURRENCY}${centsToDecimal(amountCents)}`, '', '', v.reference];
  const text = lines.join('\n');
  if (new TextEncoder().encode(text).length > EPC.MAX_BYTES) throw new Error('payload too long');
  return text;
}

// Reads a payload back (used by the tests and by the page's self-check).
export function parseEpcPayload(text) {
  const l = String(text).split('\n');
  return { tag: l[0], version: l[1], charset: l[2], id: l[3], bic: l[4], name: l[5], iban: l[6], amount: l[7], purpose: l[8], structuredRef: l[9], remittance: l[10], lines: l.length };
}
