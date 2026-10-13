-- Keep local/server development aligned with the Cloudflare D1 migration.
INSERT OR IGNORE INTO dulms_course_level_links (course_id, academic_level)
SELECT id, academic_level
FROM dulms_courses
WHERE academic_level BETWEEN 1 AND 5;
