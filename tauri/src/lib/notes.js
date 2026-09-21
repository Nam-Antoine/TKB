/**
 * Personal day notes: a plain { 'YYYY-MM-DD': text } map the user fills in to jot
 * down anything for a day the portal does not know about — an exam room, a revision
 * plan, a deadline, a reminder. Stored next to the timetable snapshot and shown in
 * the Day view. Pure functions (no DOM, no storage), unit-tested in Node.
 */

/** Normalises a note for storage: CRLF -> LF, outer whitespace trimmed. */
export function normalizeNote(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
}

/**
 * Returns a new notes map with `dateKey` set to `text`. An empty (or whitespace-only)
 * note removes the day's entry, so blanks never linger and `hasNote` stays honest.
 */
export function setNote(notes, dateKey, text) {
  const out = { ...(notes || {}) };
  const v = normalizeNote(text);
  if (v) out[dateKey] = v;
  else delete out[dateKey];
  return out;
}

/** True when the given day has a non-empty note. */
export function hasNote(notes, dateKey) {
  return !!(notes && notes[dateKey]);
}

/** How many days carry a note. */
export function noteCount(notes) {
  return notes ? Object.keys(notes).length : 0;
}
