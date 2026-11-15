import pino, { type DestinationStream, type Logger } from 'pino';

// Structured JSON logs. Credentials are never logged on purpose (the request logger records method, route,
// status, timing and ids only); the redaction list below is a second line of defence in case someone logs a
// request or response object by mistake in the future.
const REDACT = [
  'password', 'newPassword', 'currentPassword', 'refreshToken', 'accessToken', 'token', 'authorization', 'cookie',
  '*.password', '*.newPassword', '*.currentPassword', '*.refreshToken', '*.accessToken', '*.token', '*.authorization', '*.cookie',
  'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie', 'body', 'req.body',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, base: { service: 'petali-cloud' }, redact: { paths: REDACT, censor: '[redacted]' }, timestamp: pino.stdTimeFunctions.isoTime }, destination);
}

export type { Logger };
