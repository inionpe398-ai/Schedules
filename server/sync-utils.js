import { createHash } from "node:crypto";

export function normalizeCourseCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

export function inferAcademicLevel(code) {
  const match = normalizeCourseCode(code).match(/^DEN\s*([1-5])/);
  return match ? Number(match[1]) : null;
}

export function courseCategory(code) {
  const normalized = normalizeCourseCode(code);
  if (normalized.startsWith("DEN")) return "DEN";
  if (normalized.startsWith("GEN")) return "GEN";
  if (normalized.startsWith("FEL")) return "FEL";
  return "OTHER";
}

export function parseDulmsTime(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?)$/);
  return match ? { start: match[1], end: match[2], raw } : { start: null, end: null, raw };
}

export function sessionSourceKey(courseId, record) {
  return [courseId, record.Type || "", record.GroupId, record.DayWeek, record.IntervalId ?? record.Time].join(":");
}

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sessionHash(course, record) {
  const fields = {
    courseCode: course.courseCode,
    courseName: course.courseName,
    Type: record.Type,
    GroupId: record.GroupId,
    GroupName: record.GroupName,
    DayWeek: record.DayWeek,
    DayWeekName: record.DayWeekName,
    IntervalId: record.IntervalId,
    IntervalsCount: record.IntervalsCount,
    Time: record.Time,
    ClassRoomName: record.ClassRoomName,
    Staff: record.Staff,
    NameEn: record.NameEn,
    BgColor: record.BgColor,
    IsEveryWeek: record.IsEveryWeek,
    IsBlocked: record.IsBlocked,
  };
  return stableHash(fields);
}

export function dedupeSchedule(courseId, records) {
  const byKey = new Map();
  for (const record of records) {
    const key = sessionSourceKey(courseId, record);
    const exact = stableHash(record);
    const existing = byKey.get(key);
    if (!existing || existing.exact === exact) byKey.set(key, { record, exact });
    else throw new Error(`DULMS returned conflicting duplicate session key ${key}`);
  }
  return [...byKey.values()].map((item) => item.record);
}

export function validateScheduleResponse(value) {
  if (!Array.isArray(value)) throw new Error("Schedule response is not a JSON array (session may have expired)");
  for (const row of value) {
    if (!row || row.GroupId == null || !row.Type || !row.Time) throw new Error("Schedule response contains an invalid record");
  }
  return value;
}
