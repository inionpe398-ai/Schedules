import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dedupeSchedule, inferAcademicLevel, normalizeCourseCode, parseDulmsTime, sessionHash, sessionSourceKey, validateScheduleResponse } from "../server/sync-utils.js";

const economics = JSON.parse(fs.readFileSync(new URL("../server/fixtures/Economics.json", import.meta.url), "utf8"));

test("normalizes course codes without changing logical spacing", () => {
  assert.equal(normalizeCourseCode("  Den   2107 "), "DEN 2107");
  assert.equal(inferAcademicLevel("DEN 5101"), 5);
  assert.equal(inferAcademicLevel("GEN201"), null);
});

test("parses actual DULMS time without assuming duration", () => {
  assert.deepEqual(parseDulmsTime("21:00:00 - 22:30:00"), { start: "21:00:00", end: "22:30:00", raw: "21:00:00 - 22:30:00" });
  assert.equal(parseDulmsTime("unknown").start, null);
});

test("uses interval id and time fallback in source identity", () => {
  assert.equal(sessionSourceKey(99, economics[0]), "99:Group:990001:7:990001");
  assert.match(sessionSourceKey(99, { ...economics[0], IntervalId: null }), /21:00:00 - 22:30:00$/);
});

test("keeps a session identity when DULMS renames its group", () => {
  const renamed = { ...economics[0], GroupName: "Renamed group" };
  assert.equal(sessionSourceKey(99, economics[0]), sessionSourceKey(99, renamed));
  assert.notEqual(sessionHash({ courseCode: "GEN201", courseName: "Economics" }, economics[0]), sessionHash({ courseCode: "GEN201", courseName: "Economics" }, renamed));
});

test("Economics fixture preserves raw hall and produces stable change hash", () => {
  const row = validateScheduleResponse(economics)[0];
  assert.match(row.ClassRoomName, /Online-Class 2/);
  const course = { courseCode: "GEN201", courseName: "Economics" };
  assert.notEqual(sessionHash(course, row), sessionHash(course, { ...row, Staff: "Changed instructor" }));
  assert.notEqual(sessionHash(course, row), sessionHash(course, { ...row, ClassRoomName: "Changed hall" }));
  assert.notEqual(sessionHash(course, row), sessionHash(course, { ...row, Time: "20:00:00 - 21:00:00" }));
});

test("deduplicates exact records and rejects conflicting duplicates", () => {
  assert.equal(dedupeSchedule(99, [economics[0], { ...economics[0] }]).length, 1);
  assert.throws(() => dedupeSchedule(99, [economics[0], { ...economics[0], Staff: "Other" }]), /conflicting duplicate/);
});

test("accepts an empty successful snapshot and rejects HTML-like invalid data", () => {
  assert.deepEqual(validateScheduleResponse([]), []);
  assert.throws(() => validateScheduleResponse("<html>login</html>"), /JSON array/);
});
