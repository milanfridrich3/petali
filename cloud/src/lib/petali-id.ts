import { randomBytes } from 'node:crypto';

// Petali ID: the permanent public identifier of an account. It is random (no relation to the email,
// the name or the creation order), looks like  PTL-7K3Q-9XMD-4HWB  and is never reused or edited.
//
//   - 12 symbols of Crockford base32 (no I, L, O, U: nothing that is easy to misread),
//   - the first 11 are random (55 bits), the 12th is a check symbol, so a mistyped ID can be told apart
//     from an unknown one without asking the database.
// Uniqueness is guaranteed by the database (unique index); the generator only makes collisions improbable.
export const PETALI_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PETALI_ID_REGEX = /^PTL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function checkSymbol(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum += (i + 1) * PETALI_ID_ALPHABET.indexOf(body[i] as string);
  return PETALI_ID_ALPHABET[sum % 32] as string;
}

export function generatePetaliId(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(11);
  let body = '';
  for (let i = 0; i < 11; i += 1) body += PETALI_ID_ALPHABET[(bytes[i] as number) & 31];
  const all = body + checkSymbol(body);
  return `PTL-${all.slice(0, 4)}-${all.slice(4, 8)}-${all.slice(8, 12)}`;
}

export function isValidPetaliId(value: unknown): value is string {
  if (typeof value !== 'string' || !PETALI_ID_REGEX.test(value)) return false;
  const flat = value.slice(4).replace(/-/g, '');
  return checkSymbol(flat.slice(0, 11)) === flat[11];
}
