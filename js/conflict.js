const DAY_ORDER = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"];
const TIME_SLOTS = [
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

function parseClockToMinutes(value) {
  const [h, m] = value.split(":").map((n) => Number(n));
  if (Number.isNaN(h) || Number.isNaN(m)) {
    return null;
  }
  return h * 60 + m;
}

function normalizeClock(value) {
  if (typeof value !== "string") {
    return null;
  }

  const [h, m] = value.split(":");
  if (h == null || m == null) {
    return null;
  }

  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

const SLOT_RANGES = TIME_SLOTS.map((slot, index) => {
  const [startRaw, endRaw] = slot.split("-").map((s) => s.trim());
  return {
    index,
    label: slot,
    startClock: normalizeClock(startRaw),
    endClock: normalizeClock(endRaw),
    start: parseClockToMinutes(startRaw),
    end: parseClockToMinutes(endRaw),
  };
});

function toClockRange(timeRange) {
  if (!timeRange || typeof timeRange !== "string") {
    return null;
  }

  const parts = timeRange.split("-").map((p) => p.trim());
  if (parts.length !== 2) {
    return null;
  }

  const startClock = normalizeClock(parts[0]);
  const endClock = normalizeClock(parts[1]);
  if (!startClock || !endClock) {
    return null;
  }

  return { startClock, endClock };
}

function normalizeType(typeText) {
  return (typeText || "").toLowerCase().replace(/\s+/g, "");
}

export function getForcedSpanByType(typeText) {
  const normalized = normalizeType(typeText);
  if (normalized === "subgroup" || normalized === "sub" || normalized.includes("sub") || normalized.includes("lab")) {
    return 2;
  }
  return 1;
}

export function parseTimeRangeToMinutes(timeRange) {
  const clocks = toClockRange(timeRange);
  if (!clocks) {
    return null;
  }

  const start = parseClockToMinutes(clocks.startClock);
  const end = parseClockToMinutes(clocks.endClock);
  if (start == null || end == null) {
    return null;
  }

  return { start, end };
}

export function parseTimeRangeToSlotRange(timeRange, typeText = "Group") {
  const clocks = toClockRange(timeRange);
  if (!clocks) {
    return null;
  }

  const startIndex = SLOT_RANGES.findIndex((s) => s.startClock === clocks.startClock);
  if (startIndex < 0) {
    return null;
  }

  const span = getForcedSpanByType(typeText);
  const endIndexExclusive = startIndex + span;
  if (endIndexExclusive > TIME_SLOTS.length) {
    return null;
  }

  return {
    startIndex,
    endIndexExclusive,
  };
}

export function normalizeDayName(entry) {
  const explicit = entry.DayWeekName;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }

  const dayNumber = Number(entry.DayWeek);
  const map = {
    1: "Sunday",
    2: "Monday",
    3: "Tuesday",
    4: "Wednesday",
    5: "Thursday",
    6: "Friday",
    7: "Saturday",
  };
  return map[dayNumber] ?? "Unknown";
}

function isSlotOverlap(a, b) {
  return a.startIndex < b.endIndexExclusive && b.startIndex < a.endIndexExclusive;
}

export function formatSlotRange(slotRange) {
  if (!slotRange) {
    return "";
  }

  const startSlot = SLOT_RANGES[slotRange.startIndex];
  const endSlot = SLOT_RANGES[slotRange.endIndexExclusive - 1];
  if (!startSlot || !endSlot) {
    return "";
  }

  return `${startSlot.startClock} - ${endSlot.endClock}`;
}

export function findFirstConflict(candidateSessions, currentSessions) {
  for (const session of candidateSessions) {
    const sessionDay = normalizeDayName(session);
    if (!DAY_ORDER.includes(sessionDay)) {
      continue;
    }

    const sessionRange = parseTimeRangeToSlotRange(session.Time, session.Type);
    if (!sessionRange) {
      continue;
    }

    for (const existing of currentSessions) {
      const existingDay = normalizeDayName(existing);
      if (sessionDay !== existingDay) {
        continue;
      }

      const existingRange = parseTimeRangeToSlotRange(existing.Time, existing.Type);
      if (!existingRange) {
        continue;
      }

      if (isSlotOverlap(sessionRange, existingRange)) {
        const overlapStart = Math.max(sessionRange.startIndex, existingRange.startIndex);
        const overlapEndExclusive = Math.min(sessionRange.endIndexExclusive, existingRange.endIndexExclusive);
        return {
          candidate: session,
          existing,
          overlapSlotRange: {
            startIndex: overlapStart,
            endIndexExclusive: overlapEndExclusive,
          },
        };
      }
    }
  }

  return null;
}

export { DAY_ORDER, TIME_SLOTS };
