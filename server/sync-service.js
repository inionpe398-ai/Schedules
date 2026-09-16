import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, json, transaction } from "./db.js";
import { DulmsClient } from "./dulms-client.js";
import {
  courseCategory,
  dedupeSchedule,
  inferAcademicLevel,
  normalizeCourseCode,
  parseDulmsTime,
  sessionHash,
  sessionSourceKey,
  stableHash,
  validateScheduleResponse,
} from "./sync-utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let activeRunId = null;

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function flattenCatalog(value, inheritedCategory = null, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenCatalog(item, inheritedCategory, out);
  } else if (value && typeof value === "object") {
    const courseId = value.CourseId ?? value.courseId;
    const code = value.Code ?? value.courseCode;
    if (courseId != null && code) {
      out.push({
        courseId: Number(courseId), courseCode: String(code).trim(),
        courseName: String(value.Name ?? value.courseName ?? "Unknown").trim(),
        creditHours: Number(value.CreditHours ?? value.creditHours ?? 0),
        category: String(value.category ?? value.Category ?? inheritedCategory ?? "").trim() || null,
        raw: value,
      });
    } else {
      const category = value.category ?? value.Category ?? value.Name ?? inheritedCategory;
      for (const child of Object.values(value)) {
        if (typeof child === "object") flattenCatalog(child, category, out);
      }
    }
  }
  return out;
}

function scopeMatches(course, scope) {
  const category = courseCategory(course.courseCode);
  const level = inferAcademicLevel(course.courseCode);
  if (scope === "all") return category === "DEN" || category === "GEN" || category === "FEL";
  if (scope === "general") return category === "GEN" || category === "FEL";
  return category === "DEN" && level === Number(scope);
}

function existingCourse(code) {
  return db.prepare("SELECT * FROM dulms_courses WHERE normalized_course_code=?").get(normalizeCourseCode(code));
}

function existingSessions(courseId) {
  return db.prepare("SELECT * FROM dulms_sessions WHERE course_id=?").all(courseId);
}

export function buildDiff(snapshotCourses) {
  const changes = [];
  const failed = [];
  const coverageByLevel = {};
  for (const course of snapshotCourses) {
    if (course.error) { failed.push({ courseCode: course.courseCode, error: course.error }); continue; }
    const previousCourse = existingCourse(course.courseCode);
    const previousSessions = previousCourse ? existingSessions(previousCourse.id) : [];
    const previousByKey = new Map(previousSessions.map((session) => [session.source_key, session]));
    const seen = new Set();
    const levelKey = course.academicLevel ? `Level ${course.academicLevel}` : "GEN/FEL";
    const coverage = coverageByLevel[levelKey] ||= { sessions: 0, sessionsWithHall: 0, sessionsWithoutHall: 0 };

    if (!previousCourse) changes.push({ entityType: "course", sourceKey: course.normalizedCourseCode, changeType: "created", before: null, after: course });
    else if (previousCourse.source_hash !== course.sourceHash || !previousCourse.is_active) {
      changes.push({ entityType: "course", sourceKey: course.normalizedCourseCode, changeType: previousCourse.is_active ? "updated" : "reactivated", before: previousCourse, after: course });
    }

    for (const session of course.sessions) {
      seen.add(session.sourceKey);
      coverage.sessions += 1;
      if (session.ClassRoomName) coverage.sessionsWithHall += 1; else coverage.sessionsWithoutHall += 1;
      const previous = previousByKey.get(session.sourceKey);
      if (!previous) changes.push({ entityType: "session", sourceKey: session.sourceKey, changeType: "created", before: null, after: session });
      else if (previous.source_hash !== session.sourceHash || !previous.is_active) {
        changes.push({ entityType: "session", sourceKey: session.sourceKey, changeType: previous.is_active ? "updated" : "reactivated", before: previous, after: session });
      }
    }
    for (const previous of previousSessions) {
      if (previous.is_active && !seen.has(previous.source_key)) changes.push({ entityType: "session", sourceKey: previous.source_key, changeType: "deactivated", before: previous, after: null });
    }
  }

  for (const coverage of Object.values(coverageByLevel)) {
    coverage.hallCoveragePercent = coverage.sessions ? Math.round((coverage.sessionsWithHall / coverage.sessions) * 100) : 0;
  }
  const counts = { created: 0, updated: 0, deactivated: 0, reactivated: 0 };
  for (const change of changes) counts[change.changeType] += 1;
  return { changes, failed, coverageByLevel, ...counts, unchanged: snapshotCourses.filter((course) => !course.error).reduce((n, c) => n + c.sessions.length + 1, 0) - changes.length };
}

