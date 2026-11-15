// Client-side copy of the password rule, for instant feedback only. The SERVER is authoritative (cloud/src/modules/auth/passwords.ts) and its answer
// is always shown when it disagrees. Login never applies this: an existing account must always be able to sign in.
export const PASSWORD_MIN = 7;
export const PASSWORD_MAX = 128;
export function passwordProblem(pw) {
  const n = Array.from(String(pw ?? '')).length;
  if (n < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (n > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (String(pw).trim().length === 0) return 'The password cannot be only spaces.';
  return null;
}
export const PASSWORD_HINT = `At least ${PASSWORD_MIN} characters. Avoid common passwords.`;
