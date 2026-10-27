import test from "node:test";
import assert from "node:assert/strict";
import {
  applyQuickEdit,
  findStaffSessions,
  listStaffNames,
  normalizeStaffTerm,
  sanitizeQuickEdits,
  sessionEditKey,
} from "../src/lib/staffSchedule.js";

const courses = [
  { id: "DEN1", name: "Local Anesthesia", academicLevel: 3, sessions: [
    { GroupId: 101, DayWeek: 7, DayWeekName: "Saturday", Time: "08:45 - 09:30", Staff: "Dr. Ahmed Ibrahim", Type: "Group" },
    { GroupId: 102, DayWeek: 1, DayWeekName: "Sunday", Time: "10:15 - 11:00", Staff: "Dr Mona", Type: "SubGroup" },
  ] },
  { id: "DEN2", name: "Operative", academicLevel: 2, sessions: [
    { GroupId: 202, DayWeek: 2, DayWeekName: "Monday", Time: "11:00 - 11:45", Staff: "Ahmed Ibrahim", Type: "Group" },
  ] },
];

test("staff search matches names across courses and levels, with punctuation-normalization", () => {
  assert.equal(normalizeStaffTerm("Dr. Ahmed-Ibrahim"), "dr ahmed ibrahim");
  const sessions = findStaffSessions(courses, "Ahmed Ibrahim");
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(s => s.courseLevel), [3, 2]);
  assert.equal(findStaffSessions(courses, "").length, 0);
  assert.equal(listStaffNames(courses).length, 3);
});

test("quick edits update staff searches and keep stable identity after a day change", () => {
  const key = sessionEditKey("DEN1", courses[0].sessions[0]);
  const edits = { [key]: { Staff: "Dr Salma", DayWeek: 1, DayWeekName: "Sunday", ClassRoomName: "Hall 5" } };
  assert.equal(findStaffSessions(courses, "Ahmed Ibrahim", edits).length, 1);
  const updated = findStaffSessions(courses, "Salma", edits)[0];
  assert.equal(updated.DayWeekName, "Sunday");
  assert.equal(updated.ClassRoomName, "Hall 5");
  assert.equal(updated.editSourceKey, key);
  assert.equal(applyQuickEdit(courses[0].sessions[0], "DEN1", edits).Staff, "Dr Salma");
  assert.equal(courses[0].sessions[0].Staff, "Dr. Ahmed Ibrahim");
});

test("reject malformed stored edits and discard unsupported fields", () => {
  assert.deepEqual(sanitizeQuickEdits(null), {});
  assert.deepEqual(sanitizeQuickEdits({ key: { Staff: " New ", Admin: true, DayWeek: 99 } }), { key: { Staff: "New" } });
});