function normalizeSnapshotCourse(course, records) {
  const normalizedCourseCode = normalizeCourseCode(course.courseCode);
  const academicLevel = inferAcademicLevel(course.courseCode);
  const normalized = {
    ...course, normalizedCourseCode, academicLevel,
    categoryCode: courseCategory(course.courseCode),
  };
  normalized.sourceHash = stableHash({ courseId: course.courseId, code: normalizedCourseCode, name: course.courseName, category: course.category, creditHours: course.creditHours, academicLevel });
  normalized.sessions = dedupeSchedule(course.courseId, validateScheduleResponse(records)).map((record) => ({
    ...record,
    sourceKey: sessionSourceKey(course.courseId, record),
    sourceHash: sessionHash(course, record),
    parsedTime: parseDulmsTime(record.Time),
    academicLevel,
  }));
  return normalized;
}

async function pooledMap(items, limit, work) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function createPreview({ scope = "all", refreshCatalog = true } = {}) {
  if (activeRunId) throw new Error("Another DULMS sync is already running");
  const runId = crypto.randomUUID();
  activeRunId = runId;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dulms_sync_runs(id,status,mode,requested_scope,refresh_catalog,started_at) VALUES (?,?,?,?,?,?)")
    .run(runId, "running", "preview", String(scope), refreshCatalog ? 1 : 0, now);
  void executePreview(runId, { scope, refreshCatalog }).finally(() => { activeRunId = null; });
  return runId;
}

async function executePreview(runId, { scope, refreshCatalog }) {
  try {
    const client = new DulmsClient({ username: process.env.DULMS_USERNAME, password: process.env.DULMS_PASSWORD });
    await client.login();
    const [intervals, sessionTypes, liveCatalog] = await Promise.all([
      client.intervals(), client.sessionTypes(), refreshCatalog ? client.catalog() : Promise.resolve(null),
    ]);
    const bootstrap = readJsonFile(path.join(root, "server", "fixtures", "course-catalog.json"));
    const catalog = flattenCatalog(liveCatalog || bootstrap.courses).filter((course) => scopeMatches(course, scope));
    db.prepare("UPDATE dulms_sync_runs SET progress_total=? WHERE id=?").run(catalog.length, runId);
    const snapshotCourses = await pooledMap(catalog, 3, async (course, index) => {
      try { return normalizeSnapshotCourse(course, await client.schedule(course.courseId)); }
      catch (error) { return { ...course, academicLevel: inferAcademicLevel(course.courseCode), error: error.message }; }
      finally { db.prepare("UPDATE dulms_sync_runs SET progress_current=? WHERE id=?").run(index + 1, runId); }
    });
    const diff = buildDiff(snapshotCourses);
    const snapshot = { runId, scope, intervals, sessionTypes, courses: snapshotCourses, diff };
    transaction(() => {
      db.prepare("INSERT OR REPLACE INTO dulms_sync_snapshots(run_id,snapshot_json,created_at) VALUES (?,?,?)").run(runId, JSON.stringify(snapshot), new Date().toISOString());
      db.prepare("UPDATE dulms_sync_runs SET status='preview_ready',summary_json=?,finished_at=? WHERE id=?").run(JSON.stringify(diff), new Date().toISOString(), runId);
    });
  } catch (error) {
    db.prepare("UPDATE dulms_sync_runs SET status='failed',safe_error=?,finished_at=? WHERE id=?").run(error.message, new Date().toISOString(), runId);
  }
}

function upsertCourse(course, runId, now) {
  const previous = existingCourse(course.courseCode);
  db.prepare(`INSERT INTO dulms_courses(source_course_id,course_code,normalized_course_code,course_name,category,academic_level,credit_hours,is_active,last_synced_at,last_seen_at,source_hash,sync_run_id,raw_json)
    VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?) ON CONFLICT(normalized_course_code) DO UPDATE SET source_course_id=excluded.source_course_id,course_code=excluded.course_code,course_name=excluded.course_name,category=excluded.category,academic_level=COALESCE(dulms_courses.academic_level,excluded.academic_level),credit_hours=excluded.credit_hours,is_active=1,last_synced_at=excluded.last_synced_at,last_seen_at=excluded.last_seen_at,source_hash=excluded.source_hash,sync_run_id=excluded.sync_run_id,raw_json=excluded.raw_json`)
    .run(course.courseId, course.courseCode, course.normalizedCourseCode, course.courseName, course.category, course.academicLevel, course.creditHours, now, now, course.sourceHash, runId, JSON.stringify(course.raw));
  return previous || existingCourse(course.courseCode);
}

