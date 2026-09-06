'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(name) { return path.join(this.dir, `${name}.json`); }
  read(name, fallback = null) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return fallback; }
  }
  write(name, data) {
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, target);
  }
  remove(name) {
    try { fs.unlinkSync(this.file(name)); } catch { /* ignore */ }
  }
}

const DEFAULT_CONFIG = Object.freeze({
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
});

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadConfig(store) {
  const saved = store.read('config', {}) || {};
  const cfg = deepMerge(DEFAULT_CONFIG, saved);
  if (!cfg.webhooks.ntfy.topic) {
    cfg.webhooks.ntfy.topic = `usth-tkb-${crypto.randomBytes(5).toString('hex')}`;
    store.write('config', cfg);
  }
  return cfg;
}

function sanitizeConfig(cfg) {
  const out = deepMerge(DEFAULT_CONFIG, cfg);
  out.pollMinutes = Math.min(1440, Math.max(5, Number(out.pollMinutes) || 30));
  out.language = out.language === 'vi' ? 'vi' : 'en';
  for (const k of ['desktopNotifications', 'notifyOnAuthExpired', 'launchAtStartup', 'startMinimized', 'closeToTray']) out[k] = !!out[k];
  out.semester = String(out.semester || '');
  for (const t of Object.keys(DEFAULT_CONFIG.webhooks)) {
    const w = out.webhooks[t];
    w.enabled = !!w.enabled;
    for (const [k, v] of Object.entries(w)) if (typeof v === 'string') w[k] = v.trim();
  }
  return out;
}

module.exports = { JsonStore, DEFAULT_CONFIG, deepMerge, loadConfig, sanitizeConfig };
