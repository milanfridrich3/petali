import type { RequestHandler } from 'express';

// Cross-origin access to the API, restricted to an exact allow-list of browser origins (https://petali.netlify.app plus explicitly listed preview origins).
// The Petali ID website normally calls the API through its own origin (the Netlify /id/api proxy), and the desktop app is not a browser, so most requests carry
// no Origin header and are untouched. Credentials (cookies) are NEVER allowed cross-origin: the cookie session endpoints keep their own same-origin check.
// An origin that is not on the list gets no CORS headers (the browser blocks it); its preflight is answered 403 without revealing the list.
const METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const HEADERS = 'Authorization, Content-Type, X-Request-Id';

export function cors(allowed: readonly string[]): RequestHandler {
  const set = new Set(allowed);
  return (req, res, next) => {
    const origin = req.headers.origin;
    res.vary('Origin');
    if (typeof origin !== 'string') return next();
    const ok = set.has(origin);
    if (req.method === 'OPTIONS' && typeof req.headers['access-control-request-method'] === 'string') {
      if (!ok) { res.status(403).json({ error: { code: 'cors_origin_not_allowed', message: 'This origin is not allowed.' } }); return; }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', METHODS);
      res.setHeader('Access-Control-Allow-Headers', HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end(); return;
    }
    if (ok) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Petali-API-Version, Retry-After'); }
    next();
  };
}
