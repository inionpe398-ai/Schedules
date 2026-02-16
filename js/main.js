import { loadAllCourses } from "./dataLoader.js";
import { findFirstConflict, formatSlotRange } from "./conflict.js";
import { collectRegisteredSessions, renderTimetable } from "./scheduleRenderer.js";

const STORAGE_KEY = "scheduleManagerSelections";

const state = {
  courses: [],
  coursesById: new Map(),
  registrations: [],
  selectedCourseId: null,
};

const ui = {
  courseList: document.getElementById("course-list"),
  selectionHint: document.getElementById("selection-hint"),
  groupForm: document.getElementById("group-form"),
  lectureOptions: document.getElementById("lecture-options"),
  labOptions: document.getElementById("lab-options"),
  timetable: document.getElementById("timetable"),
  clearBtn: document.getElementById("clear-schedule"),
};

function normalizeType(typeText) {
  return (typeText || "").toLowerCase().replace(/\s+/g, "");
}

function isSubgroupType(typeText) {
  const value = normalizeType(typeText);
  return value === "subgroup" || value.includes("sub") || value.includes("lab") || value.includes("practical");
}

function isLectureType(typeText) {
  return !isSubgroupType(typeText);
}

function groupByGroupId(course) {
  const map = new Map();

  for (const entry of course.groups) {
    const id = entry.GroupId;
    if (!map.has(id)) {
      map.set(id, {
        groupId: id,
        groupName: entry.GroupName || `Group ${id}`,
        type: entry.Type || "Group",
        sessions: [],
      });
    }
    map.get(id).sessions.push(entry);
  }

  return Array.from(map.values());
}

function summarizeSessions(sessions) {
  return sessions
    .map((s) => `${s.DayWeekName || s.DayWeek}: ${s.Time}${s.ClassRoomName ? ` @ ${s.ClassRoomName}` : ""}`)
    .join(" | ");
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.registrations));
}

function getCurrentSessions() {
  return collectRegisteredSessions(state.coursesById, state.registrations);
}

function upsertRegistration(courseId, selectedGroupIds) {
  const existingIndex = state.registrations.findIndex((r) => r.courseId === courseId);
  const payload = { courseId, selectedGroupIds };

  if (existingIndex >= 0) {
    state.registrations.splice(existingIndex, 1, payload);
  } else {
    state.registrations.push(payload);
  }
}

function renderCourseList() {
  ui.courseList.innerHTML = "";

  for (const course of state.courses) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `course-btn${state.selectedCourseId === course.id ? " active" : ""}`;
    button.textContent = course.name;
    button.addEventListener("click", () => {
      state.selectedCourseId = course.id;
      renderCourseList();
      renderGroupSelector(course.id);
    });
    ui.courseList.appendChild(button);
  }
}

function createOptionRow(inputName, option, checked) {
  const row = document.createElement("div");
  row.className = "option-row";

  const id = `${inputName}-${option.groupId}`;
  row.innerHTML = `
    <label for="${id}">
      <input id="${id}" type="radio" name="${inputName}" value="${option.groupId}" ${checked ? "checked" : ""}>
      <span class="option-title">${option.groupName} (${option.type})</span>
      <div class="option-meta">${summarizeSessions(option.sessions)}</div>
    </label>
  `;

  return row;
}

function renderGroupSelector(courseId) {
  const course = state.coursesById.get(courseId);
  if (!course) {
    return;
  }

  const grouped = groupByGroupId(course);
  const lectures = grouped.filter((g) => isLectureType(g.type));
  const labs = grouped.filter((g) => isSubgroupType(g.type));

  const current = state.registrations.find((r) => r.courseId === courseId);
  const selectedLecture = current?.selectedGroupIds.find((id) => lectures.some((l) => l.groupId === id));
  const selectedLab = current?.selectedGroupIds.find((id) => labs.some((l) => l.groupId === id));

  ui.selectionHint.textContent = `Selected course: ${course.name}`;
  ui.groupForm.classList.remove("hidden");

  ui.lectureOptions.innerHTML = "";
  ui.labOptions.innerHTML = "";

  if (!lectures.length) {
    ui.lectureOptions.innerHTML = '<p class="muted">No lecture groups found.</p>';
  } else {
    for (const option of lectures) {
      ui.lectureOptions.appendChild(createOptionRow("lectureGroup", option, option.groupId === selectedLecture));
    }
  }

  if (!labs.length) {
    ui.labOptions.innerHTML = '<p class="muted">No labs/subgroups for this course.</p>';
  } else {
    const noneRow = document.createElement("div");
    noneRow.className = "option-row";
    noneRow.innerHTML = `
      <label>
        <input type="radio" name="labGroup" value="" ${selectedLab ? "" : "checked"}>
        <span class="option-title">No lab/subgroup</span>
      </label>
    `;
    ui.labOptions.appendChild(noneRow);

    for (const option of labs) {
      ui.labOptions.appendChild(createOptionRow("labGroup", option, option.groupId === selectedLab));
    }
  }
}

