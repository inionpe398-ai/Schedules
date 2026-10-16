import { extractSectionPrefix, groupTrackKey } from "./groupIdentity.js";

function isSubgroupType(type) {
  return String(type || "").toLowerCase().replace(/\s+/g, "").includes("sub");
}

function courseKey(course) {
  return String(course?.id ?? course?.code ?? course?.name ?? "");
}

export function sharedSubgroupPrefixKey(courseId, prefix) {
  return `${String(courseId ?? "")}|${String(prefix || "").trim().toUpperCase()}`;
}

// DULMS sometimes publishes a single representative subgroup (for example D1)
// when the same section is attended by every subgroup in that lettered track.
// A prefix is shared only when the course has exactly one distinct subgroup for it.
export function findSharedSubgroupPrefixes(courses) {
  const groupsByCoursePrefix = new Map();

  for (const course of courses || []) {
    const id = courseKey(course);
    for (const session of course?.sessions || []) {
      if (!isSubgroupType(session?.Type)) continue;
      const prefix = extractSectionPrefix(session?.GroupName);
      const group = groupTrackKey(session?.GroupName);
      if (!prefix || !group) continue;

      const key = sharedSubgroupPrefixKey(id, prefix);
      if (!groupsByCoursePrefix.has(key)) groupsByCoursePrefix.set(key, new Set());
      groupsByCoursePrefix.get(key).add(group);
    }
  }

  return new Set(
    [...groupsByCoursePrefix.entries()]
      .filter(([, groups]) => groups.size === 1)
      .map(([key]) => key)
  );
}

export function subgroupSessionAppliesToRow(session, row, sharedPrefixes) {
  const group = groupTrackKey(session?.GroupName);
  if (row?.sectionKeys?.has(group)) return true;

  const prefix = extractSectionPrefix(session?.GroupName);
  if (!prefix || String(row?.prefix || "").toUpperCase() !== prefix) return false;

  return sharedPrefixes?.has(sharedSubgroupPrefixKey(session?.courseId, prefix)) || false;
}
