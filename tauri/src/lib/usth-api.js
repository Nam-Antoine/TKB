/**
 * Client for the USTH student portal API (erp.usth.edu.vn/student-services).
 *
 * The portal front-end wraps request/response bodies as
 * { payload: base64(AES-256-CBC(JSON)) } using a fixed key/IV derived from two
 * constants shipped in the web bundle (key = SHA-256 of one, IV = MD5 of the
 * other), and signs POST bodies with an x-check-sum header (SHA-256 over a
 * canonical JSON of the primitive fields). This module re-implements that with
 * WebCrypto only, so it runs unchanged inside the WebView2 page and in Node tests.
 *
 * Cookies are NOT handled here: the Rust side attaches the portal cookies to
 * every request going to erp.usth.edu.vn.
 */

export const ORIGIN = 'https://erp.usth.edu.vn';
export const BASE = ORIGIN + '/student-services';
export const PORTAL_URL = ORIGIN + '/students/learn/timetable';
export const AUTH_COOKIE = 'x-student-portal-token';
export const AUTH_COOKIES = ['x-student-portal-token', 'x-access-token'];
export const TIMEZONE = 'Asia/Ho_Chi_Minh';
/** The account this app is built for: pre-filled on the portal login form. */
export const DEFAULT_ACCOUNT = 'namtk2410702';

// sha256('304c7f6dff373663d32879ac1c1f1318') and md5('069635c0806598e069583aee5440e448')
const KEY_HEX = 'b997e6b8aa2b1e0ceda049d5a702902fbdc65447e2d029821932d9700ccef62a';
const IV_HEX = '21a851e40e72ed93f3a5af3bc92a6bd8';

/** Class period -> wall-clock time at USTH (copied from the portal's own table). */
export const PERIOD_TIMES = {
  from: { 1: '07:30', 2: '08:25', 3: '09:25', 4: '10:25', 5: '11:20', 6: '13:00', 7: '13:55', 8: '14:55', 9: '15:55', 10: '16:50', 11: '17:45', 12: '18:45', 13: '19:45', 14: '20:45' },
  to: { 1: '08:20', 2: '09:15', 3: '10:15', 4: '11:15', 5: '12:10', 6: '13:50', 7: '14:45', 8: '15:45', 9: '16:45', 10: '17:40', 11: '18:35', 12: '19:35', 13: '20:35', 14: '21:35' },
};
export const PERIOD_COUNT = 14;

export class AuthError extends Error {
  constructor(message, status) { super(message); this.name = 'AuthError'; this.status = status; }
}
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.name = 'ApiError'; this.status = status; this.data = data; }
}

// ---------- crypto (WebCrypto) ----------

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const utf8dec = new TextDecoder();

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function bytesToBase64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