function validateRegistrationSelection(course, selectedIds) {
  const selectedSet = new Set(selectedIds);
  const selectedGroups = [];

  for (const id of selectedSet) {
    const firstEntry = course.groups.find((g) => g.GroupId === id);
    if (firstEntry) {
      selectedGroups.push(firstEntry);
    }
  }

  const lectureCount = selectedGroups.filter((g) => isLectureType(g.Type)).length;
  const subgroupCount = selectedGroups.filter((g) => isSubgroupType(g.Type)).length;

  if (lectureCount > 1 || subgroupCount > 1) {
    alert("You can only register one lecture and one lab per course.");
    return false;
  }

  if (lectureCount === 0) {
    alert("Select one lecture group.");
    return false;
  }

  return true;
}

function handleRegistrationSubmit(event) {
  event.preventDefault();

  const courseId = state.selectedCourseId;
  if (!courseId) {
    return;
  }

  const course = state.coursesById.get(courseId);
  if (!course) {
    return;
  }

  const lectureInput = ui.groupForm.querySelector("input[name='lectureGroup']:checked");
  if (!lectureInput?.value) {
    alert("Select one lecture group.");
    return;
  }

  const selectedIds = [Number(lectureInput.value)];
  const labInput = ui.groupForm.querySelector("input[name='labGroup']:checked");
  if (labInput?.value) {
    selectedIds.push(Number(labInput.value));
  }

  if (!validateRegistrationSelection(course, selectedIds)) {
    return;
  }

  const candidateSessions = course.groups
    .filter((g) => selectedIds.includes(g.GroupId))
    .map((g) => ({ ...g, courseName: course.name }));

  const otherRegistrations = state.registrations.filter((r) => r.courseId !== courseId);
  const existingSessions = collectRegisteredSessions(state.coursesById, otherRegistrations);
  const conflict = findFirstConflict(candidateSessions, existingSessions);

  if (conflict) {
    const day = conflict.candidate.DayWeekName || conflict.candidate.DayWeek;
    const conflictingGroup = conflict.existing.GroupName || conflict.existing.GroupId;
    const overlapText = formatSlotRange(conflict.overlapSlotRange) || conflict.candidate.Time;
    alert(
      `Conflict detected\n` +
        `Course: ${course.name}\n` +
        `Day: ${day}\n` +
        `Time: ${overlapText}\n` +
        `Conflicting group: ${conflictingGroup} (${conflict.existing.courseName})`
    );
    return;
  }

  upsertRegistration(courseId, selectedIds);
  saveToStorage();
  renderSchedule();
}

function renderSchedule() {
  const sessions = getCurrentSessions();
  renderTimetable(ui.timetable, sessions);
}

function setupEvents() {
  ui.groupForm.addEventListener("submit", handleRegistrationSubmit);
  ui.clearBtn.addEventListener("click", () => {
    state.registrations = [];
    saveToStorage();
    renderSchedule();
    if (state.selectedCourseId) {
      renderGroupSelector(state.selectedCourseId);
    }
  });
}

async function initialize() {
  try {
    state.courses = await loadAllCourses();
  } catch (error) {
    ui.courseList.innerHTML = `<p class="muted">${error.message}</p>`;
    renderTimetable(ui.timetable, []);
    return;
  }

  state.coursesById = new Map(state.courses.map((c) => [c.id, c]));

  state.registrations = loadFromStorage().filter((r) => state.coursesById.has(r.courseId));

  renderCourseList();
  renderSchedule();

  if (state.courses.length) {
    state.selectedCourseId = state.courses[0].id;
    renderCourseList();
    renderGroupSelector(state.selectedCourseId);
  } else {
    ui.selectionHint.textContent = "No courses found in /data.";
  }

  setupEvents();
}

initialize();
