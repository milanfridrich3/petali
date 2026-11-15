import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

// Opaque, high-entropy secrets (refresh tokens). 256 random bits, so a plain SHA-256 of the token is a
// sufficient thing to store: there is nothing to brute-force, unlike a human-chosen password.
export const newOpaqueToken = (prefix: string): string => `${prefix}_${randomBytes(32).toString('base64url')}`;

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
