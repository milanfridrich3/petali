import type { Config } from '../config/env';
import type { Logger } from './logger';

// Email delivery (1.5.0 Phase 6). One small interface, one real provider (Resend, over its HTTPS API: no extra dependency), and an explicit
// "not configured" state. The caller always learns the TRUTH: send() resolves only after the provider accepted the message and rejects with a
// MailError otherwise. Nothing here ever pretends a message was delivered, and the API key never leaves this module (it is not logged).
export type MailMessage = { to: string; subject: string; text: string; html: string };
export type MailErrorCode = 'not_configured' | 'provider_rejected' | 'provider_unreachable';
export class MailError extends Error {
  constructor(public readonly code: MailErrorCode, message: string, public readonly providerStatus?: number) { super(message); this.name = 'MailError'; }
}
export type Mailer = { readonly configured: boolean; send(message: MailMessage): Promise<void> };

export function createMailer(config: Config['email'], log: Logger, fetchImpl: typeof fetch = fetch): Mailer {
  if (config.provider === 'none' || !config.apiKey || !config.from) {
    return { configured: false, async send() { throw new MailError('not_configured', 'Email delivery is not configured on this server.'); } };
  }
  const { apiKey, from, replyTo, apiUrl, timeoutMs } = config;
  return {
    configured: true,
    async send(m) {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${apiUrl}/emails`, {
          method: 'POST', signal: ctl.signal,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'user-agent': 'petali-cloud' },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        });
      } catch (err) {
        log.warn({ reason: (err as Error).name === 'AbortError' ? 'timeout' : 'network' }, 'email provider unreachable');
        throw new MailError('provider_unreachable', 'The email provider could not be reached.');
      } finally { clearTimeout(timer); }
      if (!res.ok) {
        // The provider's answer may say why (unverified sender domain, invalid address). Log the status only, never the key or the recipient.
        log.warn({ status: res.status }, 'email provider rejected the message');
        throw new MailError('provider_rejected', 'The email provider did not accept the message.', res.status);
      }
    },
  };
}
