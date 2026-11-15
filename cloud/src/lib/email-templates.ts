// Petali's transactional emails. Visual identity follows the desktop app (see renderer/index.html tokens): deep green ink, mint sky, warm paper,
// Manrope falls back to system sans because email clients do not load web fonts. Inline CSS + tables only (the only thing mail clients agree on).
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export type VerificationEmailInput = { displayName: string | null; link: string; ttlHours: number };

export function verificationEmail({ displayName, link, ttlHours }: VerificationEmailInput): { subject: string; text: string; html: string } {
  const hello = displayName ? `Hi ${displayName},` : 'Hi,';
  const subject = 'Confirm your email for Petali ID';
  const text = [
    hello, '',
    'Welcome to Petali. Confirm your email address to finish setting up your Petali ID:', '', link, '',
    `This link works for ${ttlHours} hours. If it expires you can request a new one from the Petali ID sign-in page.`,
    'If you did not create a Petali ID, you can ignore this message: nothing happens until the link is opened.', '',
    'Petali',
  ].join('\n');
  const L = esc(link);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ebf5e9;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ebf5e9;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#f9fbf5;border:1px solid #cce8cc;border-radius:18px;font-family:Manrope,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#17312c;">
<tr><td style="padding:26px 28px 6px;"><table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td style="width:34px;height:34px;background:#25664a;border-radius:10px;text-align:center;color:#ffffff;font-size:18px;line-height:34px;">&#127807;</td>
<td style="padding-left:10px;font-size:18px;font-weight:700;color:#25664a;">Petali ID</td></tr></table></td></tr>
<tr><td style="padding:14px 28px 0;font-size:22px;font-weight:700;line-height:1.25;">Confirm your email</td></tr>
<tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.6;color:#17312c;">${esc(hello)}<br>Welcome to Petali. Confirm your email address to finish setting up your Petali ID.</td></tr>
<tr><td style="padding:22px 28px 6px;"><a href="${L}" style="display:inline-block;background:#25664a;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 24px;border-radius:12px;">Confirm email</a></td></tr>
<tr><td style="padding:14px 28px 0;font-size:13px;line-height:1.6;color:#55706a;">This link works for ${ttlHours} hours. If it expires, request a new one from the Petali ID sign-in page.</td></tr>
<tr><td style="padding:14px 28px 0;font-size:12px;line-height:1.6;color:#55706a;">Button not working? Copy this address into your browser:<br><a href="${L}" style="color:#25664a;word-break:break-all;">${L}</a></td></tr>
<tr><td style="padding:18px 28px 26px;font-size:12px;line-height:1.6;color:#55706a;border-top:1px solid #cce8cc;margin-top:18px;">If you did not create a Petali ID you can ignore this message. Nothing happens until the link is opened.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
