/**
 * "How many lessons are left?" — counts, per class, how many of its sessions are
 * already done and how many are still to come, plus a grand total across the whole
 * schedule. Cancelled sessions (status 5) are left out of every count, so a class
 * that had a session called off is not shown as still owing it.
 *
 * A session counts as "done" once its end time has passed; one that is happening
 * right now still counts as "left". All arithmetic is on the local calendar
 * (matching the rest of the UI). Pure functions, so they are unit-tested in Node.
 */

/** Local-time epoch ms at which a session ends: its date at 00:00 plus its end time. */
export function sessionEndMs(s) {
  const [y, m, d] = String(s.dateKey || '').split('-').map(Number);
  if (!y) return 0;
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(s.endTime || '').trim());
  const hh = match ? Number(match[1]) : 23;
  const mm = match ? Number(match[2]) : 59;
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/**
 * One progress record per class:
 *   { classId, courseId, total, done, left, nextKey }
 * `total` = done + left (cancelled excluded); `nextKey` is the dateKey of the
 * earliest session still to come, or null when the class is finished.
 */
export function classProgress(sessions, now = Date.now()) {
  const map = new Map();
  for (const s of sessions || []) {
    if (s.status === 5) continue; // cancelled: does not count as a lesson to attend
    let p = map.get(s.classId);
    if (!p) { p = { classId: s.classId, courseId: s.courseId, total: 0, done: 0, left: 0, nextKey: null }; map.set(s.classId, p); }
    p.total++;
    if (sessionEndMs(s) <= now) {
      p.done++;
    } else {
      p.left++;
      if (!p.nextKey || s.dateKey < p.nextKey) p.nextKey = s.dateKey;
    }
  }
  return map;
}

/** Totals across every class: { total, done, left, classesLeft } where classesLeft counts classes with any session still to come. */
export function overallProgress(sessions, now = Date.now()) {
  let total = 0, done = 0, left = 0, classesLeft = 0;
  for (const p of classProgress(sessions, now).values()) {
    total += p.total;
    done += p.done;
    left += p.left;
    if (p.left > 0) classesLeft++;
  }
  return { total, done, left, classesLeft };
}
