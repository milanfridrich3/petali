// The only module that talks to the network. The API is reached THROUGH THE SITE (/id/api/* is proxied to the Petali Cloud by Netlify), so every
// request is same-origin and the refresh token can sit in a first-party HttpOnly cookie that JavaScript cannot read.
// The short-lived access token is kept in a variable only (never localStorage / IndexedDB / the service worker).
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error', retryAfter = null, requestId = null } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.retryAfter = retryAfter; this.requestId = requestId; }
  get network() { return this.status === 0; }
  // Temporary trouble (offline, timeout, cold start, server error, rate limit) - NEVER a reason to sign anybody out.
  get transient() { return this.status === 0 || this.status >= 500 || this.status === 429 || this.status === 408; }
}
const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLD_START_DELAYS = [1500, 4000, 9000];

export function createApi({ fetchImpl = (...a) => fetch(...a), base = '/id/api', locks = typeof navigator !== 'undefined' ? navigator.locks : null, now = () => Date.now(), delays = COLD_START_DELAYS, timeoutMs = 25000, onSlow = () => {}, onAuthLost = () => {} } = {}) {
  let token = null; let expiresAt = 0; let refreshing = null;

  async function raw(method, path, { body, auth = false, signal } = {}) {
    const headers = { Accept: 'application/json', 'X-Petali-Web': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
    let res;
    try { res = await fetchImpl(base + path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch (e) { const timedOut = ctl.signal.aborted && !(signal && signal.aborted); throw new ApiError(timedOut ? 'The server did not answer in time.' : 'Cannot reach the server.', { status: 0, code: timedOut ? 'timeout' : 'network_error' }); }
    finally { clearTimeout(timer); }
    if (res.status === 204) return null;
    let json = null; try { json = await res.json(); } catch { /* not JSON (a proxy error page) */ }
    // A successful answer that is not JSON is not an answer from the Petali API (a proxy error page, or the site's own app shell when the proxy is misconfigured):
    // an error the callers can handle (transient, so nobody is signed out), never a null they would crash on.
    if (res.ok) { if (json === null) throw new ApiError('The server sent an unexpected response.', { status: 502, code: 'invalid_response' }); return json; }
    const err = json && json.error ? json.error : {};
    throw new ApiError(err.message || `Request failed (${res.status}).`, { status: res.status, code: err.code || (res.status >= 500 ? 'server_error' : 'request_failed'), retryAfter: Number(res.headers && res.headers.get && res.headers.get('retry-after')) || null, requestId: err.requestId || null });
  }

  // GET-like calls survive a cold start (Render free instances need up to a minute): retry on network errors / 502-504 with a growing pause.
  // (No waiting around when the device itself is offline: the error is raised at once.)
  async function withRetry(fn, { retry = true } = {}) {
    for (let i = 0; ; i += 1) {
      try { return await fn(); }
      catch (e) { const cold = e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504); if (!retry || !cold || offlineNow() || i >= delays.length) throw e; onSlow(i + 1); await sleep(delays[i]); }
    }
  }

  const setSession = (r) => { token = r.accessToken; expiresAt = Date.parse(r.accessTokenExpiresAt) || 0; return r; };

  // Serialised across tabs (Web Locks) so two tabs never rotate the same cookie at the same moment.
  function refresh() {
    if (refreshing) return refreshing;
    const run = () => withRetry(() => raw('POST', '/v1/web/session/refresh', { body: {} }));
    const p = (locks && locks.request ? locks.request('petali-session-refresh', run) : run()).then(setSession);
    refreshing = p.finally(() => { refreshing = null; });
    return refreshing;
  }

  async function ensureToken() { if (!token || expiresAt - now() < 30000) await refresh(); }

  async function request(method, path, opts = {}) {
    const auth = opts.auth !== false;
    return withRetry(async () => {
      if (auth) await ensureToken();
      try { return await raw(method, path, { ...opts, auth }); }
      catch (e) {
        if (auth && e instanceof ApiError && e.status === 401 && (e.code === 'token_expired' || e.code === 'invalid_token')) { token = null; await refresh(); return raw(method, path, { ...opts, auth }); }
        throw e;
      }
    }, { retry: method === 'GET' && opts.retry !== false }).catch((e) => { if (e instanceof ApiError && e.status === 401 && auth) { token = null; onAuthLost(e); } throw e; });
  }

  return {
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
    put: (path, body, opts) => request('PUT', path, { ...opts, body }),
    del: (path, opts) => request('DELETE', path, opts),
    async login(email, password) { return setSession(await raw('POST', '/v1/web/session/login', { body: { email, password } })); },
    async register(email, password, displayName) { return setSession(await raw('POST', '/v1/web/session/register', { body: { email, password, ...(displayName ? { displayName } : {}) } })); },
    // Continue with Google: asks the server for the Google URL (the server keeps state, nonce and the PKCE verifier in a short-lived HttpOnly cookie).
    async googleStart(next) { return raw('POST', '/v1/web/google/start', { body: next ? { next } : {} }); },
    refresh,
    async logout() { token = null; expiresAt = 0; return raw('POST', '/v1/web/session/logout', { body: {} }); },
    forget() { token = null; expiresAt = 0; },
    hasToken: () => !!token,
  };
}
