const DULMS_BASE = "https://dulms.deltauniv.edu.eg";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => new Date().toISOString();
const normalizeCode = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
const levelOf = (code) => Number(normalizeCode(code).match(/^DEN\s*([1-5])/)?.[1]) || null;
const categoryOf = (code) => normalizeCode(code).startsWith("DEN") ? "DEN" : normalizeCode(code).startsWith("GEN") ? "GEN" : normalizeCode(code).startsWith("FEL") ? "FEL" : "OTHER";
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))).map((part) => part.toString(16).padStart(2, "0")).join("");
const sourceKey = (courseId, row) => [courseId, row.Type || "", row.GroupId, row.DayWeek, row.IntervalId ?? row.Time].join(":");
const parseTime = (value) => { const m = String(value || "").match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?)$/); return { start: m?.[1] || null, end: m?.[2] || null }; };

function requireAdmin(request, env) {
  if (!env.ADMIN_API_KEY || request.headers.get("x-admin-key") !== env.ADMIN_API_KEY) return "Admin authentication required";
  if (["POST", "PATCH", "DELETE"].includes(request.method) && request.headers.get("x-requested-with") !== "schedule-admin") return "CSRF validation failed";
  return null;
}

function scopeMatches(course, scope) {
  const category = categoryOf(course.courseCode);
  const level = levelOf(course.courseCode);
  return scope === "all" ? ["DEN", "GEN", "FEL"].includes(category) : scope === "general" ? ["GEN", "FEL"].includes(category) : category === "DEN" && level === Number(scope);
}

function flattenCatalog(value, inheritedCategory = null, output = []) {
  if (Array.isArray(value)) value.forEach((item) => flattenCatalog(item, inheritedCategory, output));
  else if (value && typeof value === "object") {
    const courseId = value.CourseId ?? value.courseId;
    const courseCode = value.Code ?? value.courseCode;
    if (courseId != null && courseCode) output.push({ courseId: Number(courseId), courseCode: String(courseCode).trim(), courseName: String(value.Name ?? value.courseName ?? "Unknown").trim(), creditHours: Number(value.CreditHours ?? value.creditHours ?? 0), category: value.category ?? value.Category ?? inheritedCategory ?? null, raw: value });
    else Object.values(value).forEach((child) => typeof child === "object" && flattenCatalog(child, value.category ?? value.Category ?? inheritedCategory, output));
  }
  return output;
}

