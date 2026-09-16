CREATE TABLE IF NOT EXISTS dulms_course_level_links (
  course_id INTEGER NOT NULL REFERENCES dulms_courses(id) ON DELETE CASCADE,
  academic_level INTEGER NOT NULL CHECK(academic_level BETWEEN 1 AND 5),
  PRIMARY KEY(course_id, academic_level)
);
CREATE INDEX IF NOT EXISTS idx_course_level_links_level ON dulms_course_level_links(academic_level);
