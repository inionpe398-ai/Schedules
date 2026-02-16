import { DAY_ORDER, TIME_SLOTS, normalizeDayName, parseTimeRangeToSlotRange } from "./conflict.js";

function normalizeType(typeText) {
  return (typeText || "").toLowerCase().replace(/\s+/g, "");
}

function getSessionKind(typeText) {
  const normalized = normalizeType(typeText);
  if (normalized === "subgroup" || normalized.includes("sub") || normalized.includes("lab")) {
    return "lab";
  }
  return "lecture";
}

function getGroupLabel(typeText) {
  const normalized = normalizeType(typeText);
  if (normalized === "subgroup" || normalized.includes("sub")) {
    return "(Sub)Group";
  }
  if (normalized === "group") {
    return "Group";
  }
  if (normalized.includes("lab")) {
    return "(Sub)Group";
  }
  return "Group";
}

function buildGrid() {
  const container = document.createElement("div");
  container.className = "grid";

  const header = document.createElement("div");
  header.className = "time-header";

  const corner = document.createElement("div");
  corner.className = "time-cell corner-cell";
  corner.textContent = "Day / Time";
  header.appendChild(corner);

  for (const label of TIME_SLOTS) {
    const cell = document.createElement("div");
    cell.className = "time-cell";
    cell.textContent = label;
    header.appendChild(cell);
  }

  container.appendChild(header);

  for (const day of DAY_ORDER) {
    const row = document.createElement("div");
    row.className = "day-row";
    row.dataset.day = day;

    const label = document.createElement("div");
    label.className = "day-label";
    label.textContent = day;

    const slots = document.createElement("div");
    slots.className = "day-slots";

    for (let i = 0; i < TIME_SLOTS.length; i += 1) {
      const cell = document.createElement("div");
      cell.className = "slot-cell";
      slots.appendChild(cell);
    }

    row.appendChild(label);
    row.appendChild(slots);
    container.appendChild(row);
  }

  return container;
}

function createBlock(session) {
  const slotRange = parseTimeRangeToSlotRange(session.Time, session.Type);
  if (!slotRange) {
    return null;
  }

  const span = slotRange.endIndexExclusive - slotRange.startIndex;
  if (span <= 0) {
    return null;
  }

  const block = document.createElement("div");
  const kind = getSessionKind(session.Type);
  block.className = `slot-block ${kind}`;
  block.style.gridRow = "1";
  block.style.gridColumn = `${slotRange.startIndex + 1} / span ${span}`;

  const groupName = session.GroupName || session.GroupId || "N/A";
  const hall = session.ClassRoomName || "N/A";
  const staff = session.Staff || "N/A";
  const groupLabel = getGroupLabel(session.Type);

  block.innerHTML = [
    `<div><strong>Course:</strong> ${session.courseName}</div>`,
    `<div><strong>${groupLabel}:</strong> ${groupName}</div>`,
    `<div><strong>Hall:</strong> ${hall}</div>`,
    `<div><strong>Staff:</strong> ${staff}</div>`,
  ].join("");

  return block;
}

export function collectRegisteredSessions(coursesById, registrations) {
  const all = [];

  for (const registration of registrations) {
    const course = coursesById.get(registration.courseId);
    if (!course) {
      continue;
    }

    const selectedIds = new Set(registration.selectedGroupIds);
    for (const g of course.groups) {
      if (selectedIds.has(g.GroupId)) {
        all.push({
          ...g,
          courseId: course.id,
          courseName: course.name,
          selectedGroupName: g.GroupName,
        });
      }
    }
  }

  return all;
}

export function renderTimetable(targetEl, sessions) {
  targetEl.innerHTML = "";
  const grid = buildGrid();
  targetEl.appendChild(grid);

  const rows = new Map();
  grid.querySelectorAll(".day-row").forEach((row) => {
    rows.set(row.dataset.day, row.querySelector(".day-slots"));
  });

  for (const session of sessions) {
    const day = normalizeDayName(session);
    const rowSlots = rows.get(day);
    if (!rowSlots) {
      continue;
    }

    const block = createBlock(session);
    if (block) {
      rowSlots.appendChild(block);
    }
  }
}

