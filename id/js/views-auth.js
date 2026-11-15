// Login, registration and the "server unreachable" screen.
import { ApiError } from './api.js';
import { h, clear, brandMark } from './ui.js';
import { BASE } from './router.js';
import { PASSWORD_MIN, PASSWORD_HINT, passwordProblem } from './auth-rules.js';

const MESSAGES = {
  invalid_credentials: 'Email or password is incorrect.', email_taken: 'An account with this email already exists. Sign in instead.', weak_password: null,
  google_not_configured: 'Google sign-in is not set up on this server yet. Use your email and password instead.',
  too_many_attempts: 'Too many attempts. Please wait a moment and try again.', rate_limited: 'Too many requests. Please wait a moment and try again.', validation_failed: 'Please check the highlighted fields.',
};
export function describeAuthError(e) {
  if (!(e instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (e.code === 'google_not_configured') return MESSAGES.google_not_configured;   // a 503, but not a cold start: the server is up and simply has no Google set up
  if (e.transient) return e.status === 429 ? `Too many attempts. Try again in ${e.retryAfter ? `${e.retryAfter} seconds` : 'a moment'}.` : 'Cannot reach the Petali server right now. It may be starting up - wait a few seconds and try again. Nothing was changed.';
  return MESSAGES[e.code] || e.message || 'Sign-in failed.';
}

// What the server said happened to a Google sign-in (the callback sends the browser back to /id/login?google=<reason>).
export const GOOGLE_REASONS = {
  cancelled: 'Google sign-in was cancelled. Nothing was changed.',
  expired: 'The Google sign-in took too long or was started in another browser. Please try again.',
  invalid: 'The Google sign-in could not be verified. Please try again.',
  failed: 'Google sign-in did not work. Please try again.',
  unavailable: 'Google could not be reached. Please try again in a moment.',
  not_configured: 'Google sign-in is not set up on this server yet. Use your email and password instead.',
  needs_verification: 'An account with this email already exists, but its email is not confirmed yet, and email confirmation is not available at the moment. Sign in with that account\'s password instead.',
  mismatch: 'This Petali account is already connected to a different Google account.',
  email_unverified: 'Google says that email address is not verified, so it cannot be used to sign in.',
};
const G_LOGO = '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>';
// "Continue with Google": a normal button (works for keyboard and touch). The page only ever receives Google's URL; the code comes back to the SERVER.
export function googleButton(ctx, { next, show, label = 'Continue with Google', go = (u) => location.assign(u) }) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'g-logo'); svg.innerHTML = G_LOGO;
  const text = h('span', { text: label });
  const b = h('button', { class: 'btn btn-google', type: 'button', id: 'google-btn' }, svg, text);
  const reset = () => { b.disabled = false; text.textContent = label; };
  window.addEventListener('pageshow', (e) => { if (e.persisted) reset(); });        // back from Google (bfcache): the button works again
  b.onclick = async () => {
    b.disabled = true; text.textContent = 'Opening Google…'; show('');
    try {
      const r = await ctx.api.googleStart(next && next !== BASE ? next : undefined);
      if (!r || typeof r.authUrl !== 'string' || !r.authUrl.startsWith('https://accounts.google.com/')) throw new ApiError('Unexpected answer from the server.', { status: 502, code: 'bad_response' });
      go(r.authUrl);
    } catch (e) { show(describeAuthError(e)); reset(); }
  };
  return b;
}

