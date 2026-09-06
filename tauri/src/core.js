/**
 * Application core (runs inside the main WebView2 page): state, the refresh
 * pipeline (session -> semester -> timetable -> diff -> notify), scheduling,
 * change log, login/logout and self-update. Exposes the `tkb` object the UI
 * (app.js) talks to, mirroring the preload API of the Electron version.
 */
import { invoke, listen, httpFetch } from './bridge.js';
import { UsthClient, AuthError, normalizeTimetable, pickCurrentSemester, PORTAL_URL, parseJwt, DEFAULT_ACCOUNT } from './lib/usth-api.js';
import { diffSessions, describeDiff } from './lib/diff.js';
import * as notify from './lib/notify.js';
import { DEFAULT_CONFIG, deepMerge, sanitizeConfig, randomTopic } from './lib/config.js';

const MAX_CHANGES = 300;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

notify.setFetch(httpFetch);
const client = new UsthClient({ fetch: httpFetch });

const state = {
  authState: 'unknown', // unknown | ok | expired | signed-out
  user: null,
  semesters: [],
  semester: null,
  sessions: [],
  classes: [],
  lastChecked: null,
  lastSuccess: null,
  nextCheck: null,
  lastError: null,
  checking: false,
  loginOpen: false,
  tokenExpiresAt: null,
  version: '',
  defaultAccount: DEFAULT_ACCOUNT,
  update: null, // { version, notes, status: 'available'|'installing'|'failed', error? }
};

let config = null;
let startup = null;
let pollTimer = null;
let authExpiredNotified = false;
let lastUpdateCheck = 0;
const stateListeners = new Set();
const showChangesListeners = new Set();

// ---------- storage ----------

const store = {
  async read(name, fallback = null) {
    try {
      const raw = await invoke('store_read', { name });
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      log('store read failed', name, e.message || e);
      return fallback;
    }
  },
  async write(name, data) {
    await invoke('store_write', { name, value: JSON.stringify(data, null, 1) });
  },
};

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function loadConfig() {
  const saved = await store.read('config', {});
  const cfg = sanitizeConfig(deepMerge(DEFAULT_CONFIG, saved || {}));
  if (!cfg.webhooks.ntfy.topic) {
    cfg.webhooks.ntfy.topic = randomTopic();
    await store.write('config', cfg);
  }
  return cfg;
}

// ---------- state broadcast ----------

async function countUnreadChanges() {
  const changes = await store.read('changes', []) || [];
  const readAt = ((await store.read('meta', {})) || {}).changesReadAt || 0;
  return changes.filter((c) => c.at > readAt).length;
}

let unreadCache = 0;

function publicState() {
  return {
    ...state,
    user: state.user ? { fullName: state.user.fullName, studentId: state.user.studentId, email: state.user.email } : null,
    unreadChanges: unreadCache,
    pollMinutes: config ? config.pollMinutes : DEFAULT_CONFIG.pollMinutes,
    language: config ? config.language : 'en',
  };
}

async function broadcast() {
  unreadCache = await countUnreadChanges();
  const snapshot = publicState();
  for (const cb of stateListeners) { try { cb(snapshot); } catch (e) { log('listener failed', e); } }
  updateTray();
}

function updateTray() {
  const status = state.authState === 'ok'
    ? `Signed in as ${state.user ? state.user.fullName : '…'} · last check ${state.lastChecked ? new Date(state.lastChecked).toLocaleTimeString() : 'never'}`
    : state.authState === 'expired' ? 'Session expired – sign in again' : 'Not signed in';
  invoke('set_tray_tooltip', { text: `USTH Timetable\n${status}` }).catch(() => {});
  invoke('set_tray_login_label', { signedIn: state.authState === 'ok' }).catch(() => {});
}

function desktopNotify(title, body) {
  if (!config || !config.desktopNotifications) return;
  invoke('notify_desktop', { title, body }).catch((e) => log('desktop notification failed', e));
}

// ---------- core pipeline ----------

async function recordChanges(diff, semester) {
  const desc = describeDiff(diff, { lang: config.language, semester });
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    semester,
    title: desc.title,
    lines: desc.lines,
    counts: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
  };
  const changes = await store.read('changes', []) || [];
  changes.unshift(entry);
  await store.write('changes', changes.slice(0, MAX_CHANGES));
  return { entry, desc };
}

async function notifyChanges(desc, diff, semester) {
  const preview = desc.lines.slice(0, 4).map((l) => l.text).join('\n') + (desc.lines.length > 4 ? `\n… and ${desc.lines.length - 4} more` : '');
  desktopNotify(desc.title, preview);
  const payload = {
    semester,
    student: state.user ? { studentId: state.user.studentId, fullName: state.user.fullName } : null,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed.map((c) => ({ before: c.before, after: c.after, fields: c.fields, moved: c.moved })),
  };
  const results = await notify.dispatch(config.webhooks, { title: desc.title, text: desc.text, event: 'timetable.changed', priority: 'high', click: PORTAL_URL }, payload);
  for (const r of results) log('webhook', r.target, r.ok ? 'ok' : `failed: ${r.error}`);
  return results;
}

