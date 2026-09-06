'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, session, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

// Node tries IPv6/IPv4 addresses with a 250 ms attempt timeout by default, which
// makes connections to far-away hosts (ntfy, Discord, Telegram) fail on
// high-latency links. Give each attempt a realistic budget instead.
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
const { UsthClient, AuthError, normalizeTimetable, pickCurrentSemester, PORTAL_URL, ORIGIN, AUTH_COOKIE, AUTH_COOKIES, parseJwt } = require('./usth-api');
const { diffSessions, describeDiff } = require('./diff');
const notify = require('./notify');
const { JsonStore, loadConfig, sanitizeConfig } = require('./store');

const PARTITION = 'persist:usth';
const MAX_CHANGES = 300;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const SILENT_REAUTH_TIMEOUT_MS = 45 * 1000;

let mainWindow = null;
let loginWindow = null;
let tray = null;
let store, config, ses, client;
let pollTimer = null;
let authExpiredNotified = false;
let quitting = false;

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
  version: app.getVersion(),
};

// ---------- helpers ----------

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function cookieHeader() {
  const cookies = await ses.cookies.get({ url: ORIGIN });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function getAuthCookie() {
  const found = await ses.cookies.get({ url: ORIGIN, name: AUTH_COOKIE });
  return found.length ? found[0] : null;
}

async function clearAuthCookies() {
  for (const name of AUTH_COOKIES) {
    const found = await ses.cookies.get({ url: ORIGIN, name });
    for (const c of found) {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
      await ses.cookies.remove(url, name).catch(() => {});
    }
  }
}

function iconPath(name) {
  const p = path.join(__dirname, '..', 'assets', name);
  return fs.existsSync(p) ? p : null;
}

function publicState() {
  const unread = countUnreadChanges();
  return {
    ...state,
    user: state.user ? { fullName: state.user.fullName, studentId: state.user.studentId, email: state.user.email } : null,
    unreadChanges: unread,
    pollMinutes: config.pollMinutes,
    language: config.language,
  };
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state', publicState());
  updateTray();
}

function countUnreadChanges() {
  const changes = store.read('changes', []) || [];
  const readAt = (store.read('meta', {}) || {}).changesReadAt || 0;
  return changes.filter((c) => c.at > readAt).length;
}

function desktopNotify(title, body, onClick) {
  if (!config.desktopNotifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath('icon.png') || undefined });
  n.on('click', () => { showMainWindow(); if (onClick) onClick(); });
  n.show();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------- windows ----------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'USTH Timetable',
    icon: iconPath('icon.png') || undefined,
    backgroundColor: '#f6f7fb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!(config.startMinimized || process.argv.includes('--hidden'))) mainWindow.show();
  });
  mainWindow.on('close', (e) => {
    if (!quitting && config.closeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

/**
 * Opens the portal in a window using the persistent session and resolves true
 * once a (new) auth cookie is present. In silent mode the window is hidden
 * and only given a short time: the portal SPA re-runs SSO by itself when the
 * 24h token has expired but the SSO session is still alive.
 */
function openLoginWindow({ silent = false } = {}) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (!silent) { loginWindow.show(); loginWindow.focus(); }
    return loginWindow.__promise;
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    show: !silent,
    title: 'Sign in to USTH student portal',
    icon: iconPath('icon.png') || undefined,
    autoHideMenuBar: true,
    parent: !silent && mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  loginWindow = win;
  state.loginOpen = !silent;
  broadcast();

  const promise = new Promise(async (resolve) => {
    const before = await getAuthCookie();
    const beforeValue = before ? before.value : null;
    const timeoutMs = silent ? SILENT_REAUTH_TIMEOUT_MS : LOGIN_TIMEOUT_MS;
    const started = Date.now();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.destroy();
      resolve(ok);
    };
    const timer = setInterval(async () => {
      if (win.isDestroyed()) return finish(false);
      const c = await getAuthCookie().catch(() => null);
      if (c && c.value !== beforeValue) {
        // Give the SPA a moment to finish setting the second cookie.
        setTimeout(() => finish(true), 800);
        clearInterval(timer);
        return;
      }
      if (Date.now() - started > timeoutMs) finish(false);
    }, 1000);
    win.on('closed', () => finish(false));
    win.webContents.setWindowOpenHandler(({ url }) => {
      // Some SSO providers open a popup; load it in the same window instead.
      win.loadURL(url);
      return { action: 'deny' };
    });
  });
  win.__promise = promise;
  promise.finally(() => {
    if (loginWindow === win) loginWindow = null;
    state.loginOpen = false;
    broadcast();
  });
  win.loadURL(PORTAL_URL).catch(() => {});
  return promise;
}

// ---------- tray ----------

function createTray() {
  const p = iconPath('tray.png') || iconPath('icon.png');
  if (!p) return;
  try {
    tray = new Tray(nativeImage.createFromPath(p));
  } catch (e) {
    log('tray unavailable', e.message);
    return;
  }
  tray.on('click', () => showMainWindow());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const status = state.authState === 'ok'
    ? `Signed in as ${state.user ? state.user.fullName : '…'} · last check ${state.lastChecked ? new Date(state.lastChecked).toLocaleTimeString() : 'never'}`
    : state.authState === 'expired' ? 'Session expired – sign in again' : 'Not signed in';
  tray.setToolTip(`USTH Timetable\n${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => showMainWindow() },
    { label: 'Check now', click: () => refresh({ reason: 'tray' }) },
    { label: state.authState === 'ok' ? 'Re-sign in' : 'Sign in', click: () => login() },
    { type: 'separator' },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- core pipeline ----------

function recordChanges(diff, semester) {
  const desc = describeDiff(diff, { lang: config.language, semester });
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    semester,
    title: desc.title,
    lines: desc.lines,
    counts: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
  };
  const changes = store.read('changes', []) || [];
  changes.unshift(entry);
  store.write('changes', changes.slice(0, MAX_CHANGES));
  return { entry, desc };
}

async function notifyChanges(desc, diff, semester) {
  const preview = desc.lines.slice(0, 4).map((l) => l.text).join('\n') + (desc.lines.length > 4 ? `\n… and ${desc.lines.length - 4} more` : '');
  desktopNotify(desc.title, preview, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-changes');
  });
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
  desktopNotify(title, text, () => login());
  if (config.notifyOnAuthExpired) {
    const results = await notify.dispatch(config.webhooks, { title, text, event: 'auth.expired', priority: 'high' }, {});
    for (const r of results) log('webhook', r.target, r.ok ? 'ok' : `failed: ${r.error}`);
  }
}

async function refresh({ reason = 'manual', allowSilentReauth = true } = {}) {
  if (state.checking) return publicState();
  state.checking = true;
  state.lastError = null;
  broadcast();
  log('refresh start', reason);
  try {
    const cookie = await getAuthCookie();
    if (!cookie) throw new AuthError('Not signed in');
    const jwt = parseJwt(cookie.value);
    state.tokenExpiresAt = jwt && jwt.exp ? jwt.exp * 1000 : null;

    let user;
    try {
      user = await client.getSession();
    } catch (e) {
      if (!(e instanceof AuthError) || !allowSilentReauth) throw e;
      log('session rejected, trying silent re-auth');
      const ok = await openLoginWindow({ silent: true });
      if (!ok) throw e;
      user = await client.getSession();
      const c2 = await getAuthCookie();
      const j2 = c2 ? parseJwt(c2.value) : null;
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

    const prev = store.read('snapshot', null);
    if (prev && prev.semester === sem.semester && Array.isArray(prev.sessions)) {
      const diff = diffSessions(prev.sessions, sessions);
      if (diff.total) {
        log(`changes detected: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
        const { desc } = recordChanges(diff, sem.semester);
        notifyChanges(desc, diff, sem.semester).catch((e) => log('notify failed', e.message));
      }
    }
    store.write('snapshot', { semester: sem.semester, fetchedAt: Date.now(), sessions, classes: classInfo });
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
      state.lastError = e.message;
      log('refresh failed', e.stack || e.message);
    }
  } finally {
    state.checking = false;
    state.lastChecked = Date.now();
    scheduleNext();
    broadcast();
    captureForDebug();
  }
  return publicState();
}

