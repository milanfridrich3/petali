// Local stand-in for Netlify: serves the repo root, applies the same routing as netlify.toml, proxies /id/api/* to BACKEND. Dev only.
import http from 'node:http'; import { readFileSync, existsSync, statSync } from 'node:fs'; import { join, extname } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname; const BACKEND = process.env.BACKEND || 'http://127.0.0.1:8788'; const PORT = Number(process.env.PORT || 8899);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname;
  if (p.startsWith('/id/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await fetch(BACKEND + p.slice('/id/api'.length) + u.search, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))), body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual' }).catch(() => null);
    if (!r) { res.writeHead(502); return res.end('bad gateway'); }
    const h = {}; r.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') h[k] = v; }); const sc = r.headers.getSetCookie(); if (sc.length) h['set-cookie'] = sc;
    res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (p.startsWith('/id-dev/')) { res.writeHead(404); return res.end('404'); }
  // Same as netlify.toml: /id/support does not exist (404, never the app shell); /support is the standalone public page.
  if (p === '/id/support' || p.startsWith('/id/support/')) { res.writeHead(404); return res.end('404'); }
  // Same routing as netlify.toml (rules ignore a trailing slash): /id and /id/ are forced rewrites to the app shell; /id/* only when no file exists.
  let f = p === '/' ? 'index.html' : p.slice(1); if (p.replace(/\/+$/, '') === '/support') f = 'support.html'; let abs = join(ROOT, f);
  if (p.replace(/\/+$/, '') === '/id') abs = join(ROOT, 'id/index.html');
  else if (existsSync(abs) && statSync(abs).isDirectory()) abs = join(abs, 'index.html');
  if (!existsSync(abs) && p.startsWith('/id/')) abs = join(ROOT, 'id/index.html');
  if (!existsSync(abs)) { res.writeHead(404); return res.end('404'); }
  const h = { 'Content-Type': TYPES[extname(abs)] || 'application/octet-stream' };
  if (p === '/id/sw.js') { h['Cache-Control'] = 'no-cache'; h['Service-Worker-Allowed'] = '/id/'; }
  res.writeHead(200, h); res.end(readFileSync(abs));
}).listen(PORT, () => console.log(`dev server http://localhost:${PORT}`));
