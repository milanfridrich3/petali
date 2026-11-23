// Support Petali - the public, standalone page (support.html, served at /support). It is independent of Petali ID: no session, no account, no cookies, no backend. It reads ONE static file
// (/support-config.json, generated at deploy time from the SUPPORT_* build variables) and uses the website's single anonymous EUR payment implementation, which lives in the neutral
// support-assets/ folder: amounts (support-rules.js), EPC/SEPA payload (support-epc.js) and QR drawing (support-qr.js). It never claims that a payment was received.
import { CURRENCY, LIMITS, formatMoney, parseAmount } from './support-assets/support-rules.js';
import { buildEpcPayload, validateRecipient } from './support-assets/support-epc.js';
import { qrSvg } from './support-assets/support-qr.js';

export const CONFIG_URL = '/support-config.json';

// Fetch seam for tests. No cookies, no referrer, never cached.
export const loader = {
  async load(fetchImpl = fetch) {
    const res = await fetchImpl(CONFIG_URL, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
    if (!res.ok) return { state: 'soon' };
    let raw; try { raw = await res.json(); } catch { return { state: 'soon' }; }
    if (!raw || raw.enabled !== true) return { state: 'soon' };
    const r = validateRecipient(raw);
    return r.ok ? { state: 'ready', recipient: r.value } : { state: 'soon' };      // an invalid configuration never produces a QR code
  },
};

const centsText = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

export function initSupportPage(doc = document, { fetchImpl } = {}) {
  const host = doc.getElementById('supportApp'); if (!host) return null;
  const el = (tag, attrs = {}, ...kids) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'hidden') n.hidden = !!v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, String(v)); } for (const c of kids.flat()) if (c != null) n.append(c); return n; };
  const title = () => el('h2', { text: 'Choose an amount' });
  let stopped = false;

  async function load() {
    host.replaceChildren(title(), el('p', { class: 'pay-note', text: 'Loading…' }));
    let out; try { out = await loader.load(fetchImpl); } catch { out = { state: 'error' }; }
    if (stopped) return;
    if (out.state === 'ready') host.replaceChildren(title(), picker(out.recipient));
    else if (out.state === 'error') host.replaceChildren(el('h2', { text: 'Support Petali' }), el('p', { class: 'field-error', role: 'status', text: 'The page could not be loaded. Check your connection and try again.' }), el('button', { class: 'btn retry', type: 'button', onclick: load, text: 'Try again' }));
    else host.replaceChildren(el('h2', { text: 'Support Petali' }), el('div', { class: 'soon', role: 'status' }, el('strong', { text: 'Support will be available soon.' }), el('p', { text: 'Thank you for thinking of Petali. Nothing is needed from you, and nothing can be paid here yet.' })));
  }

  function picker(recipient) {
    const state = { selected: null };
    const customInput = el('input', { id: 'support-custom', type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: 14, placeholder: '12,50', 'aria-describedby': 'support-custom-hint support-custom-error' });
    const customError = el('p', { id: 'support-custom-error', class: 'field-error', role: 'alert', hidden: true });
    const customBox = el('div', { class: 'field', hidden: true }, el('label', { for: 'support-custom', text: `Amount in ${CURRENCY}` }), el('div', { class: 'amount-row' }, customInput, el('span', { class: 'unit', 'aria-hidden': 'true', text: CURRENCY })),
      el('span', { class: 'small', id: 'support-custom-hint', text: `From ${formatMoney(LIMITS.minCents)} to ${formatMoney(LIMITS.maxCents)}. A comma or a dot may be used for cents.` }), customError);
    const chip = (value, label) => { const id = `amt-${value}`; const input = el('input', { type: 'radio', name: 'support-amount', value: String(value), id }); input.addEventListener('change', () => { if (!input.checked) return; state.selected = value; if (value === 'custom') customInput.focus(); update(); }); return el('label', {}, input, el('span', { class: 'opt', text: label })); };
    const chips = el('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Amount' }, LIMITS.presetsCents.map((c) => chip(c, formatMoney(c))), chip('custom', 'Custom amount'));
    customInput.addEventListener('input', update);
    const payHost = el('div', { class: 'pay-host' });
    function current() {
      if (state.selected === null) return { kind: 'none' };
      if (state.selected === 'custom') { const r = parseAmount(customInput.value); return r.ok ? { kind: 'ok', cents: r.cents } : { kind: customInput.value.trim() === '' ? 'empty' : 'bad', message: r.message }; }
      return { kind: 'ok', cents: state.selected };
    }
    function update() {
      customBox.hidden = state.selected !== 'custom';
      const c = current(); const bad = c.kind === 'bad';
      customError.hidden = !bad; customError.textContent = bad ? c.message : ''; customInput.setAttribute('aria-invalid', String(bad));
      payHost.replaceChildren(c.kind === 'ok' ? payment(recipient, c.cents) : el('p', { class: 'pay-note', text: c.kind === 'none' ? 'Choose an amount to see the QR code.' : 'Enter a valid amount to see the QR code.' }));
    }
    const wrap = el('div', {}, chips, customBox, payHost); update(); return wrap;
  }

  function copyRow(label, value) {
    const btn = el('button', { class: 'copy', type: 'button', 'aria-label': `Copy ${label}`, text: 'Copy' }); const code = el('code', { text: value });
    btn.addEventListener('click', async () => {
      try { await doc.defaultView.navigator.clipboard.writeText(value); btn.textContent = 'Copied'; }
      catch { try { const sel = doc.defaultView.getSelection(); const r = doc.createRange(); r.selectNodeContents(code); sel.removeAllRanges(); sel.addRange(r); } catch { /* the text is user-selectable */ } btn.textContent = 'Select and copy'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
    return el('div', { class: 'pay-row' }, el('span', { class: 'pay-k', text: label }), code, btn);
  }

  function payment(recipient, cents) {
    let payload; try { payload = buildEpcPayload({ recipient, amountCents: cents }); } catch { return el('p', { class: 'field-error', role: 'status', text: 'Support will be available soon.' }); }
    const amount = formatMoney(cents); let qr = null;
    try { qr = qrSvg(payload, `QR code for a payment of ${amount} to ${recipient.recipientName}`); } catch { qr = null; }
    const iban = recipient.iban.replace(/(.{4})/g, '$1 ').trim();
    return el('div', { class: 'pay' },
      el('div', { class: 'pay-qr' }, qr ? el('div', { class: 'qr-panel' }, qr) : el('p', { class: 'field-error', text: 'The QR code could not be created. Use the payment details.' }), el('p', { class: 'pay-amount' }, el('strong', { text: amount }), ' · one voluntary payment')),
      el('div', {}, el('p', { class: 'pay-note', text: 'Scan with your banking app (SEPA / EPC QR code). This is a voluntary payment; it does not unlock anything. Petali cannot see whether you pay.' }),
        el('div', { class: 'pay-rows' }, copyRow('Recipient', recipient.recipientName), copyRow('IBAN', iban), copyRow('BIC', recipient.bic), copyRow('Amount', `${centsText(cents)} ${CURRENCY}`), copyRow('Message', recipient.reference)),
        el('p', { class: 'pay-note', text: 'Check the recipient and amount in your banking app before you confirm. Petali never asks for card or bank-login details.' })));
  }

  load();
  return { stop() { stopped = true; }, reload: load };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !window.__PETALI_SUPPORT_TEST__) initSupportPage(document);