/** Developer aid: TKB_SCREENSHOT=<file.png> saves a capture of the main window after each refresh. */
function captureForDebug() {
  const file = process.env.TKB_SCREENSHOT;
  if (!file || !mainWindow || mainWindow.isDestroyed()) return;
  setTimeout(async () => {
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
      log('screenshot saved', file);
    } catch (e) { log('screenshot failed', e.message); }
  }, 2000);
}

function scheduleNext() {
  if (pollTimer) clearTimeout(pollTimer);
  const ms = Math.max(5, config.pollMinutes) * 60 * 1000;
  state.nextCheck = Date.now() + ms;
  pollTimer = setTimeout(() => refresh({ reason: 'scheduled' }), ms);
}

async function login() {
  showMainWindow();
  await clearAuthCookies();
  state.authState = state.user ? 'expired' : 'signed-out';
  const ok = await openLoginWindow({ silent: false });
  if (ok) await refresh({ reason: 'login', allowSilentReauth: false });
  return publicState();
}

async function logout() {
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage'] }).catch(() => {});
  state.authState = 'signed-out';
  state.user = null;
  state.tokenExpiresAt = null;
  broadcast();
  return publicState();
}

/**
 * Developer/testing aid: TKB_IMPORT_COOKIES=<file> seeds the app session with a
 * raw Cookie header copied from the browser, so the app can be exercised
 * without going through the login window.
 */