let keyPromise = null;
function aesKey() {
  if (!keyPromise) keyPromise = subtle.importKey('raw', hexToBytes(KEY_HEX), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  return keyPromise;
}

export async function encryptPayload(obj) {
  const ct = await subtle.encrypt({ name: 'AES-CBC', iv: hexToBytes(IV_HEX) }, await aesKey(), utf8.encode(JSON.stringify(obj)));
  return bytesToBase64(ct);
}

export async function decryptPayload(b64) {
  const pt = await subtle.decrypt({ name: 'AES-CBC', iv: hexToBytes(IV_HEX) }, await aesKey(), base64ToBytes(b64));
  return JSON.parse(utf8dec.decode(pt));
}

export async function sha256Hex(text) {
  return bytesToHex(await subtle.digest('SHA-256', utf8.encode(text)));
}

export async function hmacSha256Hex(secret, text) {
  const key = await subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(await subtle.sign('HMAC', key, utf8.encode(text)));
}

/** x-check-sum = sha256(JSON.stringify(JSON.stringify(sorted primitive fields of body))) as hex. */
export async function checksum(body) {
  if (!body || typeof body !== 'object') return '';
  const prim = Object.fromEntries(Object.entries(body)
    .filter(([, v]) => v === null || (typeof v !== 'object' && typeof v !== 'function'))
    .sort(([a], [b]) => a.localeCompare(b)));
  return sha256Hex(JSON.stringify(JSON.stringify(prim)));
}

export function parseJwt(token) {
  try {
    const part = String(token).split('.')[1];
    const bytes = base64ToBytes(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(utf8dec.decode(bytes));
  } catch { return null; }
}

// ---------- client ----------

/**
 * @param {object} opts
 * @param {(url: string, init: {method: string, headers: object, body?: string}) => Promise<{status: number, text: () => Promise<string>}>} opts.fetch
 */
export class UsthClient {
  constructor({ fetch: fetchImpl }) {
    this.fetch = fetchImpl || globalThis.fetch;
  }

  _headers(extra) {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: ORIGIN,
      referer: PORTAL_URL,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      ...extra,
    };
  }

  async _handle(res) {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (data && typeof data === 'object' && typeof data.payload === 'string') {
      try { data = await decryptPayload(data.payload); } catch (e) {
        throw new ApiError('Could not decrypt response: ' + e.message, res.status, text.slice(0, 200));
      }
    }
    const msg = data && typeof data === 'object' ? String(data.message || '') : '';
    if (res.status === 401 || res.status === 403 || /invalid token|hết phiên|chưa đăng nhập/i.test(msg)) {
      throw new AuthError(msg || 'Not authenticated', res.status);
    }
    if (res.status >= 400) throw new ApiError(msg || `HTTP ${res.status}`, res.status, data);
    return data;
  }

  async get(path, params, { encrypt = false } = {}) {
    let url = BASE + path;
    if (encrypt) {
      const p = params && Object.keys(params).length ? params : { requestTime: Date.now() };
      url += '?payload=' + encodeURIComponent(await encryptPayload(p));
    } else if (params && Object.keys(params).length) {
      url += '?' + new URLSearchParams(params).toString();
    }
    const res = await this.fetch(url, { method: 'GET', headers: this._headers({ 'cache-control': 'no-cache' }) });
    return this._handle(res);
  }

  async post(path, body) {
    const res = await this.fetch(BASE + path, {
      method: 'POST',
      headers: this._headers({ 'x-check-sum': await checksum(body) }),
      body: JSON.stringify({ payload: await encryptPayload(body) }),
    });
    return this._handle(res);
  }

  /** Current user, or throws AuthError. */
  async getSession() {
    const data = await this.get('/api/v1/auth/session', null, { encrypt: true });
    if (!data || !data.user) throw new AuthError('No user in session');
    return data.user;
  }

  async getSemesters() {
    const data = await this.get('/api/v1/semesters');
    return Array.isArray(data) ? data : [];
  }

  async queryTimetableInRange({ fromTime, toTime, semester, weeks, rangeCode }) {
    const data = await this.post('/api/v2/timetables/query-student-timetable-in-range', {
      fromTime, toTime, semester, weeks, rangeCode: rangeCode || `${fromTime}-${toTime}`,
    });
    return Array.isArray(data) ? data : [];
  }

  /** Every class with its concrete sessions for a whole semester (the web app queries one week or month at a time). */
  async fetchSemesterTimetable(sem) {
    const weekMs = 7 * 86400000;
    const nWeeks = Math.max(1, Math.ceil((sem.endDate - sem.startDate) / weekMs) + 1);
    const startWeek = Number.isFinite(sem.startWeek) ? sem.startWeek : 1;
    const weeks = Array.from({ length: nWeeks }, (_, i) => i + startWeek);
    return this.queryTimetableInRange({
      fromTime: sem.startDate, toTime: sem.endDate, semester: sem.semester, weeks, rangeCode: `sem-${sem.semester}`,
    });
  }
}

// ---------- normalisation ----------

const dateKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short' });
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function dateKeyOf(ms) { return dateKeyFmt.format(new Date(ms)); }
export function weekdayOf(ms) { return WEEKDAY_INDEX[weekdayFmt.format(new Date(ms))]; }

/** Period number (1..14) or an HHMM number (e.g. 900 for an exam) -> "HH:MM". */
export function periodToTime(n, edge) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 100) {
    const h = Math.floor(v / 100), m = v % 100;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return PERIOD_TIMES[edge][Math.min(PERIOD_COUNT, Math.max(1, Math.round(v)))] || '';
}

