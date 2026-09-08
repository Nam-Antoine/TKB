import { tkb, boot } from './core.js';
import { t, setLang, getLang, applyDom, dayNames, fmtDayShort, fmtDateLong, fmtMonthTitle, sessionCount } from './lib/i18n.js';

const PERIODS = [
  ['07:30', '08:20'], ['08:25', '09:15'], ['09:25', '10:15'], ['10:25', '11:15'], ['11:20', '12:10'],
  ['13:00', '13:50'], ['13:55', '14:45'], ['14:55', '15:45'], ['15:55', '16:45'], ['16:50', '17:40'],
  ['17:45', '18:35'], ['18:45', '19:35'], ['19:45', '20:35'], ['20:45', '21:35'],
];
const PALETTE = [
  ['#dbeafe', '#2563eb'], ['#dcfce7', '#16a34a'], ['#fef3c7', '#d97706'], ['#fee2e2', '#dc2626'], ['#ede9fe', '#7c3aed'],
  ['#cffafe', '#0891b2'], ['#fce7f3', '#db2777'], ['#ecfccb', '#65a30d'], ['#ffedd5', '#ea580c'], ['#e0e7ff', '#4f46e5'],
];
const VIEWS = ['month', 'day', 'week', 'agenda', 'classes'];
const VIEW_KEY = 'tkb.view.v2';

const $ = (id) => document.getElementById(id);
let state = null;
let config = null;
let cursor = startOfDay(new Date()); // the selected day (Month/Day views) or a day of the shown week (Week view)
let view = loadView();
let changesOpen = false;

// ---------- date helpers (all on local calendar dates, using YYYY-MM-DD keys) ----------

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function startOfWeek(d) {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28)); }
function keyOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtLong(k) { return fmtDateLong(parseKey(k)); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }
function minutes(hhmm) { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + m; }

function loadView() {
  try { const v = localStorage.getItem(VIEW_KEY); if (VIEWS.includes(v)) return v; } catch { /* storage unavailable */ }
  return 'month';
}
function saveView(v) { try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } }

/** Row position (0-based, fractional) for a "HH:MM" time within the period grid. */
function rowForTime(hhmm) {
  const tm = minutes(hhmm);
  for (let i = 0; i < PERIODS.length; i++) {
    const s = minutes(PERIODS[i][0]);
    const nextS = i + 1 < PERIODS.length ? minutes(PERIODS[i + 1][0]) : minutes(PERIODS[i][1]) + 10;
    if (tm < nextS) return i + Math.max(0, (tm - s) / (nextS - s));
  }
  return PERIODS.length;
}