class DulmsClient {
  constructor(env) { this.env = env; this.cookies = new Map(); }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  takeCookies(response) {
    const lines = response.headers.getSetCookie?.() || (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
    for (const line of lines) { const pair = line.split(";")[0]; const index = pair.indexOf("="); if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
  }
  async request(path, init = {}) {
    let url = new URL(path, DULMS_BASE); let request = { ...init };
    for (let redirect = 0; redirect < 10; redirect += 1) {
      const response = await fetch(url, { ...request, redirect: "manual", headers: { "user-agent": "DULMSScheduleSync/1.0", ...(request.headers || {}), cookie: this.cookieHeader() } });
      this.takeCookies(response);
      const location = response.headers.get("location");
      if (!(response.status >= 300 && response.status < 400 && location)) { if (!response.ok) throw new Error(`DULMS request failed (${response.status})`); return response; }
      url = new URL(location, url);
      if ([301, 302, 303].includes(response.status) && String(request.method || "GET").toUpperCase() === "POST") request = { method: "GET" };
    }
    throw new Error("DULMS redirect limit reached");
  }
  async login() {
    if (!this.env.DULMS_USERNAME || !this.env.DULMS_PASSWORD) throw new Error("DULMS server secrets are not configured");
    const html = await (await this.request("/login.aspx")).text();
    if (/captcha|g-recaptcha|two.factor|otp/i.test(html)) throw new Error("DULMS requires CAPTCHA/MFA; sync stopped safely");
    const body = new URLSearchParams({ txtname: this.env.DULMS_USERNAME, txtPass: this.env.DULMS_PASSWORD, type: "1", Button1: "Login" });
    for (const match of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) { const tag = match[0]; const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1]; const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || ""; if (name) body.set(name, value.replace(/&amp;/g, "&")); }
    const result = await (await this.request("/login.aspx", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })).text();
    if (/id=["']txtname["']|name=["']txtPass["']/i.test(result)) throw new Error("DULMS login failed; verify credentials");
  }
  async getJson(path, method = "GET") { const response = await this.request(path, { method, headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } }); const text = await response.text(); if (/^\s*</.test(text)) throw new Error("DULMS returned HTML; session expired"); return JSON.parse(text); }
}

async function runPreview(env, runId, scope) {
  try {
    const client = new DulmsClient(env); await client.login();
    const catalog = flattenCatalog(await client.getJson("/CourseHistory/GetProgramsubjects_forReg", "POST")).filter((course) => scopeMatches(course, scope));
    await env.DB.prepare("UPDATE dulms_sync_runs SET progress_total=? WHERE id=?").bind(catalog.length, runId).run();
    const courses = []; const failed = [];
    for (let index = 0; index < catalog.length; index += 1) {
      const course = catalog[index];
      try {
        const raw = await client.getJson(`/Registered/GetCourseSchedual?CourseId=${encodeURIComponent(course.courseId)}`);
        if (!Array.isArray(raw)) throw new Error("Schedule response was not an array");
        const dedupe = new Map(); raw.forEach((row) => dedupe.set(sourceKey(course.courseId, row), row));
        const academicLevel = levelOf(course.courseCode); const normalized = normalizeCode(course.courseCode);
        const sourceHash = await hash({ code: normalized, name: course.courseName, id: course.courseId });
        const sessions = await Promise.all([...dedupe.values()].map(async (row) => ({ ...row, sourceKey: sourceKey(course.courseId, row), sourceHash: await hash({ course: normalized, Type: row.Type, GroupId: row.GroupId, GroupName: row.GroupName, DayWeek: row.DayWeek, IntervalId: row.IntervalId, Time: row.Time, ClassRoomName: row.ClassRoomName, Staff: row.Staff, NameEn: row.NameEn, BgColor: row.BgColor, IsEveryWeek: row.IsEveryWeek, IsBlocked: row.IsBlocked }), parsed: parseTime(row.Time) })));
        courses.push({ ...course, normalized, academicLevel, sourceHash, sessions });
      } catch (error) { failed.push({ courseCode: course.courseCode, error: error.message }); }
      await env.DB.prepare("UPDATE dulms_sync_runs SET progress_current=? WHERE id=?").bind(index + 1, runId).run();
    }
    const snapshot = { scope, courses, failed }; const halls = {};
    for (const course of courses) { const key = course.academicLevel ? `Level ${course.academicLevel}` : "GEN/FEL"; halls[key] ||= { sessions: 0, sessionsWithHall: 0 }; halls[key].sessions += course.sessions.length; halls[key].sessionsWithHall += course.sessions.filter((s) => s.ClassRoomName).length; }
    for (const item of Object.values(halls)) { item.sessionsWithoutHall = item.sessions - item.sessionsWithHall; item.hallCoveragePercent = item.sessions ? Math.round(item.sessionsWithHall * 100 / item.sessions) : 0; }
    const summary = { added: courses.reduce((total, course) => total + course.sessions.length + 1, 0), updated: 0, deactivated: 0, unchanged: 0, failed, coverageByLevel: halls };
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO dulms_sync_snapshots(run_id,snapshot_json,created_at) VALUES (?,?,?)").bind(runId, JSON.stringify(snapshot), now()),
      env.DB.prepare("UPDATE dulms_sync_runs SET status='preview_ready',summary_json=?,finished_at=? WHERE id=?").bind(JSON.stringify(summary), now(), runId),
    ]);
  } catch (error) { await env.DB.prepare("UPDATE dulms_sync_runs SET status='failed',safe_error=?,finished_at=? WHERE id=?").bind(error.message, now(), runId).run(); }
}

