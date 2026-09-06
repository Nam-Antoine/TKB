'use strict';
/**
 * Command-line check of the API client without Electron.
 *   node scripts/probe.js <file-with-cookie-header>
 * The file must contain the raw Cookie header copied from the browser dev tools
 * for a request to erp.usth.edu.vn (it needs at least x-student-portal-token and x-access-token).
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { UsthClient, normalizeTimetable, pickCurrentSemester } = require('../src/usth-api');

if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
const { diffSessions, describeDiff, fmtDate } = require('../src/diff');

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/probe.js <cookie-file>'); process.exit(2); }
  const cookie = fs.readFileSync(file, 'utf8').trim();
  const client = new UsthClient({ getCookieHeader: () => cookie });

  const user = await client.getSession();
  console.log(`Signed in as ${user.fullName} (${user.studentId})`);
  const semesters = await client.getSemesters();
  const sem = pickCurrentSemester(semesters);
  console.log(`Semester ${sem.semester}: ${new Date(sem.startDate).toDateString()} -> ${new Date(sem.endDate).toDateString()}`);
  const classes = await client.fetchSemesterTimetable(sem);
  const { sessions, classes: info } = normalizeTimetable(classes, sem.semester);
  console.log(`${info.length} classes, ${sessions.length} sessions`);

  const snapFile = path.join(__dirname, '..', `probe-snapshot-${sem.semester}.json`);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch { /* first run */ }
  if (prev) {
    const d = diffSessions(prev.sessions, sessions);
    console.log(d.total ? describeDiff(d, { semester: sem.semester }).text : 'No changes since last probe.');
  }
  fs.writeFileSync(snapFile, JSON.stringify({ semester: sem.semester, fetchedAt: Date.now(), sessions }, null, 1));

  const today = new Date();
  const monday = new Date(today); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const keys = new Set(Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return d.toLocaleDateString('en-CA'); }));
  console.log('\nThis week:');
  for (const s of sessions.filter((x) => keys.has(x.dateKey))) {
    console.log(`  ${fmtDate(s.dateKey)} ${s.startTime}-${s.endTime}  ${s.courseNameEn || s.courseName} [${s.classId}] @ ${s.place}  ${s.teachers.join(', ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
