// What may be synchronised. Every document kind has a scope (account-wide or one device's), a key format, a size cap, a
// merge rule and a validator. The server stores documents as JSON and does not interpret them beyond these checks;
// the desktop app sanitises everything again when it applies a document.
export type Scope = 'account' | 'device';
import type { MergeName } from './merge';
export type Merge = MergeName;
export type KindDef = { scope: Scope; key: RegExp; maxBytes: number; merge: Merge; allowDelete: boolean; validate: (data: unknown, key: string) => string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
export const PLANT_DAILY_CAP_MS = 4 * 3_600_000;
const DAY_MS = 86_400_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export function dateKeyOk(key: string): boolean {
  const t = Date.parse(`${key.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) && t >= Date.parse('2020-01-01T00:00:00Z') && t <= Date.now() + 2 * DAY_MS;
}

const dayDoc = (extra: (o: Record<string, unknown>) => string | null) => (data: unknown, key: string): string | null => {
  if (!isObj(data)) return 'must be an object';
  if (data['dayKey'] !== key) return 'dayKey does not match the key';
  if (!dateKeyOk(key)) return 'date out of range';
  return extra(data);
};

const SETTING_KEY = /^(ui\.(lang|plant|name|effects|mode|autoNight|prefs)|dashboard\.layout|notify\.config|apps\.override\.[\w .()+-]{1,80})$/;
const SETTING_MAX: Record<string, number> = { 'dashboard.layout': 65536, 'ui.prefs': 8192, 'ui.autoNight': 1024, 'notify.config': 2048 };

function validateSetting(data: unknown, key: string): string | null {
  switch (key) {
    case 'ui.lang': return data === 'cs' || data === 'en' ? null : 'must be "cs" or "en"';
    case 'ui.plant': return typeof data === 'string' && data.length >= 1 && data.length <= 32 ? null : 'must be a short string';
    case 'ui.name': return typeof data === 'string' && data.length <= 20 ? null : 'must be a string of at most 20 characters';
    case 'ui.effects': return typeof data === 'boolean' ? null : 'must be a boolean';
    case 'ui.mode': return data === null || data === 'day' || data === 'night' ? null : 'must be "day", "night" or null';
    case 'ui.autoNight': case 'ui.prefs': case 'dashboard.layout': return isObj(data) ? null : 'must be an object';
    case 'notify.config': return isObj(data) && typeof data['enabled'] === 'boolean' && isObj(data['types']) ? null : 'must be {enabled, types}';
    default: return typeof data === 'string' && data.length >= 1 && data.length <= 40 ? null : 'a category must be a short string';   // apps.override.<exe>
  }
}

export const KINDS: Record<string, KindDef> = {
  setting: {
    scope: 'account', key: SETTING_KEY, maxBytes: 65536, merge: 'lww', allowDelete: true, validate: validateSetting,
  },
  // usage sessions + Active Work of one day on one device
  day: {
    scope: 'device', key: DAY, maxBytes: 262_144, merge: 'day', allowDelete: false,
    validate: dayDoc((o) => (num(o['activeMs'], 0, DAY_MS * 1.01) && Array.isArray(o['sessions']) && o['sessions'].length <= 2000 ? null : 'invalid activeMs or sessions')),
  },
  // app usage of one day on one device
  apps: {
    scope: 'device', key: DAY, maxBytes: 262_144, merge: 'apps', allowDelete: false,
    validate: dayDoc((o) => (isObj(o['apps']) && Object.keys(o['apps']).length <= 2000 && Array.isArray(o['hourly']) && o['hourly'].length <= 48 ? null : 'invalid apps or hourly')),
  },
  // hardware daily/hourly summaries of one month on one device
  rollup: {
    scope: 'device', key: MONTH, maxBytes: 524_288, merge: 'rollup', allowDelete: false,
    validate: (data, key) => (isObj(data) && dateKeyOk(`${key}-01`) ? null : 'must be an object for a valid month'),
  },
  // Device Health events of one month on one device
  health: {
    scope: 'device', key: MONTH, maxBytes: 524_288, merge: 'health', allowDelete: false,
    validate: (data, key) => (isObj(data) && dateKeyOk(`${key}-01`) && Array.isArray(data['lines']) && data['lines'].length <= 20000 ? null : 'must be {lines: [...]} for a valid month'),
  },
  // plant growth credits of one device: {baseMs, days:{day: ms}}; merged per day by maximum, never replaced
  plant: {
    scope: 'device', key: /^ledger$/, maxBytes: 65_536, merge: 'maxmap', allowDelete: false,
    validate: (data) => {
      if (!isObj(data) || !num(data['baseMs'], 0, 1e10) || !isObj(data['days'])) return 'must be {baseMs, days}';
      const days = data['days'];
      const keys = Object.keys(days);
      if (keys.length > 4000) return 'too many days';
      for (const k of keys) { if (!DAY.test(k) || !dateKeyOk(k) || !num(days[k], 0, PLANT_DAILY_CAP_MS)) return `invalid credit for ${k}`; }
      return null;
    },
  },
};
