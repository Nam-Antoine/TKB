import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { encryptPayload, decryptPayload, checksum, normalizeTimetable, periodToTime, parseJwt } from '../src/lib/usth-api.js';
import { diffSessions, describeDiff } from '../src/lib/diff.js';
import { chunk } from '../src/lib/notify.js';
import { sanitizeConfig, reminderDue, normalizeTime } from '../src/lib/config.js';
import { tomorrowKey, todayKey, digestDue, morningDue, buildDigest } from '../src/lib/digest.js';
import { classProgress, overallProgress, sessionEndMs } from '../src/lib/progress.js';

test('encrypt/decrypt round trip', async () => {
  const obj = { fromTime: 1, toTime: 2, semester: '20261', weeks: [1, 2], name: 'Tiếng Việt' };
  assert.deepStrictEqual(await decryptPayload(await encryptPayload(obj)), obj);
});

test('checksum ignores non-primitive fields, sorts keys and matches node:crypto', async () => {
  const a = await checksum({ toTime: 2, fromTime: 1, weeks: [1], semester: 'x' });
  const b = await checksum({ fromTime: 1, semester: 'x', toTime: 2, weeks: [9, 9] });
  assert.strictEqual(a, b);
  const expected = createHash('sha256').update(JSON.stringify(JSON.stringify({ fromTime: 1, semester: 'x', toTime: 2 }))).digest('hex');
  assert.strictEqual(a, expected);
});

test('parseJwt decodes the payload', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1234, sub: 'namtk2410702' })).toString('base64url');
  assert.deepStrictEqual(parseJwt(`x.${payload}.y`), { exp: 1234, sub: 'namtk2410702' });
  assert.strictEqual(parseJwt('garbage'), null);
});

test('periodToTime handles periods and HHMM', () => {
  assert.strictEqual(periodToTime(1, 'from'), '07:30');
  assert.strictEqual(periodToTime(9, 'to'), '16:45');
  assert.strictEqual(periodToTime(900, 'from'), '09:00');
  assert.strictEqual(periodToTime(-1, 'from'), '');
});

function cls(overrides) {
  return {
    id: 1, classId: '261ICT3017.L1', courseId: 'ICT3.017', courseName: 'Học sâu', courseNameEn: 'Intro to Deep Learning', classType: 'LT', semester: '20261',
    _calendars: [
      { id: 100, date: 1788368400000, day: 5, from: 6, to: 8, place: 'A30-1', teacherNames: ['A'], lessonType: 'LT', status: 1, teachingStatus: 0, week: '5', semester: '20261' },
      { id: 101, date: -1, day: 4, from: 6, to: 8, place: 'X', teacherNames: [], lessonType: '', status: -2 },
    ],
    ...overrides,
  };
}

test('normalizeTimetable drops undated rows and maps fields', () => {
  const { sessions, classes } = normalizeTimetable([cls()], '20261');
  assert.strictEqual(classes.length, 1);
  assert.strictEqual(sessions.length, 1);
  const s = sessions[0];
  assert.strictEqual(s.id, '100');
  assert.strictEqual(s.dateKey, '2026-09-03');
  assert.strictEqual(s.weekday, 3);
  assert.strictEqual(s.startTime, '13:00');
  assert.strictEqual(s.endTime, '15:45');
  assert.strictEqual(s.place, 'A30-1');
});

test('diffSessions detects room change, re-created ids, additions and removals', () => {
  const base = normalizeTimetable([cls()], '20261').sessions;
  const moved = normalizeTimetable([cls({ _calendars: [{ ...cls()._calendars[0], place: '2H-8' }] })], '20261').sessions;
  let d = diffSessions(base, moved);
  assert.strictEqual(d.changed.length, 1);
  assert.strictEqual(d.changed[0].fields[0].label, 'room');

  const recreated = normalizeTimetable([cls({ _calendars: [{ ...cls()._calendars[0], id: 999 }] })], '20261').sessions;
  d = diffSessions(base, recreated);
  assert.strictEqual(d.total, 0);

  const extra = normalizeTimetable([cls({ _calendars: [...cls()._calendars, { ...cls()._calendars[0], id: 200, date: 1788973200000, day: 5 }] })], '20261').sessions;
  d = diffSessions(base, extra);
  assert.strictEqual(d.added.length, 1);
  d = diffSessions(extra, base);
  assert.strictEqual(d.removed.length, 1);
  const desc = describeDiff(d, { semester: '20261' });
  assert.match(desc.title, /1 removed/);
  assert.strictEqual(desc.lines[0].kind, '-');
});

