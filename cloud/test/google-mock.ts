import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

// A LOCAL STAND-IN for Google, used only by the tests. It is NOT Google: it implements just enough of the token endpoint and the key set so the backend's REAL
// code path (HTTP token exchange, remote JWKS fetch, RS256 signature check, claim checks) runs against it. Tests that use it are "mocked", never "real Google".
export type MockCode = { clientId: string; redirectUri: string; challenge: string; used?: boolean; claims: Record<string, unknown>; signWith?: 'good' | 'other' };
export type GoogleMock = {
  url: string; clientId: string; clientSecret: string; issuer: string;
  issueCode(o: { redirectUri: string; challenge: string; nonce: string; sub: string; email: string; emailVerified?: boolean | string; name?: string; clientId?: string; overrides?: Record<string, unknown>; signWith?: 'good' | 'other'; omit?: string[] }): string;
  tokenCalls: number; close(): Promise<void>;
};

export async function startGoogleMock(clientId = 'mock-web-client.apps.googleusercontent.com', clientSecret = 'mock-secret-not-real', port = 0): Promise<GoogleMock> {
  const good = await generateKeyPair('RS256'); const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: 'good-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, MockCode>();
  const state = { tokenCalls: 0 };
  const issue = (o: any): string => api.issueCode(o);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && req.url === '/certs') return send(200, { keys: [jwk] });
      // Used only by the standalone end-to-end run (test/google-mock-server.ts): lets a browser-side stand-in for Google's consent page get a code.
      if (req.method === 'POST' && req.url === '/issue') { const o = JSON.parse(Buffer.concat(chunks).toString() || '{}'); return send(200, { code: issue(o) }); }
      if (req.method === 'POST' && req.url === '/token') {
        state.tokenCalls += 1;
        const p = new URLSearchParams(Buffer.concat(chunks).toString());
        const rec = codes.get(p.get('code') ?? '');
        if (!rec || rec.used) return send(400, { error: 'invalid_grant' });
        if (p.get('grant_type') !== 'authorization_code' || p.get('client_id') !== rec.clientId || p.get('client_secret') !== clientSecret || p.get('redirect_uri') !== rec.redirectUri) return send(400, { error: 'invalid_grant' });
        if (createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== rec.challenge) return send(400, { error: 'invalid_grant', error_description: 'Bad Request' });
        rec.used = true;
        const jwt = new SignJWT({ ...rec.claims }).setProtectedHeader({ alg: 'RS256', kid: 'good-1' });
        const key = rec.signWith === 'other' ? other.privateKey : good.privateKey;
        return send(200, { access_token: 'mock-access', token_type: 'Bearer', id_token: await jwt.sign(key) });
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issuer = 'https://accounts.google.com';
  const api = {
    url, clientId, clientSecret, issuer,
    get tokenCalls() { return state.tokenCalls; },
    issueCode(o) {
      const iat = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = { iss: issuer, aud: o.clientId ?? clientId, azp: o.clientId ?? clientId, sub: o.sub, email: o.email, email_verified: o.emailVerified ?? true, name: o.name ?? 'Test Person', nonce: o.nonce, iat, exp: iat + 3600, ...(o.overrides ?? {}) };
      for (const k of o.omit ?? []) delete claims[k];
      const code = `mock-${randomBytes(12).toString('hex')}`;
      codes.set(code, { clientId: o.clientId ?? clientId, redirectUri: o.redirectUri, challenge: o.challenge, claims, ...(o.signWith ? { signWith: o.signWith } : {}) });
      return code;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  } as GoogleMock;
  return api;
}
