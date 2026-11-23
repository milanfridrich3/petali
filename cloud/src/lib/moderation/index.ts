import { AppError } from '../errors';
import { isAllowedText, MODERATION_VERSION } from './core';

export { isAllowedText, MODERATION_VERSION };

// Rejects text that is not allowed. The text itself is NEVER put in the error, the details or a log line: only the field name and the dictionary version.
export function assertAllowedText(field: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') return;
  if (!isAllowedText(value)) throw new AppError(422, 'inappropriate_text', 'This text contains words that are not allowed. Please choose another.', { details: { fields: [{ field, message: 'Not allowed.' }], dictionary: MODERATION_VERSION } });
}

// Applies assertAllowedText to the named top-level fields of a parsed body.
export function assertAllowedFields(body: unknown, fields: readonly string[]): void {
  if (!body || typeof body !== 'object') return;
  for (const f of fields) assertAllowedText(f, (body as Record<string, unknown>)[f]);
}