test('chunk splits long text on line boundaries', () => {
  const parts = chunk(Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'), 500);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 500);
});

test('sanitizeConfig clamps and fills defaults', () => {
  const c = sanitizeConfig({ pollMinutes: 1, language: 'xx', webhooks: { ntfy: { topic: ' t ' } }, updates: { auto: 0 } });
  assert.strictEqual(c.pollMinutes, 5);
  assert.strictEqual(c.language, 'en');
  assert.strictEqual(c.webhooks.ntfy.topic, 't');
  assert.strictEqual(c.webhooks.ntfy.server, 'https://ntfy.sh');
  assert.strictEqual(c.updates.auto, false);
  assert.strictEqual(c.closeToTray, true);
});

test('describeDiff speaks Vietnamese when asked', () => {
  const a = [{ id: '1', classId: 'C1', courseId: 'X', courseName: 'Toán', courseNameEn: 'Maths', dateKey: '2026-09-07', date: 1, from: 1, to: 3, startTime: '07:30', endTime: '10:15', place: 'A1', teachers: ['T'], lessonType: 'LEC' }];
  const b = [{ ...a[0], place: 'B2' }];
  const desc = describeDiff(diffSessions(a, b), { lang: 'vi', semester: '20261' });
  assert.match(desc.title, /^Thời khoá biểu thay đổi \(20261\): đổi 1$/);
  assert.match(desc.lines[0].text, /T2 07\/09 .* Toán \(C1\): phòng A1 → B2/);
  const en = describeDiff(diffSessions(a, b), { semester: '20261' });
  assert.match(en.title, /^Timetable changed \(20261\): 1 changed$/);
  assert.match(en.lines[0].text, /room A1 → B2/);
});

test('i18n falls back to English and formats dates per language', async () => {
  const i18n = await import('../src/lib/i18n.js');
  i18n.setLang('vi');
  assert.strictEqual(i18n.t('today'), 'Hôm nay');
  assert.strictEqual(i18n.t('lastCheck', { t: '10:30' }), 'Kiểm tra lần cuối 10:30');
  assert.strictEqual(i18n.t('no-such-key'), 'no-such-key');
  assert.strictEqual(i18n.fmtMonthTitle(new Date(2026, 8, 6)), 'Tháng 9, 2026');
  assert.strictEqual(i18n.fmtDateLong(new Date(2026, 8, 6)), 'Chủ Nhật, 06/09/2026');
  assert.strictEqual(i18n.sessionCount(2), '2 buổi học');
  i18n.setLang('en');
  assert.strictEqual(i18n.fmtMonthTitle(new Date(2026, 8, 6)), 'September 2026');
  assert.strictEqual(i18n.fmtDateLong(new Date(2026, 8, 6)), 'Sun, 6 Sep 2026');
  assert.strictEqual(i18n.sessionCount(1), '1 session');
  assert.strictEqual(i18n.detectLang('vi-VN'), 'vi');
  assert.strictEqual(i18n.detectLang('en-US'), 'en');
});

test('reloginRemindHours is clamped and defaults to 4', () => {
  assert.strictEqual(sanitizeConfig({}).reloginRemindHours, 4);
  assert.strictEqual(sanitizeConfig({ reloginRemindHours: 0 }).reloginRemindHours, 0);
  assert.strictEqual(sanitizeConfig({ reloginRemindHours: '12' }).reloginRemindHours, 12);
  assert.strictEqual(sanitizeConfig({ reloginRemindHours: 999 }).reloginRemindHours, 168);
  assert.strictEqual(sanitizeConfig({ reloginRemindHours: 'abc' }).reloginRemindHours, 4);
});

test('reminderDue: first notice always, repeats after the interval, quiet at night', () => {
  const noon = new Date(2026, 8, 7, 12, 0).getTime();
  const H = 3600000;
  assert.strictEqual(reminderDue(0, 4, noon), true);
  assert.strictEqual(reminderDue(noon - 1 * H, 4, noon), false);
  assert.strictEqual(reminderDue(noon - 4 * H, 4, noon), true);
  assert.strictEqual(reminderDue(noon - 40 * H, 0, noon), false);
  const night = new Date(2026, 8, 7, 2, 0).getTime();
  assert.strictEqual(reminderDue(night - 8 * H, 4, night), false);
  assert.strictEqual(reminderDue(0, 4, night), true);
});

test('digest settings default on at 20:00 and accept only times of day', () => {
  assert.deepStrictEqual(sanitizeConfig({}).digest, { enabled: true, time: '20:00', whenEmpty: true });
  assert.deepStrictEqual(sanitizeConfig({}).morning, { enabled: true, time: '07:00', whenEmpty: false });
  assert.strictEqual(sanitizeConfig({ digest: { time: '7:5' } }).digest.time, '20:00');
  assert.strictEqual(sanitizeConfig({ digest: { time: '7:05' } }).digest.time, '07:05');
  assert.strictEqual(sanitizeConfig({ digest: { time: '24:00' } }).digest.time, '20:00');
  assert.strictEqual(sanitizeConfig({ digest: { enabled: 0, whenEmpty: 'x' } }).digest.enabled, false);
  assert.strictEqual(normalizeTime(' 21:30 '), '21:30');
  assert.strictEqual(normalizeTime('nope'), null);
});

test('digestDue: after the set time, once per tomorrow, catches up late', () => {
  const at = (h, m) => new Date(2026, 8, 6, h, m).getTime(); // Sun 6 Sep 2026
  assert.strictEqual(tomorrowKey(at(20, 0)), '2026-09-07');
  assert.strictEqual(digestDue(null, '20:00', at(19, 59)), false);
  assert.strictEqual(digestDue(null, '20:00', at(20, 0)), true);
  assert.strictEqual(digestDue('2026-09-07', '20:00', at(20, 1)), false); // already sent for tomorrow
  assert.strictEqual(digestDue('2026-09-06', '20:00', at(23, 30)), true); // yesterday's notice, PC was asleep at 20:00
  assert.strictEqual(digestDue('2026-09-07', '20:00', new Date(2026, 8, 7, 0, 30).getTime()), false); // past midnight: not yet 20:00 of the new day
});

test('buildDigest lists tomorrow in order, marks cancelled and exams, speaks Vietnamese', () => {
  const s = (o) => ({ id: 'x', classId: 'C1', courseId: 'CID', courseName: 'Giải tích', courseNameEn: 'Calculus', dateKey: '2026-09-07', from: 1, to: 2, startTime: '07:30', endTime: '09:15', place: 'R1', teachers: ['A'], status: 1, isExam: false, ...o });
  const sessions = [
    s({ id: 'b', from: 6, to: 8, startTime: '13:00', endTime: '15:45', classId: 'C2', courseNameEn: 'Physics', courseName: 'Vật lý', status: 5 }),
    s({ id: 'a' }),
    s({ id: 'c', dateKey: '2026-09-08' }),
    s({ id: 'd', from: 9, to: 10, startTime: '15:55', endTime: '17:40', classId: 'C3', isExam: true, teachers: [] }),
  ];
  const en = buildDigest(sessions, '2026-09-07', 'en');
  assert.strictEqual(en.count, 2);
  assert.strictEqual(en.title, 'Tomorrow, Mon 7 Sep: 2 sessions');
  assert.deepStrictEqual(en.lines, [
    '07:30-09:15 · Calculus (C1) · R1 · A',
    '13:00-15:45 · Physics (C2) · R1 · A · (cancelled)',
    '15:55-17:40 · EXAM: Calculus (C3) · R1',
  ]);
  const vi = buildDigest(sessions, '2026-09-07', 'vi');
  assert.strictEqual(vi.title, 'Ngày mai, T2 07/09: 2 buổi học');
  assert.ok(vi.lines[0].startsWith('07:30-09:15 · Giải tích (C1)'));
  assert.ok(vi.lines[1].endsWith('(đã huỷ)'));
  const none = buildDigest(sessions, '2026-09-13', 'en');
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.title, 'Tomorrow, Sun 13 Sep: no class');
  assert.strictEqual(none.text, 'Nothing on the timetable for tomorrow (Sun 13 Sep).');
});

