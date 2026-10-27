import { DAYS, normalizeDay } from "./time.js";

const EDITABLE_FIELDS = ["Staff", "ClassRoomName", "GroupName", "Time", "DayWeekName"];

export function sessionEditKey(courseId, session) {
  return `${courseId}|${session.GroupId}|${session.DayWeek}|${session.IntervalId || ""}|${session.NameEn || ""}`;
}

export function normalizeStaffTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[._,\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function sanitizeQuickEdits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clean = {};
  for (const [key, patch] of Object.entries(value)) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
    const fields = {};
    for (const field of EDITABLE_FIELDS) {
      if (typeof patch[field] === "string" && patch[field].length <= 500) {
        fields[field] = patch[field].trim();
      }
    }
    if (Number.isInteger(patch.DayWeek) && patch.DayWeek >= 1 && patch.DayWeek <= 7) {
      fields.DayWeek = patch.DayWeek;
    }
    if (Object.keys(fields).length) clean[key] = fields;
  }
  return clean;
}

export function applyQuickEdit(session, courseId, edits = {}, key = sessionEditKey(courseId, session)) {
  const patch = edits[key];
  if (!patch) return session;
  return { ...session, ...patch, isModified: true, modifiedReason: "Quick edit", editSourceKey: key };
}

export function listStaffNames(courses, edits = {}) {
  const unique = new Map();
  for (const course of courses) {
    for (const raw of course.sessions || []) {
      const staff = String(applyQuickEdit(raw, course.id, edits).Staff || "").trim();
      const normalized = normalizeStaffTerm(staff);
      if (normalized && !unique.has(normalized)) unique.set(normalized, staff);
    }
  }
  return Array.from(unique.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function findStaffSessions(courses, query, edits = {}) {
  const needle = normalizeStaffTerm(query);
  if (!needle) return [];
  const seen = new Set();
  const result = [];
  for (const course of courses) {
    for (const raw of course.sessions || []) {
      const sourceKey = sessionEditKey(course.id, raw);
      const session = applyQuickEdit(raw, course.id, edits, sourceKey);
      if (!normalizeStaffTerm(session.Staff).includes(needle)) continue;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      result.push({
        ...session,
        courseId: course.id,
        courseName: course.name,
        courseLevel: course.academicLevel,
        source: "staff",
        editSourceKey: sourceKey,
      });
    }
  }
  result.sort((a, b) =>
    DAYS.indexOf(normalizeDay(a)) - DAYS.indexOf(normalizeDay(b)) ||
    String(a.Time || "").localeCompare(String(b.Time || "")) ||
    String(a.courseName || "").localeCompare(String(b.courseName || ""))
  );
  return result;
}