export function applyPreview(runId) {
  const row = db.prepare("SELECT * FROM dulms_sync_snapshots WHERE run_id=?").get(runId);
  if (!row) throw new Error("Preview snapshot not found");
  const snapshot = JSON.parse(row.snapshot_json);
  const now = new Date().toISOString();
  transaction(() => {
    db.prepare("DELETE FROM dulms_sync_changes WHERE run_id=?").run(runId);
    for (const change of snapshot.diff.changes) {
      db.prepare("INSERT INTO dulms_sync_changes(run_id,entity_type,source_key,change_type,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(runId, change.entityType, change.sourceKey, change.changeType, change.before ? JSON.stringify(change.before) : null, change.after ? JSON.stringify(change.after) : null, now);
    }
    for (const course of snapshot.courses) {
      if (course.error) continue;
      upsertCourse(course, runId, now);
      const stored = existingCourse(course.courseCode);
      const seen = [];
      for (const session of course.sessions) {
        seen.push(session.sourceKey);
        db.prepare(`INSERT INTO dulms_sessions(course_id,source_key,source_group_id,group_name,group_type,academic_level,day_week,day_name,start_time,end_time,raw_time,room_raw,faculty_name_raw,staff,session_kind,interval_id,intervals_count,bg_color,is_every_week,is_blocked,is_active,last_synced_at,last_seen_at,source_hash,sync_run_id,raw_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET course_id=excluded.course_id,source_group_id=excluded.source_group_id,group_name=excluded.group_name,group_type=excluded.group_type,academic_level=excluded.academic_level,day_week=excluded.day_week,day_name=excluded.day_name,start_time=excluded.start_time,end_time=excluded.end_time,raw_time=excluded.raw_time,room_raw=excluded.room_raw,faculty_name_raw=excluded.faculty_name_raw,staff=excluded.staff,session_kind=excluded.session_kind,interval_id=excluded.interval_id,intervals_count=excluded.intervals_count,bg_color=excluded.bg_color,is_every_week=excluded.is_every_week,is_blocked=excluded.is_blocked,is_active=1,last_synced_at=excluded.last_synced_at,last_seen_at=excluded.last_seen_at,source_hash=excluded.source_hash,sync_run_id=excluded.sync_run_id,raw_json=excluded.raw_json`)
          .run(stored.id, session.sourceKey, session.GroupId, session.GroupName, session.Type, course.academicLevel, session.DayWeek, session.DayWeekName, session.parsedTime.start, session.parsedTime.end, session.Time, session.ClassRoomName, session.NameEn_Faculty, session.Staff, session.NameEn, session.IntervalId, session.IntervalsCount, session.BgColor, session.IsEveryWeek == null ? null : Number(session.IsEveryWeek), session.IsBlocked == null ? null : Number(session.IsBlocked), now, now, session.sourceHash, runId, JSON.stringify(session));
      }
      const active = existingSessions(stored.id).filter((item) => item.is_active && !seen.includes(item.source_key));
      for (const missing of active) db.prepare("UPDATE dulms_sessions SET is_active=0,last_synced_at=?,sync_run_id=? WHERE id=?").run(now, runId, missing.id);
    }
    db.prepare("UPDATE dulms_sync_runs SET status='applied',mode='apply',finished_at=? WHERE id=?").run(now, runId);
  });
  return snapshot.diff;
}

export function getRun(runId) {
  const run = db.prepare("SELECT * FROM dulms_sync_runs WHERE id=?").get(runId);
  if (!run) return null;
  return { ...run, summary: json(run.summary_json, null) };
}

export function bootstrapCatalogAndLegacyData() {
  const catalogPath = path.join(root, "server", "fixtures", "course-catalog.json");
  if (!fs.existsSync(catalogPath)) return;
  const catalog = flattenCatalog(readJsonFile(catalogPath).courses);
  const now = new Date().toISOString();
  transaction(() => {
    for (const course of catalog) {
      const normalized = normalizeSnapshotCourse(course, []);
      upsertCourse(normalized, "bootstrap", now);
    }
    const gen201 = existingCourse("GEN201");
    if (gen201) db.prepare("INSERT OR IGNORE INTO dulms_course_level_links(course_id,academic_level) VALUES (?,3)").run(gen201.id);
  });

  if (db.prepare("SELECT COUNT(*) AS count FROM dulms_sessions").get().count === 0) {
    const manifestPath = path.join(root, "data", "manifest.json");
    if (!fs.existsSync(manifestPath)) return;
    const byCode = new Map(catalog.map((course) => [normalizeCourseCode(course.courseCode), course]));
    const files = readJsonFile(manifestPath).files || [];
    const courses = [];
    for (const file of files) {
      const code = normalizeCourseCode(String(file).split(" - ")[0]);
      const course = byCode.get(code);
      if (!course) continue;
      const records = readJsonFile(path.join(root, "data", file));
      courses.push(normalizeSnapshotCourse(course, records));
    }
    if (courses.length) {
      const runId = "bootstrap-legacy";
      const diff = buildDiff(courses);
      const snapshot = { runId, scope: "3", intervals: [], sessionTypes: [], courses, diff };
      transaction(() => {
        db.prepare("INSERT OR REPLACE INTO dulms_sync_runs(id,status,mode,requested_scope,refresh_catalog,summary_json,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(runId, "preview_ready", "preview", "3", 0, JSON.stringify(diff), now, now);
        db.prepare("INSERT OR REPLACE INTO dulms_sync_snapshots(run_id,snapshot_json,created_at) VALUES (?,?,?)").run(runId, JSON.stringify(snapshot), now);
      });
      applyPreview(runId);
    }
  }
}
