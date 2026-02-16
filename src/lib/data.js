const DATA_DIRS = ["/data", "./data"];

const COURSE_NAME_MAP = {
  infection: "Infection Prevention and Control",
  remove: "Removable Prosthodontics Preclinical I",
  operative: "Operative Dentistry (Preclinical) II",
  micro: "Microbiology and Immunology II",
  pharma: "Pharmacology II",
  patho: "General Pathology II",
  pyschological: "Psychological and Behavioral Issues in Dental Practice",
  psychological: "Psychological and Behavioral Issues in Dental Practice",
  "oral public": "Oral Public Health and Preventive Dentistry I",
};

function formatName(fileName) {
  const normalized = fileName
    .replace(/\.json$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  const key = normalized.toLowerCase();
  return COURSE_NAME_MAP[key] || normalized;
}

function cleanText(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\u00A0/g, " ").trim();
}

function sanitizeEntry(entry) {
  return {
    ...entry,
    DayWeekName: cleanText(entry.DayWeekName),
    ClassRoomName: cleanText(entry.ClassRoomName),
    GroupName: cleanText(entry.GroupName),
    Staff: cleanText(entry.Staff),
    Type: cleanText(entry.Type),
    Time: cleanText(entry.Time),
  };
}

export async function loadCourses() {
  for (const baseDir of DATA_DIRS) {
    const manifestRes = await fetch(`${baseDir}/manifest.json`, { cache: "no-store" });
    if (!manifestRes.ok) {
      continue;
    }

    const manifest = await manifestRes.json();
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (!files.length) {
      throw new Error("No files listed in data/manifest.json.");
    }

    const courses = [];
    for (const file of files) {
      const res = await fetch(`${baseDir}/${file}`, { cache: "no-store" });
      if (!res.ok) continue;

      const rows = await res.json();
      if (!Array.isArray(rows)) continue;

      const id = file.replace(/\.json$/i, "");
      courses.push({
        id,
        file,
        name: formatName(file),
        sessions: rows.map(sanitizeEntry),
      });
    }

    if (courses.length) {
      return courses;
    }
  }

  throw new Error("Could not load courses. Check data/manifest.json and JSON files.");
}