async function applySnapshot(env, runId) {
  const row = await env.DB.prepare("SELECT snapshot_json FROM dulms_sync_snapshots WHERE run_id=?").bind(runId).first(); if (!row) throw new Error("Preview snapshot not found");
  const snapshot = JSON.parse(row.snapshot_json); const at = now();
  for (const course of snapshot.courses) {
    await env.DB.prepare("INSERT INTO dulms_courses(source_course_id,course_code,normalized_course_code,course_name,category,academic_level,credit_hours,is_active,last_synced_at,last_seen_at,source_hash,sync_run_id,raw_json) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?) ON CONFLICT(normalized_course_code) DO UPDATE SET source_course_id=excluded.source_course_id,course_code=excluded.course_code,course_name=excluded.course_name,category=excluded.category,academic_level=excluded.academic_level,credit_hours=excluded.credit_hours,is_active=1,last_synced_at=excluded.last_synced_at,last_seen_at=excluded.last_seen_at,source_hash=excluded.source_hash,sync_run_id=excluded.sync_run_id,raw_json=excluded.raw_json").bind(course.courseId, course.courseCode, course.normalized, course.courseName, course.category, course.academicLevel, course.creditHours, at, at, course.sourceHash, runId, JSON.stringify(course.raw)).run();
    const stored = await env.DB.prepare("SELECT id FROM dulms_courses WHERE normalized_course_code=?").bind(course.normalized).first();
    const seen = course.sessions.map((session) => session.sourceKey);
    for (const session of course.sessions) await env.DB.prepare("INSERT INTO dulms_sessions(course_id,source_key,source_group_id,group_name,group_type,academic_level,day_week,day_name,start_time,end_time,raw_time,room_raw,faculty_name_raw,staff,session_kind,interval_id,intervals_count,bg_color,is_every_week,is_blocked,is_active,last_synced_at,last_seen_at,source_hash,sync_run_id,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET course_id=excluded.course_id,group_name=excluded.group_name,group_type=excluded.group_type,academic_level=excluded.academic_level,day_week=excluded.day_week,day_name=excluded.day_name,start_time=excluded.start_time,end_time=excluded.end_time,raw_time=excluded.raw_time,room_raw=excluded.room_raw,staff=excluded.staff,session_kind=excluded.session_kind,is_active=1,last_synced_at=excluded.last_synced_at,last_seen_at=excluded.last_seen_at,source_hash=excluded.source_hash,sync_run_id=excluded.sync_run_id,raw_json=excluded.raw_json").bind(stored.id, session.sourceKey, session.GroupId, session.GroupName, session.Type, course.academicLevel, session.DayWeek, session.DayWeekName, session.parsed.start, session.parsed.end, session.Time, session.ClassRoomName, session.NameEn_Faculty, session.Staff, session.NameEn, session.IntervalId, session.IntervalsCount, session.BgColor, session.IsEveryWeek == null ? null : Number(session.IsEveryWeek), session.IsBlocked == null ? null : Number(session.IsBlocked), at, at, session.sourceHash, runId, JSON.stringify(session)).run();
    const placeholders = seen.map(() => "?").join(",") || "''";
    await env.DB.prepare(`UPDATE dulms_sessions SET is_active=0,last_synced_at=?,sync_run_id=? WHERE course_id=? AND is_active=1 AND source_key NOT IN (${placeholders})`).bind(at, runId, stored.id, ...seen).run();
  }
  await env.DB.prepare("UPDATE dulms_sync_runs SET status='applied',mode='apply',finished_at=? WHERE id=?").bind(at, runId).run();
  return { applied: snapshot.courses.length, failed: snapshot.failed };
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url); const path = url.pathname;
  if (path === "/api/schedules") {
    const level = url.searchParams.get("level") || "3"; if (!(level === "all" || level === "general" || /^[1-5]$/.test(level))) return json({ error: "Invalid level" }, 400);
    const where = level === "all" ? "c.is_active=1" : level === "general" ? "c.is_active=1 AND c.academic_level IS NULL" : "c.is_active=1 AND (c.academic_level=? OR EXISTS (SELECT 1 FROM dulms_course_level_links l WHERE l.course_id=c.id AND l.academic_level=?))";
    const args = level === "all" || level === "general" ? [] : [Number(level), Number(level)];
    const courses = await env.DB.prepare(`SELECT * FROM dulms_courses c WHERE ${where} ORDER BY c.course_code`).bind(...args).all();
    const result = [];
    for (const course of courses.results) { const sessions = await env.DB.prepare("SELECT * FROM dulms_sessions WHERE course_id=? AND is_active=1 ORDER BY day_week,start_time").bind(course.id).all(); if (sessions.results.length) result.push({ id: course.normalized_course_code, courseId: course.source_course_id, code: course.course_code, name: course.course_name, academicLevel: course.academic_level, sessions: sessions.results.map((s) => ({ ...JSON.parse(s.raw_json), DayWeek: s.day_week, DayWeekName: s.day_name, GroupId: s.source_group_id, GroupName: s.group_name, Type: s.group_type, Time: s.raw_time, ClassRoomName: s.room_raw, Staff: s.staff })) }); }
    return json({ level, courses: result });
  }
  const denied = requireAdmin(request, env); if (denied) return json({ error: denied }, 401);
  if (path === "/api/admin/dulms-courses" && request.method === "GET") return json((await env.DB.prepare("SELECT id,source_course_id,course_code,course_name,category,academic_level,credit_hours,is_active,last_synced_at FROM dulms_courses ORDER BY academic_level,course_code").all()).results);
  if (path === "/api/admin/dulms-sync/preview" && request.method === "POST") { const body = await request.json(); const scope = String(body.scope || "all"); if (!(scope === "all" || scope === "general" || /^[1-5]$/.test(scope))) return json({ error: "Invalid sync scope" }, 400); const id = crypto.randomUUID(); await env.DB.prepare("INSERT INTO dulms_sync_runs(id,status,mode,requested_scope,refresh_catalog,started_at) VALUES (?,'running','preview',?,?,?)").bind(id, scope, body.refreshCatalog === false ? 0 : 1, now()).run(); ctx.waitUntil(runPreview(env, id, scope)); return json({ runId: id }, 202); }
  if (path === "/api/admin/dulms-sync/apply" && request.method === "POST") { const body = await request.json(); if (!body.runId || body.confirm !== true) return json({ error: "Explicit confirmation is required" }, 400); try { return json({ summary: await applySnapshot(env, body.runId) }); } catch (error) { return json({ error: error.message }, 400); } }
  const runMatch = path.match(/^\/api\/admin\/dulms-sync\/([^/]+)$/); if (runMatch && request.method === "GET") { const run = await env.DB.prepare("SELECT * FROM dulms_sync_runs WHERE id=?").bind(runMatch[1]).first(); return run ? json({ ...run, summary: run.summary_json ? JSON.parse(run.summary_json) : null }) : json({ error: "Sync run not found" }, 404); }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);

    // Vite serves a single-page application. Deep links such as /admin do not
    // correspond to a physical asset, so serve the application shell and let
    // the client-side router select the screen.
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || request.method !== "GET") return asset;
    return env.ASSETS.fetch(new Request(new URL("/", url), request));
  },
};
