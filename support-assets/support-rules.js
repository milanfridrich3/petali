// Support Petali - amount rules. Money is ALWAYS an integer number of euro cents; no floating point number ever represents an amount.
// EUR is the only currency in this release. The structure (CURRENCIES) allows another one to be added later; nothing unsupported is ever offered.
export const CURRENCIES = Object.freeze({ EUR: Object.freeze({ code: 'EUR', minCents: 100, maxCents: 100000, presetsCents: [300, 500, 1000, 2500] }) });
export const CURRENCY = 'EUR';
export const LIMITS = CURRENCIES.EUR;

// cents -> "1 234.50" style text with a thin grouping space, e.g. "12.50 EUR". Integer arithmetic only.
export function formatMoney(cents, code = CURRENCY) {
  if (!Number.isSafeInteger(cents) || cents < 0) return '';
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return `${whole}.${String(cents % 100).padStart(2, '0')} ${code}`;
}

const SPACES = /[\s\u00a0\u202f\u2009']/g;
// Typed text -> { ok: true, cents } | { ok: false, message }. Accepts "12", "12,5", "12.50", "1 250,00", "1.250,00", "1,250.00", "12 €", "EUR 12".
// A single "." or "," is a decimal separator (1 or 2 digits after it). When both occur, the LAST one is the decimal separator and the other is grouping in
// groups of three. A lone separator followed by three digits ("1.000") is ambiguous between countries and is refused instead of guessed.
export function parseAmount(text, limits = LIMITS) {
  let s = String(text ?? '').trim();
  if (s === '') return { ok: false, message: 'Enter an amount in euro.' };
  s = s.replace(/^(eur|€)\s*/i, '').replace(/\s*(eur|€)$/i, '').trim();
  if (/^[-−–]/.test(s)) return { ok: false, message: 'The amount must be positive.' };
  if (/^\+/.test(s)) s = s.slice(1);
  if (!/^[\d.,\s\u00a0\u202f\u2009']+$/.test(s) || !/\d/.test(s)) return { ok: false, message: 'Use digits only, for example 12 or 12,50.' };
  s = s.replace(SPACES, '');
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(','); const last = Math.max(lastDot, lastComma);
  let whole = s; let frac = '';
  if (last >= 0) {
    const tail = s.slice(last + 1);
    const head = s.slice(0, last);
    const bothKinds = lastDot >= 0 && lastComma >= 0;
    const grouping = (h) => /^\d{1,3}([.,]\d{3})+$/.test(h);
    if (bothKinds) {
      if (!/^\d{1,3}([.,]\d{3})*$/.test(head) || /\./.test(head) && /,/.test(head)) return { ok: false, message: 'Check the amount, for example 1 250,50.' };
      whole = head.replace(/[.,]/g, ''); frac = tail;
    } else if ((s.match(/[.,]/g) || []).length > 1) {
      return { ok: false, message: 'Use one comma or dot for cents, for example 12,50.' };
    } else if (tail.length === 3 && /^\d+$/.test(head) && grouping(head + s[last] + tail)) {
      return { ok: false, message: 'Write cents after a comma or dot (12,50) and no thousands separator.' };
    } else { whole = head; frac = tail; }
    if (!/^\d{1,2}$/.test(frac)) return { ok: false, message: 'Use at most two decimal places, for example 12,50.' };
    if (whole === '') whole = '0';
  }
  if (!/^\d+$/.test(whole)) return { ok: false, message: 'Use digits only, for example 12 or 12,50.' };
  if (whole.replace(/^0+/, '').length > 7) return { ok: false, message: `The largest amount is ${formatMoney(limits.maxCents)}.` };
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (cents <= 0) return { ok: false, message: 'The amount must be greater than zero.' };
  if (cents < limits.minCents) return { ok: false, message: `The smallest amount is ${formatMoney(limits.minCents)}.` };
  if (cents > limits.maxCents) return { ok: false, message: `The largest amount is ${formatMoney(limits.maxCents)}.` };
  return { ok: true, cents };
}