async function importCookiesFromEnv() {
  const file = process.env.TKB_IMPORT_COOKIES;
  if (!file) return;
  try {
    const header = fs.readFileSync(file, 'utf8').trim();
    for (const part of header.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      await ses.cookies.set({ url: ORIGIN, name, value, secure: true, httpOnly: false, expirationDate: Math.floor(Date.now() / 1000) + 7 * 86400 });
    }
    await ses.cookies.flushStore();
    log('imported cookies from', file);
  } catch (e) {
    log('cookie import failed', e.message);
  }
}

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!config.launchAtStartup, args: ['--hidden'] });
  } catch (e) { log('login item', e.message); }
}

// ---------- ipc ----------

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('refresh', () => refresh({ reason: 'ui' }));
  ipcMain.handle('login', () => login());
  ipcMain.handle('logout', () => logout());
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, patch) => {
    const before = config;
    config = sanitizeConfig({ ...config, ...patch, webhooks: { ...config.webhooks, ...(patch.webhooks || {}) } });
    store.write('config', config);
    if (before.pollMinutes !== config.pollMinutes) scheduleNext();
    if (before.launchAtStartup !== config.launchAtStartup) applyLoginItem();
    if (before.semester !== config.semester) refresh({ reason: 'semester-change' });
    broadcast();
    return config;
  });
  ipcMain.handle('changes:get', () => store.read('changes', []) || []);
  ipcMain.handle('changes:read', () => {
    const meta = store.read('meta', {}) || {};
    meta.changesReadAt = Date.now();
    store.write('meta', meta);
    broadcast();
    return true;
  });
  ipcMain.handle('changes:clear', () => { store.write('changes', []); broadcast(); return true; });
  ipcMain.handle('notify:test', async () => {
    const title = 'USTH Timetable test notification';
    const text = `Notifications are working. Sent ${new Date().toLocaleString()}.`;
    desktopNotify(title, text);
    return notify.dispatch(config.webhooks, { title, text, event: 'test' }, {}, { force: true });
  });
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    store = new JsonStore(path.join(app.getPath('userData'), 'data'));
    config = loadConfig(store);
    ses = session.fromPartition(PARTITION);
    client = new UsthClient({ getCookieHeader: cookieHeader });
    await importCookiesFromEnv();

    const snap = store.read('snapshot', null);
    if (snap && Array.isArray(snap.sessions)) {
      state.semester = snap.semester;
      state.sessions = snap.sessions;
      state.classes = snap.classes || [];
      state.lastSuccess = snap.fetchedAt || null;
    }

    registerIpc();
    createTray();
    createMainWindow();
    applyLoginItem();
    refresh({ reason: 'startup' });
  });

  app.on('window-all-closed', () => {
    if (!tray || !config.closeToTray) app.quit();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', () => showMainWindow());
}
