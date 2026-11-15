// Loads a read-only view with "saved copy first, then the network": the screen can show the last saved copy at once (clearly labelled), and replaces it
// when fresh data arrives. A temporary failure keeps the saved copy; it never erases it. Saved copies belong to the signed-in account only.
import { ApiError } from './api.js';

export function createData({ api, cache, session, isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false) }) {
  return {
    // render(state): { loading } | { data, cached, savedAt, loading?, error?, offline? } | { error }
    watch(key, path, render) {
      let stopped = false; let seq = 0;
      async function load() {
        const mine = ++seq; const uid = session.userId();
        const saved = await cache.get(uid, key);
        if (stopped || mine !== seq) return;
        const asSaved = (extra) => ({ data: saved.data, cached: true, savedAt: saved.savedAt, ...extra });
        render(saved ? asSaved({ loading: true }) : { loading: true });
        if (session.state().status === 'offline' || !isOnline()) { render(saved ? asSaved({ offline: true }) : { error: new ApiError('You are offline and nothing is saved for this view yet.', { status: 0, code: 'offline' }), offline: true }); return; }
        let data;
        try { data = await api.get(path); }
        catch (e) {
          if (stopped || mine !== seq) return;
          const err = e instanceof ApiError ? e : new ApiError('Something went wrong.', { status: 0 });
          render(saved && err.transient ? asSaved({ error: err }) : { error: err });
          return;
        }
        if (stopped || mine !== seq) return;
        await cache.put(uid, key, data);
        render({ data, cached: false, savedAt: Date.now() });     // a bug in a view's own rendering is a bug, not a "server unreachable" (it is no longer caught as one)
      }
      load();
      return { reload: load, stop() { stopped = true; seq += 1; } };
    },
  };
}
