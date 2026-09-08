/** Configuration defaults and sanitising (stored as config.json in the app data folder). */

export const DEFAULT_CONFIG = Object.freeze({
  pollMinutes: 30,
  language: 'en',
  desktopNotifications: true,
  notifyOnAuthExpired: true,
  reloginRemindHours: 4, // repeat the "sign in again" notice this often; 0 = only once
  digest: { enabled: true, time: '20:00', whenEmpty: true }, // evening "tomorrow you have…" notice
  morning: { enabled: true, time: '07:00', whenEmpty: false }, // morning "today you have…" briefing
  launchAtStartup: false,
  startMinimized: false,
  closeToTray: true,
  semester: '',
  webhooks: {
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
    discord: { enabled: false, url: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    generic: { enabled: false, url: '', secret: '' },
  },
  updates: { auto: true, url: '' },
});

export function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function randomTopic() {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  return 'usth-tkb-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether a "sign in again" notice should go out now. The first one always does;
 * repeats wait `hours` after the previous one (0 = never repeat) and stay quiet
 * at night (23:00-07:00 local time) so the phone does not buzz while you sleep.
 */
export function reminderDue(lastAt, hours, now = Date.now()) {
  if (!lastAt) return true;
  if (!(hours > 0)) return false;
  if (now - lastAt < hours * 3600000) return false;
  const h = new Date(now).getHours();
  return h >= 7 && h < 23;
}

/** "H:MM" / "HH:MM" (24 h) -> "HH:MM"; null when it is not a time of day. */
export function normalizeTime(str) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(str ?? ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function sanitizeConfig(cfg) {
  const out = deepMerge(DEFAULT_CONFIG, cfg || {});
  out.pollMinutes = Math.min(1440, Math.max(5, Number(out.pollMinutes) || 30));
  out.language = out.language === 'vi' ? 'vi' : 'en';
  const remind = Number(out.reloginRemindHours);
  out.reloginRemindHours = Number.isFinite(remind) ? Math.min(168, Math.max(0, Math.round(remind))) : DEFAULT_CONFIG.reloginRemindHours;
  for (const k of ['desktopNotifications', 'notifyOnAuthExpired', 'launchAtStartup', 'startMinimized', 'closeToTray']) out[k] = !!out[k];
  out.semester = String(out.semester || '');
  out.digest = { ...out.digest }; // never write into the shared default object
  out.digest.enabled = !!out.digest.enabled;
  out.digest.whenEmpty = !!out.digest.whenEmpty;
  out.digest.time = normalizeTime(out.digest.time) || DEFAULT_CONFIG.digest.time;
  out.morning = { ...out.morning }; // never write into the shared default object
  out.morning.enabled = !!out.morning.enabled;
  out.morning.whenEmpty = !!out.morning.whenEmpty;
  out.morning.time = normalizeTime(out.morning.time) || DEFAULT_CONFIG.morning.time;
  for (const t of Object.keys(DEFAULT_CONFIG.webhooks)) {
    const w = out.webhooks[t];
    w.enabled = !!w.enabled;
    for (const [k, v] of Object.entries(w)) if (typeof v === 'string') w[k] = v.trim();
  }
  out.updates.auto = !!out.updates.auto;
  out.updates.url = String(out.updates.url || '').trim();
  return out;
}