test('morningDue: after the set time, once per today, catches up late', () => {
  const at = (h, m) => new Date(2026, 8, 6, h, m).getTime(); // Sun 6 Sep 2026
  assert.strictEqual(todayKey(at(7, 0)), '2026-09-06');
  assert.strictEqual(morningDue(null, '07:00', at(6, 59)), false);
  assert.strictEqual(morningDue(null, '07:00', at(7, 0)), true);
  assert.strictEqual(morningDue('2026-09-06', '07:00', at(7, 1)), false); // already sent for today
  assert.strictEqual(morningDue('2026-09-05', '07:00', at(9, 30)), true); // yesterday's stamp, PC was asleep at 07:00
  assert.strictEqual(morningDue('2026-09-06', '07:00', new Date(2026, 8, 7, 3, 0).getTime()), false); // 3am next day: not yet 07:00
  assert.strictEqual(sanitizeConfig({ morning: { time: '6:5' } }).morning.time, '07:00');
  assert.strictEqual(sanitizeConfig({ morning: { time: '06:30' } }).morning.time, '06:30');
});

test('buildDigest speaks of "today" for the morning briefing', () => {
  const s = { id: 'a', classId: 'C1', courseId: 'CID', courseName: 'Giải tích', courseNameEn: 'Calculus', dateKey: '2026-09-06', from: 1, to: 2, startTime: '07:30', endTime: '09:15', place: 'R1', teachers: ['A'], status: 1, isExam: false };
  const en = buildDigest([s], '2026-09-06', 'en', 'today');
  assert.strictEqual(en.title, 'Today, Sun 6 Sep: 1 session');
  const vi = buildDigest([s], '2026-09-06', 'vi', 'today');
  assert.strictEqual(vi.title, 'Hôm nay, CN 06/09: 1 buổi học');
  const none = buildDigest([], '2026-09-06', 'en', 'today');
  assert.strictEqual(none.title, 'Today, Sun 6 Sep: no class');
  assert.strictEqual(none.text, 'Nothing on the timetable for today (Sun 6 Sep).');
});

