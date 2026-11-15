import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Config } from '../../config/env';
import { unauthorized } from '../../lib/errors';

// Access tokens: short-lived JWTs (HS256, secret from the environment). They carry only the user id (sub) and the
// session id (sid). They are NOT trusted on their own: the server also checks that the session is still active,
// so a logout or a revoked session takes effect immediately instead of when the token expires.
export type AccessClaims = { userId: string; sessionId: string };
export type TokenService = {
  issue(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }>;
  verify(token: string): Promise<AccessClaims>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTokenService(cfg: Pick<Config, 'jwtSecret' | 'jwtIssuer' | 'jwtAudience' | 'accessTokenTtlSeconds'>, now: () => number = Date.now): TokenService {
  const key = new TextEncoder().encode(cfg.jwtSecret);
  return {
    async issue({ userId, sessionId }) {
      const iat = Math.floor(now() / 1000);
      const exp = iat + cfg.accessTokenTtlSeconds;
      const token = await new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId).setIssuer(cfg.jwtIssuer).setAudience(cfg.jwtAudience).setIssuedAt(iat).setExpirationTime(exp)
        .sign(key);
      return { token, expiresAt: new Date(exp * 1000) };
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],            // never "none", never an asymmetric alg with our secret as the "key"
          issuer: cfg.jwtIssuer, audience: cfg.jwtAudience,
          currentDate: new Date(now()),
        });
        const sub = payload.sub; const sid = payload['sid'];
        if (typeof sub !== 'string' || typeof sid !== 'string' || !UUID.test(sub) || !UUID.test(sid)) throw unauthorized('invalid_token', 'The access token is not valid.');
        return { userId: sub, sessionId: sid };
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw unauthorized('token_expired', 'The access token has expired.');
        if (err && (err as { code?: string }).code === 'invalid_token') throw err;
        throw unauthorized('invalid_token', 'The access token is not valid.');
      }
    },
  };
}
