// Moderation core (TypeScript port of the desktop's renderer/moderation.js; the shared test cases in moderation-cases.json keep the two in step).
// Whole-word matching on normalised text: no substring matching, so ordinary words never match by accident. The verdict never contains the matched word.
import { MODERATION_TERMS, MODERATION_VERSION } from './terms';

const SYM = '0-9@$!\u20ac\u00a3|';
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '\u20ac': 'e', '\u00a3': 'e', '|': 'i' };
const SEPARATED = new RegExp(`^(?:[a-z${SYM}][.\\-_*+]){2,}[a-z${SYM}]$`);
const SINGLE = new RegExp(`^[a-z${SYM}]$`);

export function normalize(text: unknown): string {
  const s = String(text == null ? '' : text).normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  if (s === '') return '';
  const chunks = s.split(' ').map((c) => (SEPARATED.test(c) ? c.replace(/[.\-_*+]/g, '') : c));
  const out: string[] = []; let run: string[] = [];
  const flush = (): void => { if (run.length >= 3) out.push(run.join('')); else out.push(...run); run = []; };
  for (const c of chunks) { if (c.length === 1 && SINGLE.test(c)) run.push(c); else { flush(); out.push(c); } }
  flush();
  return out.join(' ');
}
const tokens = (n: string): string[] => n.split(new RegExp(`[^a-z${SYM}*]+`)).map((t) => t.replace(/^\*+|\*+$/g, '')).filter(Boolean);
const unleet = (t: string): string => (/[a-z]/.test(t) ? t.replace(new RegExp(`[${SYM}]`, 'g'), (c) => LEET[c] ?? c) : t);
const single = (w: string): string => w.replace(/(.)\1+/g, '$1');

const exact = new Set<string>(MODERATION_TERMS);
const collapsed = new Set<string>(MODERATION_TERMS.map(single));
const byLength = new Map<number, string[]>();
for (const w of MODERATION_TERMS) { const l = byLength.get(w.length) ?? []; l.push(w); byLength.set(w.length, l); }

function known(base: string): boolean {
  if (exact.has(base)) return true;
  if (/(.)\1{2,}/.test(base)) return exact.has(base.replace(/(.)\1{2,}/g, '$1$1')) || exact.has(single(base)) || collapsed.has(single(base));
  return false;
}
// "f*ck", "k*rva": a * inside a word stands for exactly one hidden letter.
function masked(token: string): boolean {
  if (!token.includes('*')) return false;
  const re = new RegExp(`^${token.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z]')}$`);
  return (byLength.get(token.length) ?? []).some((w) => re.test(w));
}
function hit(token: string): boolean {
  const forms = new Set<string>([token]);
  const edge = token.replace(/^[!|]+|[!|]+$/g, ''); if (edge) forms.add(edge);
  const bare = edge.replace(/^\d+|\d+$/g, ''); if (bare) forms.add(bare);
  for (const f of forms) { const u = unleet(f); if (known(u) || masked(u)) return true; }
  return false;
}

export const isAllowedText = (text: unknown): boolean => { for (const t of tokens(normalize(text))) if (hit(t)) return false; return true; };
export { MODERATION_VERSION };