export function authView(ctx, { mode, next, search }) {
  const wrap = h('div', { class: 'auth' });
  const view = { el: wrap, stop() {}, title: mode === 'register' ? 'Create account' : mode === 'unreachable' ? 'Cannot connect' : 'Sign in' };
  if (mode === 'unreachable') {
    const reason = ctx.session.state().reason; const tooMany = reason === 'rate_limited' || reason === 'too_many_attempts';
    wrap.append(h('div', { class: 'auth-card' }, h('div', { class: 'auth-brand' }, brandMark('lg'), 'petali'), h('h1', { text: tooMany ? 'Too many requests' : 'Cannot reach Petali' }), h('p', { class: 'intro', text: tooMany ? 'Petali received a lot of requests from this network. Wait a minute, then try again. Nothing was lost.' : 'The Petali server did not answer, and this browser has no saved data yet. It may be starting up after a quiet period.' }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.session.retry() }, 'Try again')));
    return view;
  }
  const reg = mode === 'register';
  const msg = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const gReason = search && search.get ? search.get('google') : null;
  const notice = ctx.session.state().reason === 'session_ended' ? h('p', { class: 'banner banner-warn', text: 'Your session has ended. Please sign in again.' }) : null;
  const email = h('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true, inputmode: 'email', autocapitalize: 'none', spellcheck: 'false' });
  const password = h('input', { id: 'password', name: 'password', type: 'password', autocomplete: reg ? 'new-password' : 'current-password', required: true, minlength: reg ? PASSWORD_MIN : 1 });
  const name = reg ? h('input', { id: 'displayName', name: 'displayName', type: 'text', autocomplete: 'nickname', maxlength: 50 }) : null;
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, reg ? 'Create account' : 'Sign in');
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input, hint ? h('small', { text: hint }) : null);
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); msg.hidden = true;
    if (!email.value.trim() || !password.value) { msg.textContent = 'Enter your email and password.'; msg.hidden = false; return; }
    if (reg) { const bad = passwordProblem(password.value); if (bad) { msg.textContent = bad; msg.hidden = false; password.setAttribute('aria-invalid', 'true'); password.focus(); return; } password.removeAttribute('aria-invalid'); }
    submit.disabled = true; submit.textContent = 'Please wait…';
    try {
      if (reg) await ctx.session.register(email.value.trim(), password.value, name && name.value.trim() ? name.value.trim() : undefined);
      else await ctx.session.login(email.value.trim(), password.value);
    }
    catch (err) {
      const text = err instanceof ApiError && err.code === 'weak_password' ? err.message : describeAuthError(err);
      msg.textContent = text; msg.hidden = false; submit.disabled = false; submit.textContent = reg ? 'Create account' : 'Sign in'; password.value = ''; password.focus();
    }
  } },
  field('Email', email), reg ? field('Name (optional)', name) : null, field('Password', password, reg ? PASSWORD_HINT : null), msg, submit);
  const q = next && next !== BASE ? `?next=${encodeURIComponent(next)}` : '';
  const gMsg = h('p', { class: 'g-error', role: 'alert', hidden: !gReason || !GOOGLE_REASONS[gReason], text: (gReason && GOOGLE_REASONS[gReason]) || '' });
  const showG = (t) => { gMsg.textContent = t; gMsg.hidden = !t; };
  const google = h('div', { class: 'google-block' }, googleButton(ctx, { next, show: showG, label: 'Continue with Google' }), gMsg, h('div', { class: 'or-divider', role: 'separator' }, h('span', { text: 'or use your email' })));
  if (gReason) { try { history.replaceState({}, '', `${BASE}/${reg ? 'register' : 'login'}${q}`); } catch { /* not important */ } }
  wrap.append(h('div', { class: 'auth-card' }, h('div', { class: 'auth-brand' }, brandMark('lg'), 'petali'), h('h1', { text: reg ? 'Create your Petali ID' : 'Welcome back' }),
    h('p', { class: 'intro', text: reg ? 'One account for every computer you run Petali on - your plant and history, from any browser.' : 'Sign in to see your computers, your plant and your history.' }), notice, google, form,
    h('p', { class: 'switch muted' }, reg ? 'Already have an account? ' : 'New to Petali? ', h('a', { href: `${BASE}/${reg ? 'login' : 'register'}${q}`, text: reg ? 'Sign in' : 'Create an account' })),
    h('p', { class: 'back-link muted' }, h('a', { href: '/', text: '← Back to the Petali website' }))));
  setTimeout(() => email.focus(), 0);
  return view;
}

// ---- email verification --------------------------------------------------------------------------------------------------------------------
// Email confirmation is not live in this release (no email service is connected yet), so no confirmation mail is promised or offered. When the email
// service is added, set this to true: the banner then offers "Send a new link" again. Nothing else depends on it.
export const EMAIL_CONFIRMATION_AVAILABLE = false;

// The wording of what really happened with the email. Never says "sent" unless the server's provider accepted the message.
export function verificationNotice(info, email) {
  if (!info) return null;
  if (info.sent) return { kind: 'ok', text: `We sent a confirmation link to ${email || 'your email address'}. Open it to finish setting up your Petali ID.` };
  if (info.reason === 'not_configured') return { kind: 'ok', text: 'Your account is ready. Email confirmation is not available yet, so no confirmation message was sent and your email shows as "Not confirmed yet". You can use Petali ID normally.' };
  return { kind: 'warn', text: 'Your account is ready, but the confirmation email could not be sent. Use "Send a new link" in a moment.' };
}

export const RESEND_TEXT = { resend_too_soon: 'A message was just sent. Please wait a minute before asking for another.', email_not_configured: 'This server cannot send email yet, so no message was sent.', email_delivery_failed: 'The email could not be sent. Please try again in a few minutes.', already_verified: 'Your email address is already confirmed.' };

