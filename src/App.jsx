import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadCourses } from "./lib/data";
import {
  DAYS,
  TIME_SLOTS,
  blockKindByType,
  formatSlotLabel,
  forcedSpanByType,
  groupLabelByType,
  normalizeDay,
  overlapLabel,
  rangesOverlap,
  slotRange,
} from "./lib/time";

const STORAGE_KEY = "scheduleManagerSelectionsV2";
const TIME_FORMAT_KEY = "scheduleTimeFormatV1";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || "Unexpected runtime error." };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, fontFamily: "Segoe UI, Tahoma, Arial, sans-serif" }}>
          <h2>Application Error</h2>
          <p>{this.state.message}</p>
          <p>Try hard refresh (Ctrl + F5). If it persists, restart dev server.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function normalizeType(type) {
  return (type || "").toLowerCase().replace(/\s+/g, "");
}

function isSubgroup(type) {
  return normalizeType(type).includes("sub");
}

function isLecture(type) {
  return !isSubgroup(type);
}

function collectGroups(course) {
  const map = new Map();
  for (const session of course.sessions) {
    const id = Number(session.GroupId);
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: session.GroupName || `Group ${id}`,
        type: session.Type || "Group",
        sessions: [],
      });
    }
    map.get(id).sessions.push(session);
  }
  return [...map.values()];
}

function summarize(g) {
  return g.sessions.map((s) => `${s.DayWeekName}: ${s.Time}`).join(" | ");
}

function extractSectionPrefix(groupName) {
  const value = String(groupName || "").trim();
  const match = value.match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : "";
}

function normalizeRegistrations(courses, raw) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(courses.map((c) => c.id));
  return raw.filter((r) => ids.has(r.courseId) && Array.isArray(r.selectedGroupIds));
}

function flattenSessions(coursesById, registrations) {
  const all = [];
  for (const reg of registrations) {
    const course = coursesById.get(reg.courseId);
    if (!course) continue;
    const selected = new Set(reg.selectedGroupIds.map(Number));
    for (const session of course.sessions) {
      if (selected.has(Number(session.GroupId))) {
        all.push({ ...session, courseId: course.id, courseName: course.name, source: "registered" });
      }
    }
  }
  return all;
}

function findConflict(candidate, existing) {
  for (const a of candidate) {
    const dayA = normalizeDay(a);
    const rangeA = slotRange(a);
    if (!DAYS.includes(dayA) || !rangeA) continue;

    for (const b of existing) {
      const dayB = normalizeDay(b);
      const rangeB = slotRange(b);
      if (dayA !== dayB || !rangeB) continue;

      if (rangesOverlap(rangeA, rangeB)) {
        return {
          day: dayA,
          existing: b,
          overlap: overlapLabel(rangeA, rangeB),
        };
      }
    }
  }
  return null;
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm || "")
    .split(":")
    .map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function slotStartMinutes(slotLabel) {
  const parts = String(slotLabel || "").split("-");
  if (!parts.length) return null;
  return timeToMinutes(parts[0].trim());
}

function formatSessionTimeLabel(rawTime, format) {
  const [startRaw, endRaw] = String(rawTime || "")
    .split("-")
    .map((part) => part.trim());
  if (!startRaw || !endRaw) return String(rawTime || "");
  return formatSlotLabel(`${startRaw} - ${endRaw}`, format);
}

