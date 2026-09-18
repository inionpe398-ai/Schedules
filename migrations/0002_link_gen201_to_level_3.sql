-- GEN201 is a shared general-requirement course, but it is required in Level 3.
-- Keep its source academic_level NULL while making it available in the Level 3 schedule.
INSERT OR IGNORE INTO dulms_course_level_links (course_id, academic_level)
SELECT id, 3
FROM dulms_courses
WHERE normalized_course_code = 'GEN201';