// One place for the resend button, used by the banner and the verify page. `onDone(kind, text)` reports the outcome; the button is disabled for a minute after a success.
export function resendButton(ctx, { label = 'Send a new link', onDone = () => {} } = {}) {
  const b = h('button', { class: 'btn', type: 'button' }, label);
  b.onclick = async () => {
    b.disabled = true;
    try { await ctx.api.post('/v1/auth/resend-verification', {}); onDone('ok', 'A new confirmation link is on its way. It can take a minute to arrive.'); setTimeout(() => { b.disabled = false; }, 60000); }
    catch (e) {
      const known = e instanceof ApiError && RESEND_TEXT[e.code];
      if (e instanceof ApiError && e.code === 'already_verified') { try { const a = await ctx.api.get('/v1/account'); ctx.session.updateUser(a.user); } catch { /* the banner refreshes on the next load */ } }
      onDone('bad', known || (e instanceof ApiError && e.transient ? 'Cannot reach the server right now. Nothing was sent.' : (e instanceof ApiError && e.message) || 'Could not send the email.'));
      b.disabled = false;
    }
  };
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Refreshing the signed-in user (below) makes the app re-render this same route AFTER the token was removed from the address bar. The new view must show the
// success that just happened, not "link incomplete": remember it for a few seconds (memory only, nothing is stored).
let recentSuccess = null;
export const forgetRecentVerification = () => { recentSuccess = null; };
// /id/verify?token=...  (the link in the email). The token is removed from the address bar at once so it cannot leak through history or a screenshot.
export function verifyView(ctx, { search, delays = [2000, 5000, 9000] }) {
  const token = search.get('token');
  try { if (token) history.replaceState({}, '', `${BASE}/verify`); } catch { /* not important */ }
  const wrap = h('div', { class: 'auth' }); const card = h('div', { class: 'auth-card verify', 'aria-live': 'polite' }); wrap.append(card);
  const view = { el: wrap, stop() { stopped = true; }, title: 'Confirm email' }; let stopped = false;
  const head = () => h('div', { class: 'auth-brand' }, brandMark('lg'), 'petali');
  const paint = (kind, title, text, ...extra) => { if (stopped) return; clear(card); card.append(head(), h('div', { class: `verify-icon verify-${kind}`, 'aria-hidden': 'true', text: kind === 'ok' ? '✓' : kind === 'wait' ? '' : '!' }), h('h1', { text: title }), h('p', { class: 'intro', text }), ...extra); };
  const authed = () => ctx.session.state().status === 'authenticated';
  const goOn = () => h('a', { class: 'btn btn-primary', href: authed() ? `${BASE}/` : `${BASE}/login`, text: authed() ? 'Open Petali ID' : 'Sign in' });
  const resendBlock = (note) => { const out = h('p', { class: 'form-error', role: 'alert', hidden: true }); const ok = h('p', { class: 'banner', role: 'status', hidden: true });
    return authed() ? [note ? h('p', { class: 'muted small', text: note }) : null, resendButton(ctx, { onDone: (k, t) => { const el = k === 'ok' ? ok : out; out.hidden = true; ok.hidden = true; el.textContent = t; el.hidden = false; } }), out, ok]
      : [h('p', { class: 'muted small', text: 'Sign in to Petali ID, then ask for a new link.' }), h('a', { class: 'btn', href: `${BASE}/login`, text: 'Sign in' })]; };
  const paintSuccess = (status) => paint('ok', status === 'already_verified' ? 'Already confirmed' : 'Email confirmed', status === 'already_verified' ? 'This email address was already confirmed. You are all set.' : 'Thank you. Your Petali ID is confirmed.', goOn());
  async function run() {
    if (!token && recentSuccess && Date.now() - recentSuccess.at < 15000) { paintSuccess(recentSuccess.status); return; }
    if (!token) { paint('bad', 'This link is incomplete', 'The confirmation link is missing its code. Open the link from the email again, or ask for a new one.', ...resendBlock()); return; }
    paint('wait', 'Confirming your email…', 'One moment.');
    for (let i = 0; i < 4; i += 1) {
      try {
        const r = await ctx.api.post('/v1/auth/verify-email', { token }, { auth: false });
        recentSuccess = { at: Date.now(), status: r.status };
        paintSuccess(r.status);
        if (authed()) { try { const a = await ctx.api.get('/v1/account'); ctx.session.updateUser(a.user); } catch { /* the banner refreshes on the next load */ } }
        return;
      } catch (e) {
        if (!(e instanceof ApiError)) { paint('bad', 'Something went wrong', 'Please try again.', h('button', { class: 'btn', type: 'button', onclick: run }, 'Try again')); return; }
        if (e.code === 'verification_expired') { paint('bad', 'This link has expired', 'Confirmation links work for a limited time. Ask for a new one.', ...resendBlock()); return; }
        if (e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408) { paint('bad', 'This link is not valid', 'It may have been changed, already replaced by a newer one, or belong to an address that is no longer on the account.', ...resendBlock()); return; }
        if (i < 3 && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504)) { paint('wait', 'Waking up the Petali server…', 'It was asleep. This can take up to a minute.'); await sleep(delays[i]); if (stopped) return; continue; }
        paint('bad', 'Cannot confirm right now', 'The Petali server could not be reached. Nothing was changed. Try again in a moment.', h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, 'Try again')); return;
      }
    }
  }
  run();
  return view;
}
