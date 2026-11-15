// Session state machine for Petali ID. States:
//   booting       checking the cookie session
//   authenticated signed in, server reachable
//   offline       the server could not be reached, but this browser knows the last signed-in account: its SAVED views may be shown, labelled as saved
//   unreachable   the server could not be reached and nothing is saved on this browser
//   anonymous     signed out
// A temporary failure (offline, timeout, cold start, 5xx, 429) NEVER signs anybody out; only the server saying 401 does.
import { ApiError } from './api.js';

export function createSession({ api, cache, onChange = () => {}, slowMs = 3500, beforeAdopt = () => {} }) {
  const s = { status: 'booting', user: null, reason: null };
  const set = (patch) => { Object.assign(s, patch); onChange({ ...s }); };
  const idOf = (u) => (u && u.petaliId) || null;
  const brief = (u) => ({ petaliId: u.petaliId, email: u.email, displayName: u.displayName ?? null });

  async function adopt(result) {
    const prev = await cache.getMeta('lastSession');
    if (prev && prev.petaliId !== idOf(result.user)) await cache.wipeAll();        // another account on this browser: nothing of the previous one may remain
    await cache.setMeta('lastSession', brief(result.user));
    set({ status: 'authenticated', user: result.user, reason: null });
  }
  async function dropToAnonymous(reason) { api.forget(); await cache.wipeAll(); set({ status: 'anonymous', user: null, reason }); }

  return {
    state: () => ({ ...s }),
    userId: () => idOf(s.user),
    async boot() {
      if (await cache.getMeta('pendingLogout')) {            // a sign-out that could not reach the server earlier: finish it BEFORE anything restores the session
        try { await api.logout(); await cache.delMeta('pendingLogout'); } catch (e) { if (!(e instanceof ApiError) || !e.transient) await cache.delMeta('pendingLogout'); }
        api.forget(); set({ status: 'anonymous', user: null, reason: null }); return s.status;
      }
      // A sleeping server can take a while to answer. If the last signed-in account is known on this browser, show its saved copies after a few
      // seconds instead of a blank screen, and keep trying in the background.
      const last = await cache.getMeta('lastSession');
      const attempt = api.refresh().then((r) => ({ r }), (e) => ({ e }));
      let timer; const early = last ? new Promise((res) => { timer = setTimeout(() => res({ slow: true }), slowMs); }) : null;
      const first = await (early ? Promise.race([attempt, early]) : attempt); clearTimeout(timer);
      const settle = async (o) => {
        if (o.r) return adopt(o.r);
        const e = o.e;
        if (e instanceof ApiError && e.status === 401) return dropToAnonymous(e.code === 'no_session' ? null : 'session_ended');
        const reason = e instanceof ApiError ? e.code : 'network_error';
        set(last ? { status: 'offline', user: { ...last }, reason } : { status: 'unreachable', user: null, reason });
      };
      if (first.slow) { set({ status: 'offline', user: { ...last }, reason: 'slow' }); attempt.then(settle); return s.status; }
      await settle(first);
      return s.status;
    },
    async login(email, password) { await adopt(await api.login(email, password)); },
    async register(email, password, displayName) { const r = await api.register(email, password, displayName); try { beforeAdopt(r); } catch { /* a hook must never break sign-up */ } await adopt(r); return r; },
    async logout() {
      api.forget(); await cache.wipeAll(); set({ status: 'anonymous', user: null, reason: null });
      try { await api.logout(); } catch (e) { if (e instanceof ApiError && e.transient) await cache.setMeta('pendingLogout', true); }
    },
    // The server ended this session (revoked elsewhere, expired, password changed on another device).
    async authLost() { if (s.status === 'authenticated' || s.status === 'offline') await dropToAnonymous('session_ended'); },
    // Back online: try to restore the real session.
    async retry() { if (s.status === 'offline' || s.status === 'unreachable') return this.boot(); return s.status; },
    updateUser(user) { if (s.status === 'authenticated') { s.user = user; cache.setMeta('lastSession', brief(user)); onChange({ ...s }); } },
  };
}
