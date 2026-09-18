function cleanGroupName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[_–—]/g, "-")
    .replace(/\s+/g, " ");
}

/**
 * Reads the stable, human-facing part of DULMS group labels.
 *
 * DULMS has used all of these forms for the same track: A1, A01, Group A,
 * Group A01, and Dent-Group A.  The display label can change between syncs,
 * so consumers should compare this identity instead of an exact label.
 */
export function parseGroupIdentity(groupName) {
  const raw = String(groupName || "").trim();
  const value = cleanGroupName(raw);
  if (!value) return null;

  const named = value.match(/(?:^|\s)(?:DENT\s*-?\s*)?(?:GROUP|SECTION|SUB\s*GROUP|LAB)\s*-?\s*([A-Z]+)\s*-?\s*(\d+)?(?:$|\s)/);
  const du = value.match(/^DU\s*-\s*([A-Z]+)\s*-?\s*(\d+)?$/);
  const compact = value.match(/(?:^|[^A-Z0-9])([A-Z]+)\s*-?\s*(\d+)(?:$|[^A-Z0-9])/);
  const match = named || du || compact;
  if (!match) return null;

  const prefix = match[1];
  const numberText = match[2] || "";
  const number = numberText ? Number(numberText) : null;
  return {
    raw,
    upper: value,
    prefix,
    number,
    numberText,
    token: `${prefix}${numberText}`,
  };
}

export function extractSectionPrefix(groupName) {
  return parseGroupIdentity(groupName)?.prefix || "";
}

export function extractLecturePrefix(groupName) {
  return parseGroupIdentity(groupName)?.prefix || "";
}

export function lectureMatchesSection(lectureName, sectionName) {
  const lecturePrefix = extractLecturePrefix(lectureName);
  const sectionPrefix = extractSectionPrefix(sectionName);
  return Boolean(lecturePrefix && sectionPrefix && lecturePrefix === sectionPrefix);
}

export function parseSectionGroupName(groupName) {
  const parsed = parseGroupIdentity(groupName);
  if (!parsed || parsed.number == null) return null;
  return parsed;
}

// A01 and A1 identify the same DULMS section. Keep the original name for
// display, but use this key whenever sections are matched across courses.
export function groupTrackKey(groupName) {
  const parsed = parseGroupIdentity(groupName);
  if (parsed?.number != null) return `${parsed.prefix}${parsed.number}`;
  return cleanGroupName(groupName);
}

export function pairedSectionGroupNames(groupName) {
  const parsed = parseSectionGroupName(groupName);
  if (!parsed) {
    const single = cleanGroupName(groupName);
    return single ? [single] : [];
  }
  const pairStart = parsed.number % 2 === 0 ? parsed.number - 1 : parsed.number;
  const width = Math.max(1, parsed.numberText.length);
  const format = (number) => `${parsed.prefix}${String(number).padStart(width, "0")}`;
  return [format(pairStart), format(pairStart + 1)];
}

export function pairedSectionLabel(groupName) {
  const pair = pairedSectionGroupNames(groupName);
  return pair.length ? pair.join("/") : String(groupName || "").trim();
}
