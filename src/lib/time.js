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
];

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

export function groupLabelByType(type) {
  return normalizeType(type).includes("sub") ? "(Sub)Group" : "Group";
}

export function blockKindByType(type) {
  return normalizeType(type).includes("sub") ? "subgroup" : "group";
}

function toHHMM(value) {
  if (typeof value !== "string") return null;
  const [h, m] = value.split(":");
  if (h == null || m == null) return null;
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

export function normalizeDay(entry) {
  if (typeof entry?.DayWeekName === "string" && entry.DayWeekName.trim()) {
    return entry.DayWeekName.trim();
  }
  return DAY_MAP[Number(entry?.DayWeek)] || "Unknown";
}

export function startSlotIndex(time) {
  if (typeof time !== "string") return -1;
  const [rawStart] = time.split("-").map((x) => x.trim());
  const hhmm = toHHMM(rawStart);
  if (!hhmm) return -1;

  return TIME_SLOTS.findIndex((slot) => {
    const [start] = slot.split("-").map((x) => x.trim());
    return start === hhmm;
  });
}

export function slotRange(entry) {
  const start = startSlotIndex(entry?.Time);
  if (start < 0) return null;
  const span = forcedSpanByType(entry?.Type);
  const end = start + span;
  if (end > TIME_SLOTS.length) return null;
  return { start, end, span };
}

export function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function overlapLabel(a, b) {
  const s = Math.max(a.start, b.start);
  const e = Math.min(a.end, b.end);
  if (e <= s) return "";
  const start = TIME_SLOTS[s].split("-")[0].trim();
  const end = TIME_SLOTS[e - 1].split("-")[1].trim();
  return `${start} - ${end}`;
}

function to12h(hhmm) {
  const [hRaw, m] = hhmm.split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const normalized = h % 12 === 0 ? 12 : h % 12;
  return `${normalized}:${m} ${suffix}`;
}

export function formatSlotLabel(slot, format = "24h") {
  if (format !== "12h") return slot;
  const [start, end] = slot.split("-").map((x) => x.trim());
  return `${to12h(start)} - ${to12h(end)}`;
}

