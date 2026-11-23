// Netlify build step: turns the SUPPORT_* environment variables into the PUBLIC file support-config.json (site root) that the standalone Support Petali page (/support) reads.
// Nothing is hard-coded or committed: the repository ships a disabled support-config.json and this step overwrites it at build time. The recipient details are public by
// nature (they are inside the QR code). Rules:
//   * SUPPORT_RECIPIENT_NAME, SUPPORT_IBAN, SUPPORT_BIC must be set and valid (IBAN checksum, SEPA country, BIC shape). Missing/invalid -> disabled.
//   * SUPPORT_CURRENCY is optional and defaults to EUR (the only supported currency); any other value -> disabled.
//   * SUPPORT_PAYMENT_REFERENCE is optional (default "Petali support").
//   * SUPPORT_OWNER_CONFIRMED is an optional kill switch: only the value "false" (or "0"/"no") disables an otherwise valid configuration.
// The build log names missing/invalid FIELDS only, never values. With --require (the Netlify build uses it when SUPPORT_REQUIRE=true) a disabled result fails the build.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecipient } from '../support-assets/support-epc.js';

export const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'support-config.json');

export function buildSupportConfig(env) {
  const get = (k) => String(env[k] ?? '').trim();
  const missing = ['SUPPORT_RECIPIENT_NAME', 'SUPPORT_IBAN', 'SUPPORT_BIC'].filter((k) => get(k) === '');
  if (missing.length) return { config: { enabled: false }, log: `support: disabled (not set: ${missing.join(', ')})` };
  if (/^(false|0|no)$/i.test(get('SUPPORT_OWNER_CONFIRMED'))) return { config: { enabled: false }, log: 'support: disabled (SUPPORT_OWNER_CONFIRMED is "false")' };
  const r = validateRecipient({ currency: (get('SUPPORT_CURRENCY') || 'EUR').toUpperCase(), recipientName: get('SUPPORT_RECIPIENT_NAME'), iban: get('SUPPORT_IBAN'), bic: get('SUPPORT_BIC'), reference: get('SUPPORT_PAYMENT_REFERENCE') });
  if (!r.ok) return { config: { enabled: false }, log: `support: disabled (invalid: ${r.problems.join(', ')})` };
  return { config: { enabled: true, ...r.value }, log: 'support: enabled (EUR)' };
}

// Writes the file and reads it back, so the build log states what will really be deployed.
export function generate(env, file = OUTPUT) {
  const { config, log } = buildSupportConfig(env);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const back = JSON.parse(readFileSync(file, 'utf8'));
  return { config: back, enabled: back.enabled === true, log: `${log}; wrote ${file.split(/[\\/]/).pop()} (enabled=${back.enabled === true})` };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const r = generate(process.env);
  console.log(r.log);
  if (!r.enabled && (process.argv.includes('--require') || /^true$/i.test(process.env.SUPPORT_REQUIRE || ''))) { console.error('support: the payment configuration is required but not enabled - failing the build'); process.exit(1); }
}
