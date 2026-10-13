-- Make the existing course/level link table the source of truth for what each
-- numbered level can see. Seed the current inferred assignments once so the
-- live schedules do not change until an admin edits them.
INSERT OR IGNORE INTO dulms_course_level_links (course_id, academic_level)
SELECT id, academic_level
FROM dulms_courses
WHERE academic_level BETWEEN 1 AND 5;
