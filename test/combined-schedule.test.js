import test from "node:test";
import assert from "node:assert/strict";
import {
  findSharedSubgroupPrefixes,
  subgroupSessionAppliesToRow,
} from "../src/lib/combinedSchedule.js";

function row(prefix, ...sections) {
  return {
    prefix,
    sectionKeys: new Set(sections),
  };
}

test("a course with one representative subgroup is shown on every row of that prefix", () => {
  const courses = [{
    id: "DEN 3101",
    sessions: [
      { Type: "SubGroup", GroupName: "D1", DayWeekName: "Wednesday", Time: "14:00:00 - 14:45:00" },
      { Type: "Group", GroupName: "Group D", DayWeekName: "Wednesday", Time: "13:15:00 - 14:00:00" },
    ],
  }];
  const shared = findSharedSubgroupPrefixes(courses);
  const session = { ...courses[0].sessions[0], courseId: "DEN 3101" };

  assert.equal(subgroupSessionAppliesToRow(session, row("D", "D1", "D2"), shared), true);
  assert.equal(subgroupSessionAppliesToRow(session, row("D", "D9", "D10"), shared), true);
  assert.equal(subgroupSessionAppliesToRow(session, row("C", "C1", "C2"), shared), false);
});

test("normal courses with several subgroups still use exact track matching", () => {
  const courses = [{
    id: "DEN 3108",
    sessions: [
      { Type: "SubGroup", GroupName: "D1" },
      { Type: "SubGroup", GroupName: "D3" },
    ],
  }];
  const shared = findSharedSubgroupPrefixes(courses);
  const session = { ...courses[0].sessions[0], courseId: "DEN 3108" };

  assert.equal(subgroupSessionAppliesToRow(session, row("D", "D1", "D2"), shared), true);
  assert.equal(subgroupSessionAppliesToRow(session, row("D", "D9", "D10"), shared), false);
});

test("zero-padded section names match normalized row keys", () => {
  const shared = new Set();
  const session = { courseId: "course", Type: "SubGroup", GroupName: "D01" };

  assert.equal(subgroupSessionAppliesToRow(session, row("D", "D1", "D2"), shared), true);
});
