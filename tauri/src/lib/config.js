/** Configuration defaults and sanitising (stored as config.json in the app data folder). */

export const DEFAULT_CONFIG = Object.freeze({
  pollMinutes: 30,
  language: 'en',
  desktopNotifications: true,
  notifyOnAuthExpired: true,
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

export function sanitizeConfig(cfg) {
  const out = deepMerge(DEFAULT_CONFIG, cfg || {});
  out.pollMinutes = Math.min(1440, Math.max(5, Number(out.pollMinutes) || 30));
  out.language = out.language === 'vi' ? 'vi' : 'en';
  for (const k of ['desktopNotifications', 'notifyOnAuthExpired', 'launchAtStartup', 'startMinimized', 'closeToTray']) out[k] = !!out[k];
  out.semester = String(out.semester || '');
  for (const t of Object.keys(DEFAULT_CONFIG.webhooks)) {
    const w = out.webhooks[t];
    w.enabled = !!w.enabled;
    for (const [k, v] of Object.entries(w)) if (typeof v === 'string') w[k] = v.trim();
  }
  out.updates.auto = !!out.updates.auto;
  out.updates.url = String(out.updates.url || '').trim();
  return out;
}
