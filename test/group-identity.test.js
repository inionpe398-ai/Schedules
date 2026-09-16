import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLecturePrefix,
  lectureMatchesSection,
  pairedSectionLabel,
  parseSectionGroupName,
} from "../src/lib/groupIdentity.js";

test("recognizes DULMS group-name variants without exact label matching", () => {
  assert.equal(extractLecturePrefix("A01"), "A");
  assert.equal(extractLecturePrefix("Group A01"), "A");
  assert.equal(extractLecturePrefix("Dent-Group A"), "A");
  assert.equal(extractLecturePrefix("DU-A"), "A");
  assert.equal(lectureMatchesSection("A01", "A07"), true);
  assert.equal(lectureMatchesSection("Group B", "A01"), false);
});

test("preserves zero padding in paired section labels", () => {
  assert.deepEqual(parseSectionGroupName("A01"), {
    raw: "A01", upper: "A01", prefix: "A", number: 1, numberText: "01", token: "A01",
  });
  assert.equal(pairedSectionLabel("A01"), "A01/A02");
});
