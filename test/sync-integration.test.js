import test from "node:test";
import assert from "node:assert/strict";
import { db, migrate } from "../server/db.js";
import { buildDiff } from "../server/sync-service.js";

test("diff detects create, update and deactivation while ignoring failed course snapshots", () => {
  migrate();
  const code = `TST ${Date.now()}`;
  const courseHash = "course-hash";
  db.prepare("INSERT INTO dulms_courses(source_course_id,course_code,normalized_course_code,course_name,academic_level,is_active,source_hash,raw_json) VALUES (?,?,?,?,?,1,?,?)")
    .run(987654, code, code, "Fixture Course", 1, courseHash, "{}");
  const course = db.prepare("SELECT * FROM dulms_courses WHERE normalized_course_code=?").get(code);
  const insert = db.prepare("INSERT INTO dulms_sessions(course_id,source_key,source_group_id,group_name,group_type,academic_level,raw_time,source_hash,is_active,raw_json) VALUES (?,?,?,?,?,?,?, ?,1,?)");
  insert.run(course.id, "987654:Group:1:1:10", 1, "Group A", "Group", 1, "08:00:00 - 09:00:00", "old-hash", "{}");
  insert.run(course.id, "987654:SubGroup:2:2:20", 2, "A1", "SubGroup", 1, "09:00:00 - 10:00:00", "missing-hash", "{}");
  try {
    const diff = buildDiff([
      {
        courseId: 987654, courseCode: code, normalizedCourseCode: code, courseName: "Fixture Course",
        academicLevel: 1, sourceHash: courseHash,
        sessions: [
          { sourceKey: "987654:Group:1:1:10", sourceHash: "new-hash", ClassRoomName: "Hall 1" },
          { sourceKey: "987654:SubGroup:3:3:30", sourceHash: "created-hash", ClassRoomName: null },
        ],
      },
      { courseCode: "FAILED", academicLevel: 1, error: "temporary upstream failure" },
    ]);
    assert.equal(diff.updated, 1);
    assert.equal(diff.created, 1);
    assert.equal(diff.deactivated, 1);
    assert.equal(diff.failed.length, 1);
    assert.deepEqual(diff.coverageByLevel["Level 1"], { sessions: 2, sessionsWithHall: 1, sessionsWithoutHall: 1, hallCoveragePercent: 50 });
  } finally {
    db.prepare("DELETE FROM dulms_sessions WHERE course_id=?").run(course.id);
    db.prepare("DELETE FROM dulms_courses WHERE id=?").run(course.id);
  }
});
