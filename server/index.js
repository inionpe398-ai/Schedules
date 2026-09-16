import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, migrate, json } from "./db.js";
import { applyPreview, bootstrapCatalogAndLegacyData, createPreview, getRun } from "./sync-service.js";
import { createLevelPdf } from "./pdf.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
migrate();
bootstrapCatalogAndLegacyData();
const app = express();
app.use(express.json({ limit: "1mb" }));

const attempts = new Map();
function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  const key = req.get("x-admin-key");
  const bucket = attempts.get(req.ip) || { count: 0, reset: Date.now() + 60_000 };
  if (Date.now() > bucket.reset) { bucket.count = 0; bucket.reset = Date.now() + 60_000; }
  bucket.count += 1; attempts.set(req.ip, bucket);
  if (bucket.count > 60) return res.status(429).json({ error: "Too many admin requests" });
  if (!expected || !key || key !== expected) return res.status(401).json({ error: "Admin authentication required" });
  if (["POST", "PATCH", "DELETE"].includes(req.method) && req.get("x-requested-with") !== "schedule-admin") return res.status(403).json({ error: "CSRF validation failed" });
  next();
}

function validScope(value) { return value === "all" || value === "general" || /^[1-5]$/.test(String(value)); }

app.get("/api/schedules", (req, res) => {
  const scope = String(req.query.level || "3");
  if (!validScope(scope)) return res.status(400).json({ error: "Invalid level" });
  const where = scope === "all" ? "c.is_active=1" : scope === "general" ? "c.is_active=1 AND c.academic_level IS NULL" : "c.is_active=1 AND (c.academic_level=? OR EXISTS (SELECT 1 FROM dulms_course_level_links l WHERE l.course_id=c.id AND l.academic_level=?))";
  const params = scope === "all" || scope === "general" ? [] : [Number(scope), Number(scope)];
  const courses = db.prepare(`SELECT * FROM dulms_courses c WHERE ${where} ORDER BY c.course_code`).all(...params);
  const output = courses.map((course) => ({
    id: course.normalized_course_code, courseId: course.source_course_id, code: course.course_code, name: course.course_name,
    academicLevel: course.academic_level, category: course.category, lastSyncedAt: course.last_synced_at,
    sessions: db.prepare("SELECT * FROM dulms_sessions WHERE course_id=? AND is_active=1 ORDER BY day_week,start_time").all(course.id).map((s) => ({
      ...json(s.raw_json, {}), DayWeek: s.day_week, DayWeekName: s.day_name, GroupId: s.source_group_id, GroupName: s.group_name,
      Type: s.group_type, Time: s.raw_time, ClassRoomName: s.room_raw, Staff: s.staff, academicLevel: s.academic_level,
    })),
  })).filter((course) => course.sessions.length);
  res.json({ level: scope, courses: output });
});

app.get("/api/admin/dulms-courses", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT id,source_course_id,course_code,course_name,category,academic_level,credit_hours,is_active,last_synced_at FROM dulms_courses ORDER BY academic_level,course_code").all());
});

app.patch("/api/admin/dulms-courses/:id", adminOnly, (req, res) => {
  const level = req.body.academicLevel;
  if (level != null && !/^[1-5]$/.test(String(level))) return res.status(400).json({ error: "Invalid academic level" });
  db.prepare("UPDATE dulms_courses SET academic_level=? WHERE id=?").run(level == null ? null : Number(level), Number(req.params.id));
  db.prepare("UPDATE dulms_sessions SET academic_level=? WHERE course_id=?").run(level == null ? null : Number(level), Number(req.params.id));
  if (Array.isArray(req.body.linkedLevels)) {
    const linked = [...new Set(req.body.linkedLevels.map(Number))];
    if (linked.some((item) => !Number.isInteger(item) || item < 1 || item > 5)) return res.status(400).json({ error: "Invalid linked levels" });
    db.prepare("DELETE FROM dulms_course_level_links WHERE course_id=?").run(Number(req.params.id));
    for (const item of linked) db.prepare("INSERT INTO dulms_course_level_links(course_id,academic_level) VALUES (?,?)").run(Number(req.params.id), item);
  }
  res.json({ ok: true });
});

app.post("/api/admin/dulms-sync/preview", adminOnly, async (req, res) => {
  const scope = String(req.body.scope || "all");
  if (!validScope(scope)) return res.status(400).json({ error: "Invalid sync scope" });
  try { res.status(202).json({ runId: await createPreview({ scope, refreshCatalog: req.body.refreshCatalog !== false }) }); }
  catch (error) { res.status(409).json({ error: error.message }); }
});
app.post("/api/admin/dulms-sync/apply", adminOnly, (req, res) => {
  if (!req.body.runId || req.body.confirm !== true) return res.status(400).json({ error: "Explicit confirmation is required" });
  try { res.json({ summary: applyPreview(req.body.runId) }); } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get("/api/admin/dulms-sync/:runId", adminOnly, (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "Sync run not found" });
  res.json(run);
});

app.get("/api/admin/schedules/export/pdf", adminOnly, (req, res) => {
  const level = String(req.query.level || "");
  if (!validScope(level) || level === "all") return res.status(400).json({ error: "Choose one valid level" });
  const where = level === "general" ? "c.academic_level IS NULL" : "(c.academic_level=? OR EXISTS (SELECT 1 FROM dulms_course_level_links l WHERE l.course_id=c.id AND l.academic_level=?))";
  const params = level === "general" ? [] : [Number(level), Number(level)];
  const courses = db.prepare(`SELECT * FROM dulms_courses c WHERE c.is_active=1 AND ${where} ORDER BY c.course_code`).all(...params);
  const ids = courses.map((course) => course.id);
  const sessions = ids.length ? db.prepare(`SELECT s.*,c.course_code,c.course_name FROM dulms_sessions s JOIN dulms_courses c ON c.id=s.course_id WHERE s.is_active=1 AND s.course_id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
  const lastSyncedAt = courses.map((c) => c.last_synced_at).filter(Boolean).sort().at(-1) || null;
  const { buffer, filename } = createLevelPdf({ level, semester: String(req.query.semester || "current"), courses, sessions, lastSyncedAt });
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" }).send(buffer);
});

if (process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, "dist")));
  app.use((_req, res) => res.sendFile(path.join(root, "dist", "index.html")));
}

const port = Number(process.env.PORT || 5173);
if (process.env.NODE_ENV !== "test") app.listen(port, () => console.log(`Schedule server running at http://localhost:${port}`));
export { app };