async function notifyAuthExpired() {
  if (authExpiredNotified) return;
  authExpiredNotified = true;
  const title = 'USTH Timetable: sign-in required';
  const text = 'The portal session has expired, so the timetable is no longer being watched. Open the app and sign in again.';
  desktopNotify(title, text);
  if (config.notifyOnAuthExpired) {
    const results = await notify.dispatch(config.webhooks, { title, text, event: 'auth.expired', priority: 'high' }, {});
    for (const r of results) log('webhook', r.target, r.ok ? 'ok' : `failed: ${r.error}`);
  }
}

async function openLogin(silent) {
  state.loginOpen = !silent;
  await broadcast();
  try {
    return await invoke('open_login', { silent });
  } finally {
    state.loginOpen = false;
    await broadcast();
  }
}

async function refresh({ reason = 'manual', allowSilentReauth = true } = {}) {
  if (state.checking) return publicState();
  state.checking = true;
  state.lastError = null;
  await broadcast();
  log('refresh start', reason);
  try {
    const cookie = await invoke('get_auth_cookie');
    if (!cookie) throw new AuthError('Not signed in');
    const jwt = parseJwt(cookie);
    state.tokenExpiresAt = jwt && jwt.exp ? jwt.exp * 1000 : null;

    let user;
    try {
      user = await client.getSession();
    } catch (e) {
      if (!(e instanceof AuthError) || !allowSilentReauth) throw e;
      log('session rejected, trying silent re-auth');
      const ok = await openLogin(true);
      if (!ok) throw e;
      user = await client.getSession();
      const c2 = await invoke('get_auth_cookie');
      const j2 = c2 ? parseJwt(c2) : null;
      state.tokenExpiresAt = j2 && j2.exp ? j2.exp * 1000 : null;
    }
    state.user = user;
    state.authState = 'ok';
    authExpiredNotified = false;

    const semesters = await client.getSemesters();
    state.semesters = semesters
      .map((s) => ({ semester: s.semester, startDate: s.startDate, endDate: s.endDate, current: !!s.isCurrentForClass }))
      .sort((a, b) => b.startDate - a.startDate);
    const chosen = config.semester ? semesters.find((s) => s.semester === config.semester) : null;
    const sem = chosen || pickCurrentSemester(semesters);
    if (!sem) throw new Error('No semester information returned by the portal');

    const classes = await client.fetchSemesterTimetable(sem);
    const { sessions, classes: classInfo } = normalizeTimetable(classes, sem.semester);

    const prev = await store.read('snapshot', null);
    if (prev && prev.semester === sem.semester && Array.isArray(prev.sessions)) {
      const diff = diffSessions(prev.sessions, sessions);
      if (diff.total) {
        log(`changes detected: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
        const { desc } = await recordChanges(diff, sem.semester);
        notifyChanges(desc, diff, sem.semester).catch((e) => log('notify failed', e.message));
      }
    }
    await store.write('snapshot', { semester: sem.semester, fetchedAt: Date.now(), sessions, classes: classInfo });
    state.semester = sem.semester;
    state.sessions = sessions;
    state.classes = classInfo;
    state.lastSuccess = Date.now();
    log(`refresh ok: ${classInfo.length} classes, ${sessions.length} sessions`);
  } catch (e) {
    if (e instanceof AuthError) {
      state.authState = state.user ? 'expired' : 'signed-out';
      state.lastError = e.message === 'Not signed in' ? null : `Session rejected: ${e.message}`;
      if (state.authState === 'expired') notifyAuthExpired().catch(() => {});
      log('auth problem', e.message);
    } else {
      state.lastError = String(e && e.message ? e.message : e);
      log('refresh failed', e && e.stack ? e.stack : e);
    }
  } finally {
    state.checking = false;
    state.lastChecked = Date.now();
    scheduleNext();
    await broadcast();
  }
  return publicState();
}

function scheduleNext() {
  if (pollTimer) clearTimeout(pollTimer);
  const ms = Math.max(5, config.pollMinutes) * 60 * 1000;
  state.nextCheck = Date.now() + ms;
  pollTimer = setTimeout(() => refresh({ reason: 'scheduled' }), ms);
}

async function login() {
  await invoke('show_main');
  await invoke('clear_browsing_data').catch((e) => log('clear browsing data failed', e));
  state.authState = state.user ? 'expired' : 'signed-out';
  const ok = await openLogin(false);
  if (ok) await refresh({ reason: 'login', allowSilentReauth: false });
  return publicState();
}

async function logout() {
  await invoke('clear_browsing_data').catch((e) => log('clear browsing data failed', e));
  state.authState = 'signed-out';
  state.user = null;
  state.tokenExpiresAt = null;
  await broadcast();
  return publicState();
}

// ---------- self-update ----------

/**
 * Asks the update feed for a newer release. With `install` (the default when
 * config.updates.auto is on) the new installer is downloaded and run; the app
 * closes and comes back as the new version.
 */
async function checkForUpdates({ install = config.updates.auto, manual = false } = {}) {
  lastUpdateCheck = Date.now();
  try {
    const info = await invoke('check_update', { endpoint: config.updates.url || null, install: false });
    if (!info) {
      state.update = manual ? { status: 'none', checkedAt: Date.now() } : null;
      await broadcast();
      return null;
    }
    state.update = { version: info.version, notes: info.notes || '', status: install ? 'installing' : 'available', checkedAt: Date.now() };
    await broadcast();
    if (install) {
      desktopNotify(`USTH Timetable ${info.version}`, 'A new version is being installed. The app will restart in a moment.');
      await invoke('check_update', { endpoint: config.updates.url || null, install: true });
      state.update = { ...state.update, status: 'installed' };
      await broadcast();
      invoke('restart_app').catch(() => {});
    }
    return state.update;
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    log('update check failed', msg);
    state.update = manual ? { status: 'failed', error: msg, checkedAt: Date.now() } : null;
    await broadcast();
    return state.update;
  }
}

function maybeCheckForUpdates() {
  if (!config.updates.auto) return;
  if (Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return;
  checkForUpdates({ install: true }).catch(() => {});
}

// ---------- public API ----------

export const tkb = {
  getState: async () => publicState(),
  refresh: () => refresh({ reason: 'ui' }),
  login,
  logout,
  getConfig: async () => config,
  setConfig: async (patch) => {
    const before = config;
    config = sanitizeConfig({ ...config, ...patch, webhooks: { ...config.webhooks, ...(patch.webhooks || {}) }, updates: { ...config.updates, ...(patch.updates || {}) } });
    await store.write('config', config);
    if (before.pollMinutes !== config.pollMinutes) scheduleNext();
    if (before.launchAtStartup !== config.launchAtStartup) invoke('set_autostart', { enabled: config.launchAtStartup }).catch((e) => log('autostart', e));
    if (before.closeToTray !== config.closeToTray) invoke('set_close_to_tray', { value: config.closeToTray }).catch(() => {});
    if (before.semester !== config.semester) refresh({ reason: 'semester-change' });
    await broadcast();
    return config;
  },
  getChanges: () => store.read('changes', []).then((v) => v || []),
  markChangesRead: async () => {
    const meta = (await store.read('meta', {})) || {};
    meta.changesReadAt = Date.now();
    await store.write('meta', meta);
    await broadcast();
    return true;
  },
  clearChanges: async () => { await store.write('changes', []); await broadcast(); return true; },
  testNotify: async () => {
    const title = 'USTH Timetable test notification';
    const text = `Notifications are working. Sent ${new Date().toLocaleString()}.`;
    desktopNotify(title, text);
    return notify.dispatch(config.webhooks, { title, text, event: 'test' }, {}, { force: true });
  },
  openExternal: (url) => invoke('open_external', { url }),
  isPasswordSaved: () => invoke('password_saved'),
  savePassword: (value) => invoke('password_set', { value: String(value || '') }),
  checkForUpdates: (opts) => checkForUpdates({ manual: true, install: false, ...opts }),
  installUpdate: () => checkForUpdates({ manual: true, install: true }),
  onState: (cb) => { stateListeners.add(cb); },
  onShowChanges: (cb) => { showChangesListeners.add(cb); },
  quit: () => invoke('quit_app'),
};

// ---------- boot ----------

export async function boot() {
  startup = await invoke('startup_info');
  state.version = startup.version;
  state.defaultAccount = startup.defaultAccount || DEFAULT_ACCOUNT;
  config = await loadConfig();
  await invoke('set_close_to_tray', { value: config.closeToTray }).catch(() => {});
  if (config.launchAtStartup) invoke('set_autostart', { enabled: true }).catch(() => {});

  const snap = await store.read('snapshot', null);
  if (snap && Array.isArray(snap.sessions)) {
    state.semester = snap.semester;
    state.sessions = snap.sessions;
    state.classes = snap.classes || [];
    state.lastSuccess = snap.fetchedAt || null;
  }

  await listen('tkb://refresh', () => refresh({ reason: 'tray' }));
  await listen('tkb://login', () => login());
  await listen('tkb://login-state', (open) => { state.loginOpen = !!open; broadcast(); });
  await listen('tkb://tick', () => {
    // Belt and braces: the Rust heartbeat fires even if the page's own timers are throttled.
    if (!state.checking && state.nextCheck && Date.now() >= state.nextCheck + 30000) refresh({ reason: 'heartbeat' });
    maybeCheckForUpdates();
  });

  if (!(config.startMinimized || startup.hiddenStart)) await invoke('show_main');
  await broadcast();
  refresh({ reason: 'startup' });
  setTimeout(() => maybeCheckForUpdates(), 20000);
  return tkb;
}