test('classProgress counts done/left per class, excludes cancelled, ignores ongoing', () => {
  const s = (o) => ({ id: 'x', classId: 'C1', courseId: 'CID', dateKey: '2026-09-07', endTime: '09:15', status: 1, ...o });
  const now = new Date(2026, 8, 10, 12, 0).getTime(); // Thu 10 Sep 2026, noon
  const sessions = [
    s({ id: 'a', dateKey: '2026-09-07' }),               // C1 past -> done
    s({ id: 'b', dateKey: '2026-09-14' }),               // C1 future -> left
    s({ id: 'c', dateKey: '2026-09-21' }),               // C1 future -> left
    s({ id: 'd', classId: 'C2', dateKey: '2026-09-07' }), // C2 past -> done
    s({ id: 'e', classId: 'C2', dateKey: '2026-09-05', status: 5 }), // cancelled -> ignored
    s({ id: 'f', classId: 'C3', dateKey: '2026-09-10', startTime: '11:00', endTime: '13:00' }), // ongoing at noon -> left
  ];
  const prog = classProgress(sessions, now);
  assert.deepStrictEqual(
    { ...prog.get('C1'), courseId: undefined },
    { classId: 'C1', courseId: undefined, total: 3, done: 1, left: 2, nextKey: '2026-09-14' },
  );
  assert.strictEqual(prog.get('C2').left, 0);
  assert.strictEqual(prog.get('C2').total, 1); // cancelled one not counted
  assert.strictEqual(prog.get('C3').left, 1);  // ongoing counts as still to come
  assert.strictEqual(prog.get('C3').nextKey, '2026-09-10');

  const totals = overallProgress(sessions, now);
  assert.deepStrictEqual(totals, { total: 5, done: 2, left: 3, classesLeft: 2 });
});

test('sessionEndMs falls back to end of day without a time', () => {
  assert.strictEqual(sessionEndMs({ dateKey: '2026-09-07', endTime: '09:15' }), new Date(2026, 8, 7, 9, 15).getTime());
  assert.strictEqual(sessionEndMs({ dateKey: '2026-09-07' }), new Date(2026, 8, 7, 23, 59).getTime());
  assert.strictEqual(sessionEndMs({ dateKey: '' }), 0);
});
