// QR rendering for Support Petali. The encoder is the vendored, unmodified qrcode-generator library; this module only feeds it UTF-8 bytes (EPC charset 1)
// at error-correction level M (what the EPC guideline recommends) and draws the result. No network, no storage.
import qrcode from './qrcode-generator.js';

qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(String(s)));

// text -> { size, isDark(row, col) }. Throws when the text does not fit in a QR code.
export function encodeQr(text) {
  const qr = qrcode(0, 'M'); qr.addData(String(text), 'Byte'); qr.make();
  const size = qr.getModuleCount();
  return { size, isDark: (r, c) => qr.isDark(r, c) };
}

// The matrix as one SVG path (unit squares); no inline style, so it works under the site's CSP.
export function qrPathData(matrix) {
  let d = '';
  for (let r = 0; r < matrix.size; r += 1) for (let c = 0; c < matrix.size; c += 1) if (matrix.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return d;
}

export const QUIET_ZONE = 4;
export function qrSvg(text, label) {
  const m = encodeQr(text); const total = m.size + QUIET_ZONE * 2; const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); svg.setAttribute('class', 'qr-code'); svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', String(total)); bg.setAttribute('height', String(total)); bg.setAttribute('fill', '#ffffff'); svg.append(bg);
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', qrPathData(m)); p.setAttribute('fill', '#000000'); svg.append(p);
  return svg;
}