function AppBody() {
  const [courses, setCourses] = useState([]);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [registrations, setRegistrations] = useState([]);
  const [preview, setPreview] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [tableOnly, setTableOnly] = useState(false);
  const [globalTrackPick, setGlobalTrackPick] = useState("");
  const [globalTrack, setGlobalTrack] = useState(null);
  const [registrationView, setRegistrationView] = useState("lectures");
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [rankingCriterion, setRankingCriterion] = useState("balanced");
  const [recommendSearch, setRecommendSearch] = useState("");
  const [recommendTypeFilter, setRecommendTypeFilter] = useState("all");
  const [recommendDayFilter, setRecommendDayFilter] = useState("all");
  const [timeFormat, setTimeFormat] = useState(() => {
    const saved = localStorage.getItem(TIME_FORMAT_KEY);
    return saved === "12h" ? "12h" : "24h";
  });
  const scheduleRef = useRef(null);

  const coursesById = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);

  useEffect(() => {
    loadCourses()
      .then((loaded) => {
        setCourses(loaded);

        let parsed = [];
        try {
          const saved = localStorage.getItem(STORAGE_KEY);
          parsed = saved ? JSON.parse(saved) : [];
        } catch {
          parsed = [];
        }

        setRegistrations(normalizeRegistrations(loaded, parsed));
      })
      .catch((e) => setError(e.message || "Failed to load courses."));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registrations));
  }, [registrations]);

  useEffect(() => {
    localStorage.setItem(TIME_FORMAT_KEY, timeFormat);
  }, [timeFormat]);

  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(
        scheduleRef.current &&
          document.fullscreenElement &&
          document.fullscreenElement === scheduleRef.current
      );
      setTableOnly(active);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const selectedCourse = coursesById.get(selectedCourseId);
  const selectedGroups = selectedCourse ? collectGroups(selectedCourse) : [];
  const lectureGroups = selectedGroups.filter((g) => isLecture(g.type));
  const subgroupGroups = selectedGroups.filter((g) => isSubgroup(g.type));
  const groupsByCourseId = useMemo(() => {
    const map = new Map();
    for (const course of courses) {
      const groups = collectGroups(course);
      map.set(course.id, {
        lectures: groups.filter((g) => isLecture(g.type)),
        subgroups: groups.filter((g) => isSubgroup(g.type)),
      });
    }
    return map;
  }, [courses]);

  const currentForCourse = registrations.find((r) => r.courseId === selectedCourseId);
  const currentLectureId = currentForCourse?.selectedGroupIds?.find((id) => lectureGroups.some((g) => g.id === id)) || "";
  const currentSubgroupId = currentForCourse?.selectedGroupIds?.find((id) => subgroupGroups.some((g) => g.id === id)) || "";

  const [lecturePick, setLecturePick] = useState("");
  const [subPick, setSubPick] = useState("");

  useEffect(() => {
    setLecturePick(currentLectureId || "");
    setSubPick(currentSubgroupId || "");
  }, [selectedCourseId, currentLectureId, currentSubgroupId]);

  const registeredSessions = useMemo(() => flattenSessions(coursesById, registrations), [coursesById, registrations]);

  const previewSessions = useMemo(() => {
    const out = [];
    for (const course of courses) {
      const flags = preview[course.id];
      if (!flags) continue;
      for (const session of course.sessions) {
        if (flags.lectures && isLecture(session.Type)) {
          out.push({ ...session, courseName: course.name, source: "preview" });
        }
        if (flags.subgroups && isSubgroup(session.Type)) {
          out.push({ ...session, courseName: course.name, source: "preview" });
        }
      }
    }
    return out;
  }, [courses, preview]);

  const globalTrackSessions = useMemo(() => {
    if (!globalTrack?.section || !globalTrack?.prefix) return [];

    const sectionUpper = globalTrack.section.toUpperCase();
    const prefixUpper = globalTrack.prefix.toUpperCase();
    const out = [];

    for (const course of courses) {
      for (const session of course.sessions) {
        const gName = String(session.GroupName || "").trim().toUpperCase();
        if (isLecture(session.Type) && gName === prefixUpper) {
          out.push({ ...session, courseId: course.id, courseName: course.name, source: "track" });
        }
        if (isSubgroup(session.Type) && gName === sectionUpper) {
          out.push({ ...session, courseId: course.id, courseName: course.name, source: "track" });
        }
      }
    }

    return out;
  }, [globalTrack, courses]);

  const tableSessions = useMemo(() => {
    const all = [...registeredSessions, ...globalTrackSessions, ...previewSessions];
    const seen = new Set();
    const output = [];

    for (const s of all) {
      const key = `${s.courseId || s.courseName}|${s.GroupId}|${s.DayWeek}|${s.Time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(s);
    }

    return output;
  }, [registeredSessions, globalTrackSessions, previewSessions]);
  const registeredCount = registrations.length;
  const activePreviewCount =
    Object.values(preview).filter((p) => p?.lectures || p?.subgroups).length + (globalTrack ? 1 : 0);
  const hasAllPreviewMode = Object.values(preview).some((p) => p?.lectures || p?.subgroups);
  const scoreEnabled = !hasAllPreviewMode && courses.length > 0;
  const hasBuiltSchedule = tableSessions.length > 0 || Boolean(globalTrackPick);

  const globalSubgroupOptions = useMemo(() => {
    const names = new Set();
    for (const course of courses) {
      for (const session of course.sessions) {
        if (isSubgroup(session.Type)) {
          const name = String(session.GroupName || "").trim();
          if (name) names.add(name);
        }
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [courses]);

  const printTitle = useMemo(() => {
    if (globalTrack?.selectedSubgroup) {
      return `${globalTrack.selectedSubgroup} Schedule`;
    }
    if (selectedCourse?.name) {
      return `${selectedCourse.name} Sections`;
    }
    return "Weekly Schedule";
  }, [globalTrack, selectedCourse]);

  const slotStartByIndex = useMemo(() => TIME_SLOTS.map((slot) => slotStartMinutes(slot)), []);

  const freeTimeByDay = useMemo(() => {
    const occupied = new Map(DAYS.map((d) => [d, new Set()]));
    for (const s of tableSessions) {
      const day = normalizeDay(s);
      const range = slotRange(s);
      if (!occupied.has(day) || !range) continue;
      for (let i = range.start; i < range.end; i += 1) occupied.get(day).add(i);
    }

    const result = new Map();
    for (const day of DAYS) {
      const used = occupied.get(day) || new Set();
      if (!used.size) continue;
      const blocks = [];
      let start = null;
      for (let i = 0; i < TIME_SLOTS.length; i += 1) {
        const busy = used.has(i);
        if (!busy && start == null) start = i;
        if ((busy || i === TIME_SLOTS.length - 1) && start != null) {
          const endIndex = busy ? i - 1 : i;
          const startText = TIME_SLOTS[start].split("-")[0].trim();
          const endText = TIME_SLOTS[endIndex].split("-")[1].trim();
          blocks.push(formatSessionTimeLabel(`${startText} - ${endText}`, "12h"));
          start = null;
        }
      }
      result.set(day, blocks);
    }
    return result;
  }, [tableSessions]);

  const recommendationItems = useMemo(() => {
    if (!tableSessions.length) return [];

    const occupied = new Map(DAYS.map((d) => [d, new Set()]));
    for (const s of tableSessions) {
      const day = normalizeDay(s);
      const range = slotRange(s);
      if (!occupied.has(day) || !range) continue;
      for (let i = range.start; i < range.end; i += 1) occupied.get(day).add(i);
    }

    const freeRangesByDay = new Map();
    for (const day of DAYS) {
      const used = occupied.get(day) || new Set();
      if (!used.size) continue;
      const ranges = [];
      let start = null;

      for (let i = 0; i < TIME_SLOTS.length; i += 1) {
        const busy = used.has(i);
        if (!busy && start == null) start = i;
        if ((busy || i === TIME_SLOTS.length - 1) && start != null) {
          const end = busy ? i : i + 1;
          ranges.push({ start, end });
          start = null;
        }
      }
      freeRangesByDay.set(day, ranges);
    }

    const existingSessionKeys = new Set(
      tableSessions.map((s) => `${normalizeDay(s)}|${s.Time}|${s.courseId || s.courseName}|${s.GroupId}`)
    );
    const dayIndex = new Map(DAYS.map((day, idx) => [day, idx]));
    const out = [];

    for (const course of courses) {
      for (const session of course.sessions) {
        const day = normalizeDay(session);
        const freeRanges = freeRangesByDay.get(day) || [];
        if (!freeRanges.length) continue;

        const range = slotRange(session);
        if (!range) continue;

        const key = `${day}|${session.Time}|${course.id}|${session.GroupId}`;
        if (existingSessionKeys.has(key)) continue;

        const fitsFreeBlock = freeRanges.some((freeRange) => range.start >= freeRange.start && range.end <= freeRange.end);
        if (!fitsFreeBlock) continue;

        out.push({
          key,
          day,
          start: range.start,
          time: session.Time,
          type: isSubgroup(session.Type) ? "section" : "lecture",
          typeLabel: isSubgroup(session.Type) ? "Section" : "Lecture",
          courseName: course.name,
          groupName: session.GroupName || `Group ${session.GroupId}`,
        });
      }
    }

    out.sort((a, b) => {
      const byDay = (dayIndex.get(a.day) ?? 999) - (dayIndex.get(b.day) ?? 999);
      if (byDay !== 0) return byDay;
      if (a.start !== b.start) return a.start - b.start;
      return a.courseName.localeCompare(b.courseName);
    });

    return out.slice(0, 30);
  }, [tableSessions, courses]);

  const filteredRecommendationItems = useMemo(() => {
    const search = recommendSearch.trim().toLowerCase();
    return recommendationItems.filter((item) => {
      if (recommendTypeFilter !== "all" && item.type !== recommendTypeFilter) return false;
      if (recommendDayFilter !== "all" && item.day !== recommendDayFilter) return false;
      if (!search) return true;

      const haystack = [
        item.day,
        item.time,
        item.typeLabel,
        item.courseName,
        item.groupName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  }, [recommendationItems, recommendSearch, recommendTypeFilter, recommendDayFilter]);

  function evaluateSchedule(sessions) {
    const occupied = new Map(DAYS.map((d) => [d, new Set()]));
    const lateSessions = new Set();
    for (const s of sessions) {
      const day = normalizeDay(s);
      const range = slotRange(s);
      if (!occupied.has(day) || !range) continue;
      for (let i = range.start; i < range.end; i += 1) occupied.get(day).add(i);
      const startMin = slotStartByIndex[range.start];
      if ((startMin ?? -1) >= 16 * 60) {
        const key = `${day}|${s.courseId || s.courseName}|${s.GroupId}|${s.Time}`;
        lateSessions.add(key);
      }
    }

    let activeDays = 0;
    let gapSlots = 0;

    for (const day of DAYS) {
      const used = Array.from(occupied.get(day) || []).sort((a, b) => a - b);
      if (!used.length) continue;
      activeDays += 1;
      const first = used[0];
      const last = used[used.length - 1];
      for (let i = first; i <= last; i += 1) {
        if (!occupied.get(day).has(i)) gapSlots += 1;
      }
    }

    const after4Sessions = lateSessions.size;
    const scoreDays = Math.max(0, 100 - Math.max(0, activeDays - 1) * 18);
    const scoreGaps = Math.max(0, 100 - gapSlots * 10);
    const scoreLate = Math.max(0, 100 - after4Sessions * 24);
    const overall = Math.round(scoreDays * 0.4 + scoreGaps * 0.35 + scoreLate * 0.25);

    return {
      activeDays,
      gapSlots,
      after4Sessions,
      scoreDays,
      scoreGaps,
      scoreLate,
      overall,
    };
  }

  const currentScheduleScore = useMemo(() => evaluateSchedule(tableSessions), [tableSessions]);

  const allTrackCandidates = useMemo(() => {
    if (!scoreEnabled) return [];
    const candidates = [];

    for (const name of globalSubgroupOptions) {
      const prefix = extractSectionPrefix(name);
      if (!prefix) continue;
      const sectionUpper = name.toUpperCase();
      const prefixUpper = prefix.toUpperCase();
      const trackSessions = [];

      for (const course of courses) {
        for (const session of course.sessions) {
          const gName = String(session.GroupName || "").trim().toUpperCase();
          if (isLecture(session.Type) && gName === prefixUpper) {
            trackSessions.push({ ...session, courseId: course.id, courseName: course.name, source: "track" });
          }
          if (isSubgroup(session.Type) && gName === sectionUpper) {
            trackSessions.push({ ...session, courseId: course.id, courseName: course.name, source: "track" });
          }
        }
      }

      const merged = [];
      const seen = new Set();
      for (const s of [...registeredSessions, ...trackSessions]) {
        const key = `${s.courseId || s.courseName}|${s.GroupId}|${s.DayWeek}|${s.Time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(s);
      }

      candidates.push({
        name,
        prefix,
        score: evaluateSchedule(merged),
      });
    }

    return candidates;
  }, [scoreEnabled, globalSubgroupOptions, courses, registeredSessions]);

  const rankedTrackCandidates = useMemo(() => {
    const sorted = [...allTrackCandidates];
    sorted.sort((a, b) => {
      if (rankingCriterion === "days") return a.score.activeDays - b.score.activeDays || b.score.overall - a.score.overall;
      if (rankingCriterion === "gaps") return a.score.gapSlots - b.score.gapSlots || b.score.overall - a.score.overall;
      if (rankingCriterion === "late")
        return a.score.after4Sessions - b.score.after4Sessions || b.score.overall - a.score.overall;
      return b.score.overall - a.score.overall;
    });
    return sorted;
  }, [allTrackCandidates, rankingCriterion]);

  function showNotice(type, title, message) {
    setNotice({ type, title, message });
  }

  function registerSelection(e) {
    e.preventDefault();
    if (!selectedCourse) return;

    const chosenLecture = Number(lecturePick);
    const chosenSub = subPick ? Number(subPick) : null;
    const hasSubgroups = subgroupGroups.length > 0;

    if (!chosenLecture) {
      showNotice("error", "Registration Error", "Select one lecture group first.");
      return;
    }
    if (hasSubgroups && !chosenSub) {
      showNotice("error", "Registration Error", "This course requires selecting one section/subgroup.");
      return;
    }

    const chosenIds = [chosenLecture, ...(chosenSub ? [chosenSub] : [])];

    const selectedEntries = [];
    for (const id of chosenIds) {
      const sample = selectedCourse.sessions.find((s) => Number(s.GroupId) === id);
      if (sample) selectedEntries.push(sample);
    }

    const lectureCount = selectedEntries.filter((s) => isLecture(s.Type)).length;
    const subCount = selectedEntries.filter((s) => isSubgroup(s.Type)).length;
    if (lectureCount > 1 || subCount > 1) {
      showNotice("error", "Registration Error", "You can only register one lecture and one lab per course.");
      return;
    }

    const candidate = selectedCourse.sessions
      .filter((s) => chosenIds.includes(Number(s.GroupId)))
      .map((s) => ({ ...s, courseName: selectedCourse.name }));

    const others = registrations.filter((r) => r.courseId !== selectedCourse.id);
    const existing = flattenSessions(coursesById, others);
    const conflict = findConflict(candidate, existing);

    if (conflict) {
      showNotice(
        "error",
        "Conflict Detected",
        `Course: ${selectedCourse.name} | Day: ${conflict.day} | Time: ${
          conflict.overlap || "Slot overlap"
        } | Conflicting group: ${conflict.existing.GroupName} (${conflict.existing.courseName})`
      );
      return;
    }

    setRegistrations((prev) => {
      const idx = prev.findIndex((r) => r.courseId === selectedCourse.id);
      const payload = { courseId: selectedCourse.id, selectedGroupIds: chosenIds };
      if (idx === -1) return [...prev, payload];
      const copy = [...prev];
      copy[idx] = payload;
      return copy;
    });
    showNotice("success", "Saved", `${selectedCourse.name} registration updated successfully.`);
  }

  function clearAll() {
    setRegistrations([]);
    setPreview({});
    setGlobalTrack(null);
    localStorage.removeItem(STORAGE_KEY);
    showNotice("info", "Cleared", "All registrations and previews were cleared.");
  }

  function cancelCourseRegistration(courseId) {
    setRegistrations((prev) => prev.filter((r) => r.courseId !== courseId));
    setPreview((prev) => {
      const next = { ...prev };
      delete next[courseId];
      return next;
    });
    showNotice("info", "Cancelled", "Course registration removed.");
  }

  function togglePreview(courseId, key) {
    const current = preview[courseId] || { lectures: false, subgroups: false };
    if (current[key]) {
      setPreview({});
      return;
    }
    setGlobalTrack(null);
    setPreview({
      [courseId]: {
        lectures: key === "lectures",
        subgroups: key === "subgroups",
      },
    });
  }

  function applyGlobalSectionTrack(selectedValue) {
    const selectedName = String((selectedValue ?? globalTrackPick) || "").trim();
    if (!selectedName) {
      setGlobalTrack(null);
      return;
    }

    const prefix = extractSectionPrefix(selectedName);
    if (!prefix) {
      showNotice("error", "Section Track", "Could not detect section prefix from group name.");
      return;
    }

    setGlobalTrack({
      section: selectedName,
      prefix,
      selectedSubgroup: selectedName,
    });
    setPreview({});
  }

  function applyRankedTrack(name) {
    setGlobalTrackPick(name);
    applyGlobalSectionTrack(name);
  }

  async function toggleFullscreen() {
    if (!scheduleRef.current) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setTableOnly(false);
        return;
      }

      await scheduleRef.current.requestFullscreen();
      setTableOnly(true);
    } catch {
      setTableOnly(false);
    }
  }

  function downloadScheduleScreenshot() {
    if (!scheduleRef.current) return;

    const exportSchedule = async () => {
      let snapshotRoot = null;
      try {
        const { default: html2canvas } = await import("html2canvas");

        const sourceTable = scheduleRef.current.querySelector(".timetable");
        if (!sourceTable) {
          showNotice("error", "Download Schedule", "Could not find timetable to capture.");
          return;
        }

        snapshotRoot = document.createElement("div");
        snapshotRoot.style.position = "fixed";
        snapshotRoot.style.left = "-100000px";
        snapshotRoot.style.top = "0";
        snapshotRoot.style.background = "#ffffff";
        snapshotRoot.style.padding = "18px";
        snapshotRoot.style.width = `${sourceTable.scrollWidth + 36}px`;
        snapshotRoot.style.zIndex = "-1";

        const tableClone = sourceTable.cloneNode(true);
        tableClone.style.overflow = "visible";
        tableClone.style.width = "max-content";
        tableClone.style.background = "#ffffff";

        tableClone.querySelectorAll(".timetable, .day-row, .day-grid, .slot-cell").forEach((el) => {
          el.style.background = "#ffffff";
          el.style.backgroundColor = "#ffffff";
          el.style.backgroundImage = "none";
          el.style.filter = "none";
          el.style.opacity = "1";
        });
        tableClone.querySelectorAll(".slot-cell").forEach((el, idx, arr) => {
          el.style.boxShadow = "none";
          el.style.borderRight = idx === arr.length - 1 ? "0" : "1px solid #e2e8f0";
        });

        const exportStyle = document.createElement("style");
        exportStyle.textContent = `
          .timetable,
          .day-grid,
          .slot-cell {
            background: #ffffff !important;
            background-color: #ffffff !important;
          }
          .slot-cell {
            opacity: 1 !important;
            box-shadow: inset -1px 0 0 #e2e8f0 !important;
          }
          .day-grid::before,
          .day-grid::after,
          .slot-cell::before,
          .slot-cell::after {
            content: none !important;
            display: none !important;
          }
        `;
        snapshotRoot.appendChild(exportStyle);
        snapshotRoot.appendChild(tableClone);
        document.body.appendChild(snapshotRoot);

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const targetScale = Math.max(2, Math.min(window.devicePixelRatio || 1, 3));
        const canvas = await html2canvas(snapshotRoot, {
          backgroundColor: "#ffffff",
          scale: targetScale,
          useCORS: true,
          imageTimeout: 0,
          onclone: (clonedDoc) => {
            clonedDoc
              .querySelectorAll(".timetable, .day-row, .day-grid, .slot-cell")
              .forEach((el) => {
                el.style.setProperty("background", "#ffffff", "important");
                el.style.setProperty("background-color", "#ffffff", "important");
                el.style.setProperty("background-image", "none", "important");
                el.style.setProperty("opacity", "1", "important");
                el.style.setProperty("filter", "none", "important");
              });

            clonedDoc.querySelectorAll(".slot-cell").forEach((el, idx, arr) => {
              el.style.setProperty("box-shadow", "none", "important");
              el.style.setProperty(
                "border-right",
                idx === arr.length - 1 ? "0" : "1px solid #e2e8f0",
                "important"
              );
            });
          },
        });

        const dataUrl = canvas.toDataURL("image/png", 1.0);
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = `${printTitle.replace(/\s+/g, "-").toLowerCase()}-schedule.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showNotice("success", "Download Schedule", "Schedule screenshot downloaded.");
      } catch (err) {
        showNotice("error", "Download Schedule", err?.message || "Failed to capture schedule.");
      } finally {
        if (snapshotRoot?.parentNode) snapshotRoot.parentNode.removeChild(snapshotRoot);
      }
    };

    exportSchedule();
  }

  return (
    <div className={`app ${tableOnly ? "table-only" : ""}`}>
      {error && <div className="error">{error}</div>}
      {notice && (
        <div className={`notice ${notice.type}`}>
          <div>
            <strong>{notice.title}</strong>
            <p>{notice.message}</p>
          </div>
          <button type="button" className="notice-close" onClick={() => setNotice(null)}>
            x
          </button>
        </div>
      )}

      <main className="workspace">
        <aside className="control-rail">
          <section className="panel courses-panel">
            <h2>Courses</h2>
            <div className="course-list">
              {courses.map((course) => {
                const p = preview[course.id] || { lectures: false, subgroups: false };
                const split = groupsByCourseId.get(course.id) || { lectures: [], subgroups: [] };
                const expanded = selectedCourseId === course.id;
                return (
                  <div key={course.id} className={`course-card ${expanded ? "active expanded" : ""}`}>
                    <button
                      className="course-name"
                      onClick={() => {
                        if (expanded) {
                          setSelectedCourseId("");
                          return;
                        }
                        setSelectedCourseId(course.id);
                        if (split.lectures.length > 0) {
                          setRegistrationView("lectures");
                        } else if (split.subgroups.length > 0) {
                          setRegistrationView("subgroups");
                        }
                      }}
                      type="button"
                    >
                      {course.name}
                    </button>
                    <div className="course-actions">
                      <button
                        type="button"
                        className={`mini ${p.lectures ? "on" : ""}`}
                        onClick={() => togglePreview(course.id, "lectures")}
                      >
                        All Lectures
                      </button>
                      {course.sessions.some((s) => isSubgroup(s.Type)) && (
                        <button
                          type="button"
                          className={`mini ${p.subgroups ? "on" : ""}`}
                          onClick={() => togglePreview(course.id, "subgroups")}
                        >
                          All Sections
                        </button>
                      )}
                      {registrations.some((r) => r.courseId === course.id) && (
                        <button
                          type="button"
                          className="mini danger"
                          onClick={() => cancelCourseRegistration(course.id)}
                        >
                          Cancel Registration
                        </button>
                      )}
                    </div>
                    {expanded && (
                      <form onSubmit={registerSelection} className="reg-form inline-registration">
                        <div className="registration-switcher" role="tablist" aria-label="Registration view">
                          <button
                            type="button"
                            className={`switch-btn ${registrationView === "lectures" ? "active" : ""}`}
                            onClick={() => setRegistrationView("lectures")}
                          >
                            Groups {lectureGroups.length}
                          </button>
                          {subgroupGroups.length > 0 && (
                            <button
                              type="button"
                              className={`switch-btn ${registrationView === "subgroups" ? "active" : ""}`}
                              onClick={() => setRegistrationView("subgroups")}
                            >
                              Sub Groups {subgroupGroups.length}
                            </button>
                          )}
                        </div>

                        {registrationView === "lectures" && (
                          <div className="group-box">
                            <h4>Lecture Group (one required)</h4>
                            {lectureGroups.map((g) => (
                              <label key={g.id} className="group-item">
                                <input
                                  type="radio"
                                  name="lecture"
                                  value={g.id}
                                  checked={Number(lecturePick) === g.id}
                                  onChange={(ev) => setLecturePick(Number(ev.target.value))}
                                />
                                <span>
                                  <strong>{g.name}</strong> ({g.type})
                                </span>
                                <small>{summarize(g)}</small>
                              </label>
                            ))}
                          </div>
                        )}

                        {registrationView === "subgroups" && subgroupGroups.length > 0 && (
                          <div className="group-box">
                            <h4>Section/Lab (required, one only)</h4>
                            {subgroupGroups.map((g) => (
                              <label key={g.id} className="group-item">
                                <input
                                  type="radio"
                                  name="sub"
                                  value={g.id}
                                  checked={Number(subPick) === g.id}
                                  onChange={(ev) => setSubPick(Number(ev.target.value))}
                                />
                                <span>
                                  <strong>{g.name}</strong> ({g.type})
                                </span>
                                <small>{summarize(g)}</small>
                              </label>
                            ))}
                          </div>
                        )}

                        <button className="btn" type="submit">
                          Register Selection
                        </button>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </aside>

        <section className="panel schedule-panel" ref={scheduleRef}>
          <div className="schedule-head">
            <h2>Weekly Timetable</h2>
            <div className="head-actions">
              <div className="global-track">
                <select
                  value={globalTrackPick}
                  onChange={(e) => {
                    const value = e.target.value;
                    setGlobalTrackPick(value);
                    applyGlobalSectionTrack(value);
                  }}
                  className="track-select"
                >
                  <option value="">Section Track (e.g. B1)</option>
                  {globalSubgroupOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="time-format-toggle" role="group" aria-label="Time format">
                <button
                  className={`mini ${timeFormat === "24h" ? "on" : ""}`}
                  type="button"
                  onClick={() => setTimeFormat("24h")}
                >
                  24h
                </button>
                <button
                  className={`mini ${timeFormat === "12h" ? "on" : ""}`}
                  type="button"
                  onClick={() => setTimeFormat("12h")}
                >
                  12h
                </button>
              </div>
              <button className="btn secondary" type="button" onClick={toggleFullscreen}>
                Full Screen
              </button>
              <button className="btn secondary" type="button" onClick={downloadScheduleScreenshot}>
                Download Schedule
              </button>
              <button className="btn secondary" type="button" onClick={clearAll}>
                Clear All
              </button>
            </div>
          </div>
          <h1 className="print-export-title">{printTitle}</h1>
          <div className="timetable">
            <div className="time-header">
              <div className="corner">Day / Time</div>
              {TIME_SLOTS.map((slot) => (
                <div className="time-cell" key={slot}>
                  {formatSlotLabel(slot, timeFormat)}
                </div>
              ))}
            </div>

            {DAYS.map((day) => (
              <div className="day-row" key={day}>
                <div className="day-label">{day}</div>
                <div className="day-grid">
                  {TIME_SLOTS.map((slot) => (
                    <div className="slot-cell" key={`${day}-${slot}`} />
                  ))}
                  {tableSessions
                    .filter((s) => normalizeDay(s) === day)
                    .map((s, idx) => {
                      const range = slotRange(s);
                      if (!range) return null;

                      return (
                        <article
                          key={`${day}-${s.courseName}-${s.GroupId}-${idx}-${s.Time}`}
                          className={`lesson ${blockKindByType(s.Type)} ${s.source === "preview" ? "preview" : ""} ${
                            s.source === "track" ? "track" : ""
                          }`}
                          style={{ gridColumn: `${range.start + 1} / span ${forcedSpanByType(s.Type)}` }}
                          title={`${s.courseName} | ${s.GroupName} | ${s.Time}`}
                        >
                          <div className="lesson-content">
                            <div>
                              <strong>Course:</strong> {s.courseName}
                            </div>
                            <div>
                              <strong>{groupLabelByType(s.Type)}:</strong> {s.GroupName}
                            </div>
                            <div>
                              <strong>Hall:</strong> {s.ClassRoomName || "N/A"}
                            </div>
                            <div>
                              <strong>Staff:</strong> {s.Staff || "N/A"}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>

          <div className="insights-panel">
            <div className="insights-actions">
              <button className="mini analytics-btn" type="button" onClick={() => setShowAnalytics((v) => !v)}>
                <span className="analytics-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                    <path
                      d="M4 19h16M7 16V8m5 8V5m5 11v-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {showAnalytics ? "Hide Analytics" : "Analytics"}
              </button>
            </div>

            {showAnalytics && (
              <>
                {tableSessions.length > 0 && (
                  <div className="free-time-grid">
                    {Array.from(freeTimeByDay.keys()).map((day) => {
                      const blocks = freeTimeByDay.get(day) || [];
                      return (
                        <div key={`free-${day}`} className="free-day">
                          <strong>{day}</strong>
                          <p>{blocks.length ? blocks.join(" | ") : "No free slots"}</p>
                        </div>
                      );
                    })}
                  </div>
                )}

                {scoreEnabled && hasBuiltSchedule && (
                  <div className="score-panel highlight">
                    <div className="score-header">
                      <h3>{globalTrackPick ? `${globalTrackPick} Analytics` : "Current Schedule Analytics"}</h3>
                    </div>
                    <div className="metric-badges">
                      <span className="metric-badge overall">Score {currentScheduleScore.overall}/100</span>
                      <span className="metric-badge days">Days {currentScheduleScore.activeDays}</span>
                      <span className="metric-badge gaps">Gaps {currentScheduleScore.gapSlots}</span>
                      <span className="metric-badge late">After 4 PM {currentScheduleScore.after4Sessions}</span>
                    </div>
                  </div>
                )}

                {scoreEnabled && !hasBuiltSchedule && (
                  <div className="score-panel">
                    <div className="score-header">
                      <h3>Section Ranking Analytics</h3>
                      <select
                        className="track-select"
                        value={rankingCriterion}
                        onChange={(e) => setRankingCriterion(e.target.value)}
                      >
                        <option value="balanced">Best Overall</option>
                        <option value="days">Fewest Days</option>
                        <option value="gaps">Fewest Gaps</option>
                        <option value="late">No Sessions After 4 PM</option>
                      </select>
                    </div>
                    <div className="ranked-tracks">
                      {rankedTrackCandidates.slice(0, 10).map((c) => (
                        <button
                          key={`rank-${c.name}`}
                          type="button"
                          className={`rank-item ${globalTrackPick === c.name ? "active" : ""}`}
                          onClick={() => applyRankedTrack(c.name)}
                        >
                          <span>{c.name}</span>
                          <small>
                            Score {c.score.overall} | Days {c.score.activeDays} | Gaps {c.score.gapSlots} | After 4:{" "}
                            {c.score.after4Sessions}
                          </small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {!scoreEnabled && (
                  <p className="muted score-line">
                    Analytics is disabled while All Lectures/All Sections preview is active.
                  </p>
                )}

                {tableSessions.length > 0 && (
                  <div className="recommendations-panel">
                    <h3>
                      Recommendations
                      {globalTrackPick ? ` for ${globalTrackPick}` : ""}
                    </h3>
                    <div className="recommendation-filters">
                      <input
                        type="search"
                        className="recommendation-search"
                        value={recommendSearch}
                        onChange={(e) => setRecommendSearch(e.target.value)}
                        placeholder="Search course, group, time..."
                      />
                      <div className="recommendation-type-filter">
                        <button
                          type="button"
                          className={`mini ${recommendTypeFilter === "lecture" ? "on" : ""}`}
                          onClick={() => setRecommendTypeFilter("lecture")}
                        >
                          Lectures
                        </button>
                        <button
                          type="button"
                          className={`mini ${recommendTypeFilter === "section" ? "on" : ""}`}
                          onClick={() => setRecommendTypeFilter("section")}
                        >
                          Sections
                        </button>
                        <button
                          type="button"
                          className={`mini ${recommendTypeFilter === "all" ? "on" : ""}`}
                          onClick={() => setRecommendTypeFilter("all")}
                        >
                          All
                        </button>
                      </div>
                      <select
                        className="track-select recommendation-day-filter"
                        value={recommendDayFilter}
                        onChange={(e) => setRecommendDayFilter(e.target.value)}
                      >
                        <option value="all">All Days</option>
                        {DAYS.map((day) => (
                          <option key={`recommend-day-${day}`} value={day}>
                            {day}
                          </option>
                        ))}
                      </select>
                    </div>

                    {filteredRecommendationItems.length > 0 ? (
                      <div className="recommendation-list">
                        {filteredRecommendationItems.map((item) => (
                          <article
                            key={`recommend-${item.key}`}
                            className={`recommendation-item ${item.type === "section" ? "section" : "lecture"}`}
                          >
                            <div className="recommendation-head">
                              <strong>{item.courseName}</strong>
                              <span className={`recommendation-type ${item.type}`}>{item.typeLabel}</span>
                            </div>
                            <div className="recommendation-meta">
                              <span className="recommendation-chip day">{item.day}</span>
                              <span className="recommendation-chip time">
                                {formatSessionTimeLabel(item.time, timeFormat)}
                              </span>
                              <span className="recommendation-chip group">{item.groupName}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="muted score-line">
                        No recommendations match your current filters.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="legend">
            <span>
              <i className="dot lecture" /> Registered Lecture
            </span>
            <span>
              <i className="dot section" /> Registered Section
            </span>
            <span>
              <i className="dot preview" /> Preview (all lectures/sections)
            </span>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppBody />
    </ErrorBoundary>
  );
}

