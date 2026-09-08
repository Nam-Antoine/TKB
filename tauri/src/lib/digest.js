/**
 * The evening "what do I have tomorrow?" notice: picks tomorrow's sessions out of
 * the snapshot and words them for a Windows toast / phone push in EN or VI.
 * Pure functions, so they are unit-tested in Node.
 */
import { fmtDate, timeRange, courseLabel } from './diff.js';
import { t, sessionCount } from './i18n.js';
import { normalizeTime } from './config.js';

const pad2 = (n) => String(n).padStart(2, '0');

export function keyOfDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/** YYYY-MM-DD of the day after `now` (local calendar). */
export function tomorrowKey(now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return keyOfDate(d);
}

/**
 * Whether the notice for tomorrow should go out now: the set time has passed today
 * and the notice for that tomorrow has not been sent yet. `sentFor` is the dateKey
 * the last notice described (kept in meta.json), so a restart or a PC that was
 * asleep at the set time sends it late rather than twice or never; after midnight
 * "tomorrow" is a new day and the clock starts again.
 */
export function digestDue(sentFor, time, now = Date.now()) {
  const [h, m] = (normalizeTime(time) || '20:00').split(':').map(Number);
  const d = new Date(now);
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  if (now < due) return false;
  return sentFor !== tomorrowKey(now);
}

/**
 * Words the sessions of `dateKey`: { dateKey, count, title, lines, text }.
 * `count` leaves cancelled sessions out; they are still listed, marked as cancelled,
 * so a "3 sessions" title never hides a class that was called off.
 */
export function buildDigest(sessions, dateKey, lang = 'en') {
  const list = (sessions || [])
    .filter((s) => s.dateKey === dateKey)
    .sort((a, b) => a.from - b.from || String(a.classId).localeCompare(String(b.classId)));
  const day = fmtDate(dateKey, lang);
  const lines = list.map((s) => {
    const bits = [timeRange(s, lang), (s.isExam ? `${t('digestExam', null, lang)}: ` : '') + courseLabel(s, lang)];
    if (s.place) bits.push(s.place);
    if (s.teachers && s.teachers.length) bits.push(s.teachers.join(', '));
    if (s.status === 5) bits.push(`(${t('digestCancelled', null, lang)})`);
    return bits.join(' · ');
  });
  const count = list.filter((s) => s.status !== 5).length;
  const title = t('digestTitle', { d: day, n: count ? sessionCount(count, lang) : t('digestNone', null, lang) }, lang);
  const text = lines.length ? lines.join('\n') : t('digestNoneText', { d: day }, lang);
  return { dateKey, count, title, lines, text };
}
