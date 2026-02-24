export const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"];

export const TIME_SLOTS = [
  "08:45 - 09:30",
  "09:30 - 10:15",
  "10:15 - 11:00",
  "11:00 - 11:45",
  "11:45 - 12:30",
  "12:30 - 13:15",
  "13:15 - 14:00",
  "14:00 - 14:45",
  "14:45 - 15:30",
  "15:30 - 16:15",
  "16:15 - 17:00",
  "17:00 - 17:45",
  "21:00 - 21:45",
  "21:45 - 22:30",
];

export function buildTimeSlots(startHour, startMinute, endHour, endMinute, slotMinutes) {
  const slots = [];
  if (slotMinutes <= 0) return slots;

  let cursor = startHour * 60 + startMinute;
  const endTotal = endHour * 60 + endMinute;

  while (cursor + slotMinutes <= endTotal) {
    const next = cursor + slotMinutes;
    const start = `${String(Math.floor(cursor / 60)).padStart(2, "0")}:${String(cursor % 60).padStart(2, "0")}`;
    const end = `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
    slots.push(`${start} - ${end}`);
    cursor = next;
  }

  return slots;
}

const DAY_MAP = {
  1: "Sunday",
  2: "Monday",
  3: "Tuesday",
  4: "Wednesday",
  5: "Thursday",
  6: "Friday",
  7: "Saturday",
};

function normalizeType(type) {
  return (type || "").toLowerCase().replace(/\s+/g, "");
}

export function forcedSpanByType(type) {
  return normalizeType(type).includes("sub") ? 2 : 1;
}

function isEconomicsLecture(entry) {
  if (!entry || normalizeType(entry?.Type).includes("sub")) return false;
  const courseId = String(entry?.courseId || "").trim().toLowerCase();
  const courseName = String(entry?.courseName || "").trim().toLowerCase();
  const facultyName = String(entry?.NameEn_Faculty || "").trim().toLowerCase();
  const shortName = String(entry?.ShortName || "").trim().toLowerCase();
  return (
    courseId === "economics" ||
    courseName.includes("economics") ||
    facultyName.includes("economics") ||
    shortName === "eco"
  );
}

export function groupLabelByType(type) {
  return normalizeType(type).includes("sub") ? "(Sub)Group" : "Group";
}

export function blockKindByType(type) {
  return normalizeType(type).includes("sub") ? "subgroup" : "group";
}

function toHHMM(value) {
  if (typeof value !== "string") return null;
  const [h, m] = value.trim().split(":");
  if (h == null || m == null) return null;
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

export function normalizeDay(entry) {
  if (typeof entry?.DayWeekName === "string" && entry.DayWeekName.trim()) {
    return entry.DayWeekName.trim();
  }
  return DAY_MAP[Number(entry?.DayWeek)] || "Unknown";
}

export function startSlotIndex(time, slots = TIME_SLOTS) {
  if (typeof time !== "string") return -1;
  const [rawStart] = time.split("-").map((x) => x.trim());
  const hhmm = toHHMM(rawStart);
  if (!hhmm) return -1;

  return slots.findIndex((slot) => {
    const [start] = slot.split("-").map((x) => x.trim());
    return start === hhmm;
  });
}

function slotRangeInSlots(entry, slots) {
  const start = startSlotIndex(entry?.Time, slots);
  if (start < 0) return null;

  const [, rawEnd] = String(entry?.Time || "")
    .split("-")
    .map((x) => x.trim());
  const endHHMM = toHHMM(rawEnd);
  if (endHHMM) {
    const endIndex = slots.findIndex((slot) => {
      const [, slotEnd] = slot.split("-").map((x) => x.trim());
      return slotEnd === endHHMM;
    });
    if (endIndex >= 0) {
      const end = endIndex + 1;
      if (end > start) return { start, end, span: end - start };
    }
  }

  const fallbackSpan = isEconomicsLecture(entry) ? 2 : forcedSpanByType(entry?.Type);
  const fallbackEnd = start + fallbackSpan;
  if (fallbackEnd > slots.length) return null;
  return { start, end: fallbackEnd, span: fallbackSpan };
}

export function slotRange(entry, slots = TIME_SLOTS) {
  const canMapByIndex =
    Array.isArray(slots) &&
    slots.length > 0 &&
    slots.length === TIME_SLOTS.length &&
    slots !== TIME_SLOTS;
  if (canMapByIndex) {
    const base = slotRangeInSlots(entry, TIME_SLOTS);
    if (!base || base.end > slots.length) return null;
    return base;
  }

  return slotRangeInSlots(entry, slots);
}

export function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function overlapLabel(a, b, slots = TIME_SLOTS) {
  const s = Math.max(a.start, b.start);
  const e = Math.min(a.end, b.end);
  if (e <= s) return "";
  const start = slots[s].split("-")[0].trim();
  const end = slots[e - 1].split("-")[1].trim();
  return `${start} - ${end}`;
}

function to12h(hhmm) {
  const [hRaw, m] = hhmm.split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h)) return hhmm;
  const normalized = h % 12 === 0 ? 12 : h % 12;
  return `${normalized}:${m}`;
}

export function formatSlotLabel(slot, format = "24h") {
  if (format !== "12h") return slot;
  const [start, end] = slot.split("-").map((x) => x.trim());
  return `${to12h(start)} - ${to12h(end)}`;
}
