CREATE TABLE IF NOT EXISTS dulms_courses (
  id INTEGER PRIMARY KEY,
  source_course_id INTEGER NOT NULL,
  course_code TEXT NOT NULL,
  normalized_course_code TEXT NOT NULL UNIQUE,
  course_name TEXT NOT NULL,
  category TEXT,
  academic_level INTEGER,
  credit_hours REAL,
  semester TEXT NOT NULL DEFAULT 'current',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_seen_at TEXT,
  source_hash TEXT,
  sync_run_id TEXT,
  raw_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dulms_sessions (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  source_group_id INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  group_type TEXT NOT NULL,
  academic_level INTEGER,
  day_week INTEGER,
  day_name TEXT,
  start_time TEXT,
  end_time TEXT,
  raw_time TEXT NOT NULL,
  room_raw TEXT,
  faculty_name_raw TEXT,
  staff TEXT,
  session_kind TEXT,
  interval_id INTEGER,
  intervals_count INTEGER,
  bg_color TEXT,
  is_every_week INTEGER,
  is_blocked INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_seen_at TEXT,
  source_hash TEXT NOT NULL,
  sync_run_id TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courses_level ON dulms_courses(academic_level, is_active);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON dulms_sessions(course_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sessions_level ON dulms_sessions(academic_level, is_active);
CREATE TABLE IF NOT EXISTS dulms_sync_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  requested_scope TEXT NOT NULL,
  refresh_catalog INTEGER NOT NULL DEFAULT 1,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  safe_error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS dulms_sync_snapshots (run_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dulms_sync_changes (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  change_type TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dulms_course_level_links (
  course_id INTEGER NOT NULL,
  academic_level INTEGER NOT NULL CHECK(academic_level BETWEEN 1 AND 5),
  PRIMARY KEY(course_id, academic_level)
);
