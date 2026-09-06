import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { encryptPayload, decryptPayload, checksum, normalizeTimetable, periodToTime, parseJwt } from '../src/lib/usth-api.js';
import { diffSessions, describeDiff } from '../src/lib/diff.js';
import { chunk } from '../src/lib/notify.js';
import { sanitizeConfig, reminderDue } from '../src/lib/config.js';

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
