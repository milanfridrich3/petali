import { sha256Hex } from '../../lib/crypto';

// JSON with sorted keys, so the same content always gives the same text (and the same hash), whatever the key order was.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
}
export const hashOf = (value: unknown): string => sha256Hex(canonicalize(value));