function colorFor(courseId) {
  let h = 0;
  for (const ch of String(courseId || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function courseName(s) {
  return (getLang() === 'vi' ? (s.courseName || s.courseNameEn) : (s.courseNameEn || s.courseName)) || s.courseId;
}

function esc(str) { return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- language ----------

/** Applies config.language to the page: static texts, <html lang>, the EN/VI switch. */
function applyLanguage() {
  setLang(config ? config.language : 'en');
  document.documentElement.lang = getLang();
  applyDom(document);
  document.querySelectorAll('#lang-switch .lang').forEach((b) => b.classList.toggle('active', b.dataset.lang === getLang()));
  const sel = $('settings-form').elements.language;
  if (sel) sel.value = getLang();
}

async function switchLanguage(lang) {
  if (!config || config.language === lang) return;
  config = await tkb.setConfig({ language: lang });
  applyLanguage();
  render();
  if (changesOpen) renderChanges();
}

// ---------- rendering ----------

function renderHeader() {
  const s = state;
  const userLine = $('user-line');
  const statusLine = $('status-line');
  const loginBtn = $('btn-login');
  if (s.user) {
    userLine.textContent = `${s.user.fullName} · ${s.user.studentId}${s.semester ? ` · ${t('semesterOf', { s: s.semester })}` : ''}`;
  } else {
    userLine.textContent = s.authState === 'expired' ? t('sessionExpired') : t('notSignedIn');
  }
  const parts = [];
  if (s.checking) parts.push(`<span class="ok">${esc(t('checking'))}</span>`);
  else if (s.lastChecked) parts.push(esc(t('lastCheck', { t: new Date(s.lastChecked).toLocaleTimeString() })));
  if (s.nextCheck && !s.checking) parts.push(esc(t('nextCheck', { t: new Date(s.nextCheck).toLocaleTimeString() })));
  if (s.lastSuccess) parts.push(esc(t('dataFrom', { t: new Date(s.lastSuccess).toLocaleString() })));
  if (s.tokenExpiresAt) parts.push(esc(t('sessionUntil', { t: new Date(s.tokenExpiresAt).toLocaleString() })));
  if (s.lastError) parts.push(`<span class="err">${esc(s.lastError)}</span>`);
  if (s.update && s.update.version && s.update.status !== 'none') {
    parts.push(`<span class="warn">${esc(t('updateStatus', { v: s.update.version, status: t(`status.${s.update.status}`) }))}</span>`);
  }
  statusLine.innerHTML = parts.join(' · ');

  // The sign-in button only appears while it is needed (signed out / session expired).
  loginBtn.hidden = s.authState === 'ok';
  loginBtn.disabled = s.loginOpen;
  loginBtn.title = s.authState === 'expired' ? t('signInAgainTitle') : t('signInTitle');
  $('btn-login-2').disabled = s.loginOpen;
  $('btn-refresh').disabled = s.checking;
  $('btn-refresh').classList.toggle('spin', !!s.checking);

  const badge = $('changes-badge');
  badge.hidden = !s.unreadChanges;
  badge.textContent = s.unreadChanges;

  const banner = $('banner');
  if (s.authState === 'expired') {
    banner.hidden = false;
    banner.textContent = t('bannerExpired');
  } else if (s.lastError && s.authState === 'ok') {
    banner.hidden = false;
    banner.textContent = t('bannerFailed', { e: s.lastError });
  } else {
    banner.hidden = true;
  }

  const sel = $('semester-select');
  const wanted = (config && config.semester) || '';
  const options = [`<option value="">${esc(t('currentSemester'))}${s.semester && !wanted ? ` (${esc(s.semester)})` : ''}</option>`]
    .concat((s.semesters || []).map((x) => `<option value="${esc(x.semester)}">${esc(x.semester)}${x.current ? ` ${esc(t('current'))}` : ''}</option>`));
  if (sel.innerHTML !== options.join('')) sel.innerHTML = options.join('');
  sel.value = wanted;

  const hasData = s.sessions && s.sessions.length;
  $('empty').hidden = !!hasData || s.authState === 'ok';
  document.querySelector('.toolbar').style.visibility = hasData || s.authState === 'ok' ? 'visible' : 'hidden';
}

function sessionsByDay(keys) {
  const map = new Map(keys.map((k) => [k, []]));
  for (const s of state.sessions || []) if (map.has(s.dateKey)) map.get(s.dateKey).push(s);
  return map;
}

/** Marks up one day's sessions as cards (Now / Next / Exam / Cancelled tags, past sessions dimmed). */
function sessionCards(list, dayKey) {
  const todayKey = keyOf(new Date());
  const now = new Date();
  const nowMin = dayKey === todayKey ? now.getHours() * 60 + now.getMinutes() : null;
  let nextMarked = false;
  return list.map((s) => {
    const [, border] = colorFor(s.courseId);
    const startMin = minutes(s.startTime), endMin = minutes(s.endTime);
    const cancelled = s.status === 5;
    const tags = [];
    let cls = '';
    if (cancelled) { tags.push(`<span class="tag cancelled">${esc(t('tagCancelled'))}</span>`); cls += ' cancelled'; }
    if (s.isExam) tags.push(`<span class="tag exam">${esc(t('tagExam'))}</span>`);
    if (nowMin != null && !cancelled) {
      if (nowMin >= startMin && nowMin <= endMin) tags.push(`<span class="tag now">${esc(t('tagNow'))}</span>`);
      else if (endMin < nowMin) cls += ' past';
      else if (!nextMarked) { nextMarked = true; tags.push(`<span class="tag next">${esc(t('tagNext'))}</span>`); }
    }
    const periods = s.from < 100 && s.to < 100 ? `<span>${esc(t('periods', { a: s.from, b: s.to }))}</span>` : '';
    return `<div class="card${cls}" data-id="${esc(s.id)}" style="border-left-color:${border}">
      <div class="time"><b>${esc(s.startTime)}</b><span>${esc(t('toTime', { t: s.endTime }))}</span>${periods}</div>
      <div>
        <div class="name">${esc(courseName(s))}</div>
        <div class="meta">${esc(s.place || t('roomNotSet'))} · ${esc(s.lessonType)} ${esc(s.classId)}</div>
        ${s.teachers.length ? `<div class="meta">${esc(s.teachers.join(', '))}</div>` : ''}
      </div>
      <div class="tags">${tags.join('')}</div>
    </div>`;
  }).join('');
}

function bindCards(box) {
  box.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    const s = state.sessions.find((x) => x.id === c.dataset.id);
    if (s) showSession(s);
  }));
}

/** Month view: a month calendar with a dot on every day that has sessions; the selected day's sessions on the right. */
function renderMonth() {
  const todayKey = keyOf(new Date());
  const selKey = keyOf(cursor);
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const rows = Math.ceil(((first.getDay() + 6) % 7 + daysInMonth) / 7); // only the weeks this month touches (4–6)
  const days = Array.from({ length: rows * 7 }, (_, i) => addDays(gridStart, i));
  const keys = days.map(keyOf);
  const byDay = sessionsByDay(keys);
  const names = dayNames();

  $('month-title').textContent = fmtMonthTitle(cursor);
  const cells = names.map((n) => `<div class="mg-head">${esc(n)}</div>`);
  days.forEach((d, i) => {
    const k = keys[i];
    const n = byDay.get(k).length;
    const cls = ['mg-day'];
    if (d.getMonth() !== cursor.getMonth()) cls.push('other');
    if (k === selKey) cls.push('selected');
    if (k === todayKey) cls.push('today');
    if (n) cls.push('has');
    cells.push(`<div class="${cls.join(' ')}" data-day="${k}" title="${esc(sessionCount(n))}"><span class="n">${d.getDate()}</span>${n ? '<i class="dot"></i>' : ''}</div>`);
  });
  const grid = $('month-grid');
  grid.innerHTML = cells.join('');
  grid.querySelectorAll('.mg-day').forEach((c) => c.addEventListener('click', () => { cursor = parseKey(c.dataset.day); renderMonth(); }));

  const list = (state.sessions || []).filter((s) => s.dateKey === selKey);
  const label = `${fmtLong(selKey)}${selKey === todayKey ? ` · ${t('todayWord')}` : ''} · ${sessionCount(list.length)}`;
  $('week-label').textContent = label;
  $('month-sub').textContent = label;
  const box = $('month-list');
  box.innerHTML = list.length ? sessionCards(list, selKey) : `<div class="day-empty">${esc(t('noSessions'))}</div>`;
  bindCards(box);
}

/** Day view: a strip of the seven days around the cursor and the selected day's sessions as cards. */
function renderDay() {
  const todayKey = keyOf(new Date());
  const ws = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const keys = days.map(keyOf);
  const byDay = sessionsByDay(keys);
  const selKey = keyOf(cursor);
  const list = byDay.get(selKey) || [];
  const names = dayNames();
  $('week-label').textContent = `${fmtLong(selKey)}${selKey === todayKey ? ` · ${t('todayWord')}` : ''} · ${sessionCount(list.length)}`;

  const strip = $('day-strip');
  strip.innerHTML = days.map((d, i) => {
    const k = keys[i];
    const n = byDay.get(k).length;
    const dots = Array.from({ length: Math.min(n, 4) }, () => '<i></i>').join('');
    return `<div class="day-chip${k === selKey ? ' selected' : ''}${k === todayKey ? ' today' : ''}" data-day="${k}" title="${esc(sessionCount(n))}"><div class="wd">${esc(names[i])}</div><div class="dn">${d.getDate()}</div><div class="dots">${dots}</div></div>`;
  }).join('');
  strip.querySelectorAll('.day-chip').forEach((c) => c.addEventListener('click', () => { cursor = parseKey(c.dataset.day); renderDay(); }));

  const box = $('day-list');
  box.innerHTML = list.length ? sessionCards(list, selKey) : `<div class="day-empty">${esc(t('noSessionsOn', { d: fmtLong(selKey) }))}</div>`;
  bindCards(box);
}

/** Assign overlapping sessions of one day to columns. Returns [{s, col, cols}]. */
function layoutDay(list) {
  const items = list.map((s) => {
    const top = s.from >= 100 ? rowForTime(s.startTime) : s.from - 1;
    const bottom = s.to >= 100 ? rowForTime(s.endTime) : s.to;
    return { s, top, bottom: Math.max(bottom, top + 0.6), col: 0, cols: 1 };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // greedy column assignment inside clusters of overlapping items
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((i) => i.col + 1));
    for (const i of cluster) i.cols = cols;
    cluster = []; clusterEnd = -1;
  };
  for (const it of items) {
    if (cluster.length && it.top >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.bottom > it.top).map((c) => c.col));
    let col = 0; while (used.has(col)) col++;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  if (cluster.length) flush();
  return items;
}

function renderWeek() {
  const grid = $('week-grid');
  const todayKey = keyOf(new Date());
  const weekStart = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const keys = days.map(keyOf);
  const byDay = sessionsByDay(keys);
  const end = addDays(weekStart, 6);
  const weekSessions = keys.reduce((n, k) => n + byDay.get(k).length, 0);
  const names = dayNames();
  $('week-label').textContent = `${fmtDayShort(weekStart)} – ${fmtDayShort(end)} ${end.getFullYear()} · ${sessionCount(weekSessions)}`;

  const html = ['<div class="wg-corner"></div>'];
  days.forEach((d, i) => {
    html.push(`<div class="wg-day${keys[i] === todayKey ? ' today' : ''}">${esc(names[i])}<span class="d">${esc(fmtDayShort(d))}</span></div>`);
  });
  PERIODS.forEach((p, r) => {
    html.push(`<div class="wg-time"><b>${r + 1}</b>${p[0]}</div>`);
    keys.forEach((k) => html.push(`<div class="wg-cell${k === todayKey ? ' today' : ''}${r === 5 ? ' lunch' : ''}" data-day="${k}" data-row="${r}"></div>`));
  });
  grid.innerHTML = html.join('');

  const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 46;
  const headerH = 38;
  const gridRect = grid.getBoundingClientRect();
  const firstCells = keys.map((k) => grid.querySelector(`.wg-cell[data-day="${k}"][data-row="0"]`));
  keys.forEach((k, di) => {
    const cell = firstCells[di];
    if (!cell) return;
    const cellRect = cell.getBoundingClientRect();
    const left0 = cellRect.left - gridRect.left;
    const width0 = cellRect.width;
    for (const it of layoutDay(byDay.get(k))) {
      const s = it.s;
      const [bg, border] = colorFor(s.courseId);
      const el = document.createElement('div');
      el.className = `session${s.isExam ? ' exam' : ''}${s.status === 5 ? ' cancelled' : ''}`;
      el.style.background = bg;
      el.style.borderLeftColor = border;
      const w = width0 / it.cols;
      el.style.left = `${left0 + it.col * w + 2}px`;
      el.style.width = `${w - 4}px`;
      el.style.top = `${headerH + it.top * rowH + 1}px`;
      el.style.height = `${(it.bottom - it.top) * rowH - 3}px`;
      el.title = `${courseName(s)} (${s.classId})\n${s.startTime}–${s.endTime} · ${s.place}\n${s.teachers.join(', ')}`;
      el.innerHTML = `<div class="name">${esc(courseName(s))}</div><div class="meta">${esc(s.startTime)}–${esc(s.endTime)} · ${esc(s.place || '?')}</div><div class="meta">${esc(s.lessonType)} ${esc(s.classId)}${s.teachers.length ? ' · ' + esc(s.teachers.join(', ')) : ''}</div>`;
      el.addEventListener('click', () => showSession(s));
      grid.appendChild(el);
    }
  });

  if (keys.includes(todayKey)) {
    const now = new Date();
    const hh = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (minutes(hh) >= minutes(PERIODS[0][0]) && minutes(hh) <= minutes(PERIODS[PERIODS.length - 1][1])) {
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.top = `${headerH + rowForTime(hh) * rowH}px`;
      grid.appendChild(line);
    }
  }
}

function renderAgenda() {
  const box = $('agenda');
  const todayKey = keyOf(new Date());
  const groups = new Map();
  for (const s of state.sessions || []) {
    if (!groups.has(s.dateKey)) groups.set(s.dateKey, []);
    groups.get(s.dateKey).push(s);
  }
  const keys = [...groups.keys()].sort();
  if (!keys.length) { box.innerHTML = `<p class="hint">${esc(t('noSessionsSemester'))}</p>`; return; }
  const html = [];
  for (const k of keys) {
    html.push(`<h4 class="${k === todayKey ? 'today' : ''}" id="agenda-${k}">${esc(fmtLong(k))}${k === todayKey ? ` · ${esc(t('todayWord'))}` : ''}</h4>`);
    for (const s of groups.get(k)) {
      const [, border] = colorFor(s.courseId);
      html.push(`<div class="row" data-id="${esc(s.id)}"><div><span class="swatch" style="background:${border}"></span>${esc(s.startTime)}–${esc(s.endTime)}</div><div><b>${esc(courseName(s))}</b> <span class="muted">${esc(s.classId)} · ${esc(s.lessonType)}</span></div><div>${esc(s.place)}</div><div class="muted">${esc(s.teachers.join(', '))}</div></div>`);
    }
  }
  box.innerHTML = html.join('');
  box.querySelectorAll('.row').forEach((row) => row.addEventListener('click', () => {
    const s = state.sessions.find((x) => x.id === row.dataset.id);
    if (s) showSession(s);
  }));
  const first = keys.find((k) => k >= todayKey);
  const target = first ? document.getElementById(`agenda-${first}`) : null;
  if (target) target.scrollIntoView({ block: 'start' });
}

function renderClasses() {
  const box = $('classes');
  const classes = state.classes || [];
  if (!classes.length) { box.innerHTML = `<p class="hint">${esc(t('noClasses'))}</p>`; return; }
  const rows = classes.map((c) => {
    const [, border] = colorFor(c.courseId);
    const next = (state.sessions || []).find((s) => s.classId === c.classId && s.dateKey >= keyOf(new Date()));
    return `<tr><td><span class="swatch" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${border};margin-right:8px"></span>${esc(c.classId)}</td><td>${esc(courseName(c))}</td><td>${esc(c.classType)}</td><td>${c.sessionCount}</td><td>${next ? `${esc(fmtLong(next.dateKey))} ${esc(next.startTime)} · ${esc(next.place)}` : '—'}</td></tr>`;
  });
  box.innerHTML = `<table><thead><tr><th>${esc(t('colClass'))}</th><th>${esc(t('colCourse'))}</th><th>${esc(t('colType'))}</th><th>${esc(t('colSessions'))}</th><th>${esc(t('colNext'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderView() {
  for (const v of VIEWS) $(`view-${v}`).hidden = view !== v;
  document.querySelectorAll('.view-switch .seg').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const navigable = view === 'month' || view === 'day' || view === 'week';
  document.querySelector('.nav').style.visibility = navigable ? 'visible' : 'hidden';
  // The month calendar has its own arrows, so the toolbar keeps only "Today" there.
  $('btn-prev').hidden = view === 'month';
  $('btn-next').hidden = view === 'month';
  if (view === 'month') renderMonth();
  else if (view === 'day') renderDay();
  else if (view === 'week') renderWeek();
  else if (view === 'agenda') renderAgenda();
  else renderClasses();
}

function render() {
  if (!state) return;
  renderHeader();
  renderView();
}

/** Moves the Month view by n months, the Day view by n days or the Week view by n weeks. */
function step(n) {
  cursor = view === 'month' ? addMonths(cursor, n) : addDays(cursor, view === 'week' ? 7 * n : n);
  renderView();
}

function showSession(s) {
  $('session-title').textContent = `${courseName(s)} (${s.classId})`;
  const rows = [
    [t('fDate'), fmtLong(s.dateKey)],
    [t('fTime'), `${s.startTime} – ${s.endTime} (${t('periods', { a: s.from, b: s.to })})`],
    [t('fRoom'), s.place || '—'],
    [t('fType'), `${s.lessonType || '—'}${s.isExam ? ` ${t('examSuffix')}` : ''}`],
    [t('fTeacher'), s.teachers.join(', ') || '—'],
    [t('fAssistants'), s.assistants && s.assistants.length ? s.assistants.join(', ') : '—'],
    [t('fCourse'), `${s.courseNameEn || ''}${s.courseNameEn && s.courseName ? ' / ' : ''}${s.courseName || ''} (${s.courseId})`],
    [t('fWeek'), s.week || '—'],
    [t('fNote'), s.note || '—'],
    [t('fReason'), s.reason || '—'],
    [t('fSemester'), s.semester],
  ];
  $('session-details').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('modal-session').hidden = false;
}

async function renderChanges() {
  const list = await tkb.getChanges();
  const box = $('changes-list');
  if (!list.length) { box.innerHTML = `<p class="hint">${esc(t('noChanges'))}</p>`; return; }
  const readAt = state && state.unreadChanges ? Infinity : 0;
  box.innerHTML = list.map((c, i) => {
    const lines = c.lines.map((l) => `<span class="${l.kind === '+' ? 'l-add' : l.kind === '-' ? 'l-del' : 'l-mod'}">${esc(l.text)}</span>`).join('\n');
    const unread = i < (state ? state.unreadChanges : 0) && readAt;
    return `<div class="change${unread ? ' unread' : ''}"><div class="when">${esc(fmtTime(c.at))}</div><div class="ttl">${esc(c.title)}</div><pre>${lines}</pre></div>`;
  }).join('');
}

async function openChanges() {
  changesOpen = true;
  $('drawer-changes').hidden = false;
  await renderChanges();
  await tkb.markChangesRead();
}

function closeChanges() {
  changesOpen = false;
  $('drawer-changes').hidden = true;
}

// ---------- settings ----------

function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, p, v) {
  const parts = p.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[parts[parts.length - 1]] = v;
}

function fillSettings() {
  const form = $('settings-form');
  for (const el of form.elements) {
    if (!el.name || el.name.startsWith('_')) continue;
    const v = getPath(config, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v == null ? '' : v;
  }
  $('settings-msg').textContent = '';
  $('update-msg').textContent = '';
  $('digest-msg').textContent = '';
  $('morning-msg').textContent = '';
  $('about-line').textContent = t('about', { v: state && state.version ? state.version : '', a: state ? state.defaultAccount : 'namtk2410702' });
}

function readSettings() {
  const form = $('settings-form');
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.name.startsWith('_')) continue;
    setPath(out, el.name, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value);
  }
  return out;
}

async function openSettings() {
  config = await tkb.getConfig();
  fillSettings();
  $('modal-settings').hidden = false;
}

// ---------- wiring ----------

function bind() {
  $('btn-refresh').addEventListener('click', () => tkb.refresh());
  $('btn-login').addEventListener('click', () => tkb.login());
  $('btn-login-2').addEventListener('click', () => tkb.login());
  $('btn-relogin').addEventListener('click', () => { $('modal-settings').hidden = true; tkb.login(); });
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', () => { $('modal-settings').hidden = true; });
  $('btn-changes').addEventListener('click', () => (changesOpen ? closeChanges() : openChanges()));
  $('btn-close-changes').addEventListener('click', closeChanges);
  $('btn-close-session').addEventListener('click', () => { $('modal-session').hidden = true; });
  $('btn-prev').addEventListener('click', () => step(-1));
  $('btn-next').addEventListener('click', () => step(1));
  $('btn-month-prev').addEventListener('click', () => step(-1));
  $('btn-month-next').addEventListener('click', () => step(1));
  $('btn-today').addEventListener('click', () => { cursor = startOfDay(new Date()); renderView(); });
  document.querySelectorAll('.view-switch .seg').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; saveView(view); renderView(); }));
  document.querySelectorAll('#lang-switch .lang').forEach((b) => b.addEventListener('click', () => switchLanguage(b.dataset.lang)));
  $('semester-select').addEventListener('change', async (e) => {
    config = await tkb.setConfig({ semester: e.target.value });
  });
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    config = await tkb.setConfig(readSettings());
    applyLanguage();
    $('settings-msg').textContent = t('saved');
    render();
  });
  $('btn-check-update').addEventListener('click', async () => {
    config = await tkb.setConfig(readSettings());
    applyLanguage();
    $('update-msg').textContent = t('checkingShort');
    const r = await tkb.checkForUpdates();
    if (!r || r.status === 'none') $('update-msg').textContent = t('latestVersion', { v: state.version });
    else if (r.status === 'failed') $('update-msg').textContent = t('checkFailed', { e: r.error });
    else {
      $('update-msg').innerHTML = `${esc(t('versionAvailable', { v: r.version }))} <button type="button" class="btn small" id="btn-install-update">${esc(t('installNow'))}</button>`;
      $('btn-install-update').addEventListener('click', async () => {
        $('update-msg').textContent = t('downloading', { v: r.version });
        const res = await tkb.installUpdate();
        if (res && res.status === 'failed') $('update-msg').textContent = t('installFailed', { e: res.error });
      });
    }
  });
  $('btn-digest-now').addEventListener('click', async () => {
    $('digest-msg').textContent = t('savingSending');
    config = await tkb.setConfig(readSettings());
    applyLanguage();
    const r = await tkb.sendDigest();
    if (!r || r.status !== 'sent') $('digest-msg').textContent = t('digestNoData');
    else $('digest-msg').textContent = r.results.length
      ? r.results.map((x) => `${x.target}: ${x.ok ? t('sent') : t('failedWith', { e: x.error })}`).join(' · ')
      : t('desktopOnly');
  });
  $('btn-morning-now').addEventListener('click', async () => {
    $('morning-msg').textContent = t('savingSending');
    config = await tkb.setConfig(readSettings());
    applyLanguage();
    const r = await tkb.sendMorning();
    if (!r || r.status !== 'sent') $('morning-msg').textContent = t('digestNoData');
    else $('morning-msg').textContent = r.results.length
      ? r.results.map((x) => `${x.target}: ${x.ok ? t('sent') : t('failedWith', { e: x.error })}`).join(' · ')
      : t('desktopOnly');
  });
  $('btn-test-notify').addEventListener('click', async () => {
    $('settings-msg').textContent = t('savingSending');
    config = await tkb.setConfig(readSettings());
    applyLanguage();
    const results = await tkb.testNotify();
    $('settings-msg').textContent = results.length
      ? results.map((r) => `${r.target}: ${r.ok ? t('sent') : t('failedWith', { e: r.error })}`).join(' · ')
      : t('desktopOnly');
  });
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); closeChanges(); }
    if ((view === 'month' || view === 'day' || view === 'week') && !e.target.closest('input,select')) {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    }
  });
  window.addEventListener('resize', () => { if (view === 'week') renderWeek(); });
  tkb.onState((s) => {
    state = s;
    if (config && s.language && s.language !== config.language) { config = { ...config, language: s.language }; applyLanguage(); }
    render();
    if (changesOpen) renderChanges();
  });
  tkb.onShowChanges(() => openChanges());
  setInterval(() => { if (state) { renderHeader(); if (view === 'day') renderDay(); else if (view === 'month') renderMonth(); } }, 30000);
}

(async function init() {
  bind();
  try {
    await boot();
  } catch (e) {
    $('status-line').innerHTML = `<span class="err">${esc(t('startupFailed', { e: e && e.message ? e.message : e }))}</span>`;
    return;
  }
  config = await tkb.getConfig();
  applyLanguage();
  state = await tkb.getState();
  render();
})();
