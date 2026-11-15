// Number / time formatting. Missing values are shown as "—", never as 0.
export const DASH = '—';
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export function duration(ms) {
  if (!isNum(ms)) return DASH;
  const m = Math.round(ms / 60000);
  if (m < 1) return ms > 0 ? '< 1 min' : '0 min';
  const h = Math.floor(m / 60); const r = m % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${m} min`;
}
export const minutesToDuration = (min) => duration(isNum(min) ? min * 60000 : null);
export function num(v, decimals = 0) { return isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : DASH; }
export const withUnit = (v, unit, decimals = 0) => (isNum(v) ? `${num(v, decimals)}${unit === '%' || unit === '°C' ? '' : ' '}${unit}` : DASH);
export function dateTime(iso, locale) { const t = typeof iso === 'number' ? iso : Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : DASH; }
export function dayLabel(key, locale) { const t = Date.parse(`${key}T12:00:00Z`); return Number.isFinite(t) ? new Date(t).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : DASH; }
export function ago(iso, now = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso); if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : `${d} days ago`;
}
export const STATUS_TEXT = { active: 'Syncing now', offline: 'Offline', stale: 'Not synced recently', never: 'Never synced', removed: 'Removed' };
export const STAGE_TEXT = { seed: 'Seed', sprout: 'Sprout', young: 'Young plant', mature: 'Mature plant' };
