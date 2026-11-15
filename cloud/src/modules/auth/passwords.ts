import argon2 from 'argon2';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { COMMON_PASSWORDS } from '../../lib/common-passwords';
import { normalizeEmail } from '../../lib/email';

export const PASSWORD_MIN = 7;   // 1.5.0 Phase 6: lowered from 10. Every other rule below is unchanged.
export const PASSWORD_MAX = 128;

// Password policy, in the spirit of NIST SP 800-63B: length matters, composition rules do not. Every character is
// allowed (spaces, emoji), nothing is truncated, and only obviously guessable choices are refused.
export function passwordProblem(password: string, email?: string): string | null {
  if (Array.from(password).length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password.trim().length === 0) return 'The password cannot be only spaces.';
  if (new Set(password).size < 4) return 'The password is too repetitive.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'That password is too common.';
  if (email) {
    const e = normalizeEmail(email);
    const local = e.split('@')[0] ?? '';
    if (password.toLowerCase() === e || (local.length >= 6 && password.toLowerCase() === local)) return 'The password cannot be your email address.';
  }
  return null;
}

// Zod field used wherever a NEW password is accepted. (A password that is merely being CHECKED at login is only
// length-bounded: an old account must still be able to sign in if the policy gets stricter later.)
export const newPasswordField = z.string().min(1, 'Required').max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`);
export const loginPasswordField = z.string().min(1, 'Required').max(PASSWORD_MAX);

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  /** Burns the same time as a real check, for logins that name an account that does not exist. */
  verifyDummy(password: string): Promise<void>;
};

export async function createPasswordHasher(cfg: Config['argon2']): Promise<PasswordHasher> {
  const options = { type: argon2.argon2id, memoryCost: cfg.memoryCost, timeCost: cfg.timeCost, parallelism: cfg.parallelism } as const;
  // A real hash of a random value, computed once: verifying against it takes as long as verifying a real account.
  const dummy = await argon2.hash(`dummy-${Math.random()}-${Date.now()}`, options);
  return {
    hash: (password) => argon2.hash(password, options),
    async verify(hash, password) {
      try { return await argon2.verify(hash, password); } catch { return false; }
    },
    needsRehash: (hash) => argon2.needsRehash(hash, options),
    async verifyDummy(password) {
      try { await argon2.verify(dummy, password); } catch { /* result is irrelevant */ }
    },
  };
}
