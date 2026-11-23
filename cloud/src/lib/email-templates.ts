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

export type FamilyInvitationEmailInput = { inviterName: string; familyName: string; role: 'parent' | 'child' | string; code: string; ttlDays: number };

// The invitation code is bound to the invited identity (a Petali ID, or a verified email address): it is useless to anybody else, and it works once.
export function familyInvitationEmail({ inviterName, familyName, role, code, ttlDays }: FamilyInvitationEmailInput): { subject: string; text: string; html: string } {
  const subject = `${inviterName} invited you to the family "${familyName}" on Petali`;
  const text = [
    'Hi,', '',
    `${inviterName} invited you to join the family "${familyName}" on Petali (as: ${role}).`, '',
    'To accept: open Petali, go to Petali ID, then Family, and choose "I have an invitation code". Paste this code:', '', code, '',
    'You need a Petali ID to join. If you do not have one yet, create it first (in the Petali app or on the Petali ID website), then enter the code.',
    'Joining is your decision: nothing is shared with the family until you choose what to share, and you can leave at any time.',
    `The code works once and for ${ttlDays} days. It only works for the account it was meant for.`,
    'If you do not know this person, ignore this message: nothing happens until you accept.', '',
    'Petali',
  ].join('\n');
  const C = esc(code); const F = esc(familyName); const I = esc(inviterName);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ebf5e9;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ebf5e9;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#f9fbf5;border:1px solid #cce8cc;border-radius:18px;font-family:Manrope,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#17312c;">
<tr><td style="padding:26px 28px 0;font-size:18px;font-weight:700;color:#25664a;">Petali Family</td></tr>
<tr><td style="padding:14px 28px 0;font-size:22px;font-weight:700;line-height:1.25;">You are invited to "${F}"</td></tr>
<tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.6;">${I} invited you to join this family on Petali (role: ${esc(role)}). Joining is your decision. Nothing is shared with the family until you choose what to share.</td></tr>
<tr><td style="padding:16px 28px 0;font-size:14px;line-height:1.6;">Open Petali, go to <strong>Petali ID, Family</strong>, choose <strong>I have an invitation code</strong> and paste:</td></tr>
<tr><td style="padding:10px 28px 0;"><div style="font-family:'JetBrains Mono',Consolas,monospace;font-size:13px;background:#ebf5e9;border:1px solid #cce8cc;border-radius:10px;padding:12px;word-break:break-all;">${C}</div></td></tr>
<tr><td style="padding:14px 28px 0;font-size:13px;line-height:1.6;color:#55706a;">You need a Petali ID to join. No account yet? Create one first in the Petali app or on the Petali ID website. The code works once, for ${ttlDays} days, and only for the account it was meant for.</td></tr>
<tr><td style="padding:18px 28px 26px;font-size:12px;line-height:1.6;color:#55706a;border-top:1px solid #cce8cc;">If you do not know this person, ignore this message. Nothing happens until you accept.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