function parseCalendar(entry) {
  if (typeof entry === 'string') { try { return JSON.parse(entry); } catch { return null; } }
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * Flatten the API class list into one record per concrete session.
 * Entries without a real date (template rows from old semesters) are dropped.
 */
export function normalizeTimetable(classes, semesterCode) {
  const sessions = [];
  const classInfo = [];
  for (const cls of classes || []) {
    const raw = Array.isArray(cls._calendars) && cls._calendars.length ? cls._calendars : (cls.calendars || []);
    const cals = raw.map(parseCalendar).filter(Boolean);
    const withDate = cals.filter((c) => Number(c.date) > 0);
    if (!withDate.length) continue;
    const isExam = String(cls.classType || '').toUpperCase() === 'EXAM' || /EXAM/i.test(String(cls.classId || ''));
    classInfo.push({
      classId: cls.classId || '',
      courseId: cls.courseId || '',
      courseName: cls.courseName || cls.name || '',
      courseNameEn: cls.courseNameEn || '',
      classType: cls.classType || '',
      semester: cls.semester || '',
      sessionCount: withDate.length,
      isExam,
    });
    for (const c of withDate) {
      const date = Number(c.date);
      const from = Number(c.from), to = Number(c.to);
      const wd = (c.day >= 2 && c.day <= 8) ? c.day - 2 : weekdayOf(date);
      sessions.push({
        id: String(c.id),
        classDbId: String(cls.id),
        classId: cls.classId || '',
        courseId: cls.courseId || '',
        courseName: cls.courseName || cls.name || '',
        courseNameEn: cls.courseNameEn || '',
        classType: cls.classType || '',
        lessonType: c.lessonType || cls.classType || '',
        semester: c.semester || cls.semester || semesterCode || '',
        date,
        dateKey: dateKeyOf(date),
        weekday: wd,
        from,
        to,
        startTime: periodToTime(from, 'from'),
        endTime: periodToTime(to, 'to'),
        place: String(c.place || '').trim(),
        teachers: Array.isArray(c.teacherNames) ? c.teacherNames.filter(Boolean) : [],
        assistants: Array.isArray(c.assistantNames) ? c.assistantNames.filter(Boolean) : [],
        week: c.week != null ? String(c.week) : '',
        status: Number.isFinite(Number(c.status)) ? Number(c.status) : null,
        teachingStatus: Number.isFinite(Number(c.teachingStatus)) ? Number(c.teachingStatus) : null,
        note: String(c.note || '').trim(),
        reason: String(c.reason || '').trim(),
        isExam,
      });
    }
  }
  sessions.sort((a, b) => a.date - b.date || a.from - b.from || a.classId.localeCompare(b.classId));
  classInfo.sort((a, b) => a.classId.localeCompare(b.classId));
  return { sessions, classes: classInfo };
}

/** Pick the semester to watch: flagged current, else the one containing `now`, else the latest one that has started. */
export function pickCurrentSemester(semesters, now = Date.now()) {
  if (!semesters || !semesters.length) return null;
  return semesters.find((s) => s.isCurrentForClass)
    || semesters.find((s) => now >= s.startDate && now <= s.endDate)
    || [...semesters].filter((s) => s.startDate <= now).sort((a, b) => b.startDate - a.startDate)[0]
    || semesters[0];
}
