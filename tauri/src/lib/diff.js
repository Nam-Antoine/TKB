/**
 * Snapshot diffing for timetable sessions ("git diff" for your schedule).
 *
 * Sessions are matched by their portal id first; if the portal re-created a
 * session with a new id in the same slot, it is matched by class + date + time
 * so that no spurious "removed + added" pair is reported. Remaining
 * removed/added pairs of the same class are paired up as a move.
 */

export const FIELD_LABELS = {
  dateKey: 'date',
  time: 'time',
  place: 'room',
  teachers: 'teacher',
  lessonType: 'type',
  status: 'status',
  note: 'note',
  reason: 'reason',
};

/** Vietnamese wording for the change log and notifications (lang: 'vi'). */
const FIELD_LABELS_VI = {
  dateKey: 'ngày',
  time: 'giờ',
  place: 'phòng',
  teachers: 'giảng viên',
  lessonType: 'loại',
  status: 'trạng thái',
  note: 'ghi chú',
  reason: 'lý do',
};
const WORDS = {
  en: { none: '(none)', note: 'note', period: 'period', added: '{n} added', removed: '{n} removed', changed: '{n} changed', title: 'Timetable changed' },
  vi: { none: '(không)', note: 'ghi chú', period: 'tiết', added: 'thêm {n}', removed: 'bỏ {n}', changed: 'đổi {n}', title: 'Thời khoá biểu thay đổi' },
};
const words = (lang) => WORDS[lang === 'vi' ? 'vi' : 'en'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_VI = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

export function fmtDate(dateKey, lang = 'en') {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (lang === 'vi') return `${DAYS_VI[dt.getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  return `${DAYS[dt.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

export function timeRange(s, lang = 'en') {
  return s.startTime && s.endTime ? `${s.startTime}-${s.endTime}` : `${words(lang).period} ${s.from}-${s.to}`;
}

export function courseLabel(s, lang) {
  const name = (lang === 'vi' ? (s.courseName || s.courseNameEn) : (s.courseNameEn || s.courseName)) || s.courseId;
  return `${name} (${s.classId})`;
}

function normVal(s, field) {
  switch (field) {
    case 'time': return `${s.from}|${s.to}`;
    case 'teachers': return (s.teachers || []).join(', ');
    case 'status': return s.status == null ? '' : String(s.status);
    default: return s[field] == null ? '' : String(s[field]);
  }
}

function displayVal(s, field, lang = 'en') {
  const none = words(lang).none;
  switch (field) {
    case 'dateKey': return fmtDate(s.dateKey, lang);
    case 'time': return timeRange(s, lang);
    case 'teachers': return (s.teachers || []).join(', ') || none;
    case 'status': return s.status == null ? none : String(s.status);
    default: return s[field] ? String(s[field]) : none;
  }
}

/** Field-by-field differences between two sessions; labels and values worded in English (the data of a change entry). */
export function compareSessions(a, b) {
  const fields = [];
  for (const f of Object.keys(FIELD_LABELS)) {
    if (normVal(a, f) !== normVal(b, f)) fields.push({ field: f, label: FIELD_LABELS[f], from: displayVal(a, f), to: displayVal(b, f) });
  }
  return fields;
}

const slotKey = (s) => `${s.classId}|${s.dateKey}|${s.from}|${s.to}`;

export function diffSessions(oldSessions, newSessions) {
  const old = oldSessions || [];
  const cur = newSessions || [];
  const oldById = new Map(old.map((s) => [s.id, s]));
  const newIds = new Set(cur.map((s) => s.id));
  const oldBySlot = new Map();
  for (const s of old) if (!newIds.has(s.id)) oldBySlot.set(slotKey(s), s);

  const added = [], removed = [], changed = [];
  const consumed = new Set();
  for (const n of cur) {
    let o = oldById.get(n.id);
    if (!o) {
      const cand = oldBySlot.get(slotKey(n));
      if (cand && !consumed.has(cand.id)) o = cand;
    }
    if (o) {
      consumed.add(o.id);
      const fields = compareSessions(o, n);
      if (fields.length) changed.push({ before: o, after: n, fields, moved: false });
    } else {
      added.push(n);
    }
  }
  for (const o of old) if (!consumed.has(o.id)) removed.push(o);

  // Pair leftover removed/added sessions of the same class as moves.
  const remaining = [];
  for (const a of added) {
    let best = null, bestDist = Infinity;
    for (const r of removed) {
      if (r.classId !== a.classId || consumed.has(r.id)) continue;
      const dist = Math.abs(r.date - a.date);
      if (dist < bestDist) { best = r; bestDist = dist; }
    }
    if (best) {
      consumed.add(best.id);
      changed.push({ before: best, after: a, fields: compareSessions(best, a), moved: true });
    } else {
      remaining.push(a);
    }
  }
  const finalRemoved = removed.filter((r) => !consumed.has(r.id));
  const finalAdded = remaining;
  changed.sort((x, y) => x.after.date - y.after.date || x.after.from - y.after.from);
  finalAdded.sort((x, y) => x.date - y.date || x.from - y.from);
  finalRemoved.sort((x, y) => x.date - y.date || x.from - y.from);
  return {
    added: finalAdded,
    removed: finalRemoved,
    changed,
    total: finalAdded.length + finalRemoved.length + changed.length,
  };
}

function sessionLine(s, lang) {
  const bits = [fmtDate(s.dateKey, lang), timeRange(s, lang), courseLabel(s, lang)];
  if (s.place) bits.push(s.place);
  if (s.teachers && s.teachers.length) bits.push(s.teachers.join(', '));
  if (s.note) bits.push(`${words(lang).note}: ${s.note}`);
  return bits.join(' · ');
}

/** Human-readable description of a diff in English or Vietnamese: { title, lines: [{kind, text}], text }. */
export function describeDiff(diff, { lang = 'en', semester = '' } = {}) {
  const w = words(lang);
  const labels = lang === 'vi' ? FIELD_LABELS_VI : FIELD_LABELS;
  const lines = [];
  for (const s of diff.added) lines.push({ kind: '+', text: `+ ${sessionLine(s, lang)}` });
  for (const s of diff.removed) lines.push({ kind: '-', text: `- ${sessionLine(s, lang)}` });
  for (const c of diff.changed) {
    const what = c.fields.map((f) => `${labels[f.field] || f.label} ${displayVal(c.before, f.field, lang)} → ${displayVal(c.after, f.field, lang)}`).join('; ');
    lines.push({ kind: '~', text: `~ ${fmtDate(c.after.dateKey, lang)} ${timeRange(c.after, lang)} ${courseLabel(c.after, lang)}: ${what}` });
  }
  const parts = [];
  if (diff.added.length) parts.push(w.added.replace('{n}', diff.added.length));
  if (diff.removed.length) parts.push(w.removed.replace('{n}', diff.removed.length));
  if (diff.changed.length) parts.push(w.changed.replace('{n}', diff.changed.length));
  const title = `${w.title}${semester ? ` (${semester})` : ''}: ${parts.join(', ')}`;
  return { title, lines, text: lines.map((l) => l.text).join('\n') };
}

