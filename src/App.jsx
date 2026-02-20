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
const PRESET_C1_MODIFIED_ID = "preset-c1-modified";
const FORCED_STAFF_NAME = "Islam Bendary";
const FORCED_STAFF_GROUPS = new Set(["C1", "C2", "B5", "B6", "B1", "B2", "A5", "A6", "C3", "C4", "B7", "B8"]);
const LATE_THRESHOLD_MINUTES = 16 * 60 + 15;
const MAX_PLAN_SEARCH_LIMIT = 20000;
const DAY_WEEK_BY_NAME = {
  Sunday: 1,
  Monday: 2,
  Tuesday: 3,
  Wednesday: 4,
  Thursday: 5,
  Friday: 6,
  Saturday: 7,
};

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

function parseSectionGroupName(groupName) {
  const value = String(groupName || "").trim();
  const match = value.match(/^([A-Za-z]+)\s*(\d+)$/);
  if (!match) return null;
  return {
    raw: value,
    upper: value.toUpperCase(),
    prefix: match[1].toUpperCase(),
    number: Number(match[2]),
  };
}

function pairedSectionGroupNames(groupName) {
  const parsed = parseSectionGroupName(groupName);
  if (!parsed) {
    const single = String(groupName || "").trim().toUpperCase();
    return single ? [single] : [];
  }
  const pairStart = parsed.number % 2 === 0 ? parsed.number - 1 : parsed.number;
  return [`${parsed.prefix}${pairStart}`, `${parsed.prefix}${pairStart + 1}`];
}

function pairedSectionLabel(groupName) {
  const pair = pairedSectionGroupNames(groupName);
  if (!pair.length) return String(groupName || "").trim();
  return pair.join("/");
}

function buildAutoModifiedLabel(baseLabel, existingLabels) {
  const root = `${String(baseLabel || "").trim()} Modified`.trim();
  if (!existingLabels.has(root)) return root;
  let index = 2;
  while (existingLabels.has(`${root} ${index}`)) index += 1;
  return `${root} ${index}`;
}

function buildMergedTrackOptions(subgroupNames) {
  const parsed = subgroupNames
    .map(parseSectionGroupName)
    .filter(Boolean);
  const byPrefix = new Map();
  const unmatched = [];

  for (const item of parsed) {
    if (!byPrefix.has(item.prefix)) byPrefix.set(item.prefix, new Map());
    byPrefix.get(item.prefix).set(item.number, item.raw);
  }

  for (const name of subgroupNames) {
    if (!parseSectionGroupName(name)) unmatched.push(name);
  }

  const options = [];
  for (const [prefix, byNumber] of byPrefix.entries()) {
    const numbers = Array.from(byNumber.keys()).sort((a, b) => a - b);
    const seenStarts = new Set();
    for (const n of numbers) {
      const pairStart = n % 2 === 0 ? n - 1 : n;
      if (seenStarts.has(pairStart)) continue;
      seenStarts.add(pairStart);

      const first = byNumber.get(pairStart);
      const second = byNumber.get(pairStart + 1);
      const sections = [first, second].filter(Boolean);
      if (!sections.length) continue;

      const label = sections.length === 2 ? `${prefix}${pairStart}/${prefix}${pairStart + 1}` : sections[0];
      options.push({
        id: `regular-${label}`,
        label,
        prefix,
        sections,
        isModified: false,
        mode: "regular",
      });
    }
  }

  for (const name of unmatched.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const prefix = extractSectionPrefix(name);
    if (!prefix) continue;
    options.push({
      id: `regular-${name}`,
      label: name,
      prefix,
      sections: [name],
      isModified: false,
      mode: "regular",
    });
  }

  options.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return options;
}

function toSecondsHHMM(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.length === 5 ? `${raw}:00` : raw;
}

function sessionKeyForTrack(courseId, session) {
  return `${courseId}|${session.GroupId}|${session.DayWeek}|${session.IntervalId || ""}|${session.NameEn || ""}`;
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

function sessionsOverlap(a, b) {
  const dayA = normalizeDay(a);
  const dayB = normalizeDay(b);
  if (dayA !== dayB) return false;
  const rangeA = slotRange(a);
  const rangeB = slotRange(b);
  if (!rangeA || !rangeB) return false;
  return rangesOverlap(rangeA, rangeB);
}

function countSessionConflicts(sessions) {
  let total = 0;
  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      if (sessionsOverlap(sessions[i], sessions[j])) total += 1;
    }
  }
  return total;
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
  const [showDamagePlanner, setShowDamagePlanner] = useState(false);
  const [showPlannerManual, setShowPlannerManual] = useState(false);
  const [plannerMaxChanges, setPlannerMaxChanges] = useState(2);
  const [plannerLocks, setPlannerLocks] = useState({});
  const [plannerChangeFlags, setPlannerChangeFlags] = useState({});
  const [damagePlans, setDamagePlans] = useState([]);
  const [customTrackOptions, setCustomTrackOptions] = useState([]);
  const [trackOverrides, setTrackOverrides] = useState({});
  const [removedModifiedTrackIds, setRemovedModifiedTrackIds] = useState([]);
  const [showModifyPanel, setShowModifyPanel] = useState(false);
  const [modifyMode, setModifyMode] = useState("regular");
  const [modifyTrackId, setModifyTrackId] = useState("");
  const [modifySessionKey, setModifySessionKey] = useState("");
  const [modifyStaff, setModifyStaff] = useState("");
  const [modifyStartIndex, setModifyStartIndex] = useState("");
  const [modifyDay, setModifyDay] = useState("");
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

  const registeredCourseAlternatives = useMemo(() => {
    const out = [];
    for (const reg of registrations) {
      const course = coursesById.get(reg.courseId);
      const groups = groupsByCourseId.get(reg.courseId);
      if (!course || !groups) continue;

      const lectureChoices = groups.lectures || [];
      const sectionChoices = groups.subgroups || [];
      if (!lectureChoices.length) continue;

      const currentLectureId = reg.selectedGroupIds.find((id) => lectureChoices.some((g) => g.id === Number(id))) || null;
      const currentSectionId = reg.selectedGroupIds.find((id) => sectionChoices.some((g) => g.id === Number(id))) || null;

      const combos = [];
      for (const lecture of lectureChoices) {
        if (!sectionChoices.length) {
          const ids = [lecture.id];
          combos.push({
            key: ids.join("-"),
            groupIds: ids,
            lectureId: lecture.id,
            sectionId: null,
            label: `${lecture.name}`,
          });
          continue;
        }

        for (const section of sectionChoices) {
          const ids = [lecture.id, section.id];
          combos.push({
            key: ids.join("-"),
            groupIds: ids,
            lectureId: lecture.id,
            sectionId: section.id,
            label: `${lecture.name} + ${pairedSectionLabel(section.name)}`,
          });
        }
      }

      const currentKey = [currentLectureId, ...(currentSectionId ? [currentSectionId] : [])].join("-");
      out.push({
        courseId: course.id,
        courseName: course.name,
        currentKey,
        combos,
        hasSections: sectionChoices.length > 0,
      });
    }
    return out;
  }, [registrations, coursesById, groupsByCourseId]);

  useEffect(() => {
    const validCourseIds = new Set(registeredCourseAlternatives.map((item) => item.courseId));
    setPlannerLocks((prev) => {
      const next = {};
      for (const [courseId, value] of Object.entries(prev)) {
        if (validCourseIds.has(courseId)) next[courseId] = value;
      }
      return next;
    });
    setPlannerChangeFlags((prev) => {
      const next = {};
      for (const [courseId, value] of Object.entries(prev)) {
        if (validCourseIds.has(courseId)) next[courseId] = value;
      }
      return next;
    });
  }, [registeredCourseAlternatives]);

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
          out.push({ ...session, courseId: course.id, courseName: course.name, source: "preview" });
        }
        if (flags.subgroups && isSubgroup(session.Type)) {
          out.push({ ...session, courseId: course.id, courseName: course.name, source: "preview" });
        }
      }
    }
    return out;
  }, [courses, preview]);

  const applyStaffPreset = (session) => {
    const sectionName = String(session.GroupName || "").trim().toUpperCase();
    if (!FORCED_STAFF_GROUPS.has(sectionName)) return session;
    return { ...session, Staff: FORCED_STAFF_NAME };
  };

  const subgroupNames = useMemo(() => {
    const names = new Set();
    for (const course of courses) {
      for (const session of course.sessions) {
        if (isSubgroup(session.Type)) {
          const name = String(session.GroupName || "").trim();
          if (name) names.add(name);
        }
      }
    }
    return Array.from(names);
  }, [courses]);

  const baseTrackOptions = useMemo(() => buildMergedTrackOptions(subgroupNames), [subgroupNames]);

  const presetC1ModifiedTrack = useMemo(() => {
    const hasC1 = subgroupNames.some((name) => String(name).toUpperCase() === "C1");
    if (!hasC1) return null;
    return {
      id: PRESET_C1_MODIFIED_ID,
      label: "C1/C2 Modified",
      prefix: "C",
      sections: ["C1", "C2"],
      isModified: true,
      mode: "modified",
      baseTrackId: "regular-C1/C2",
    };
  }, [subgroupNames]);

  const trackOptions = useMemo(() => {
    const out = [...baseTrackOptions];
    if (presetC1ModifiedTrack) out.push(presetC1ModifiedTrack);
    out.push(...customTrackOptions);
    return out.filter((track) => !removedModifiedTrackIds.includes(track.id));
  }, [baseTrackOptions, presetC1ModifiedTrack, customTrackOptions, removedModifiedTrackIds]);

  const trackById = useMemo(() => new Map(trackOptions.map((track) => [track.id, track])), [trackOptions]);
  const activeTrackOption = useMemo(() => trackById.get(globalTrackPick) || null, [trackById, globalTrackPick]);
  const activeTrackOverrideMap = useMemo(
    () => (activeTrackOption ? trackOverrides[activeTrackOption.id] || {} : {}),
    [activeTrackOption, trackOverrides]
  );
  const globalOverridesMap = useMemo(() => {
    const merged = {};
    for (const map of Object.values(trackOverrides || {})) {
      if (!map || typeof map !== "object") continue;
      Object.assign(merged, map);
    }
    return merged;
  }, [trackOverrides]);
  const shouldSyncWithModified = useMemo(
    () => Boolean(activeTrackOption && (activeTrackOption.isModified || Object.keys(activeTrackOverrideMap).length)),
    [activeTrackOption, activeTrackOverrideMap]
  );

  function isPresetC1ModifiedTrack(track) {
    if (!track) return false;
    return track.id === PRESET_C1_MODIFIED_ID || track.baseTrackId === PRESET_C1_MODIFIED_ID;
  }

  function applyTrackSpecificAdjustments(rawSession, courseId, track, overrideMap = {}) {
    let session = applyStaffPreset(rawSession);
    let isModified = false;
    let modifiedReason = "";

    const groupUpper = String(session.GroupName || "").trim().toUpperCase();
    const c1Pair = new Set(pairedSectionGroupNames("C1"));
    if (
      isPresetC1ModifiedTrack(track) &&
      String(courseId || "").toLowerCase() === "operative" &&
      c1Pair.has(groupUpper) &&
      String(session.Time || "").includes("12:30")
    ) {
      session = { ...session, Time: "08:45:00 - 10:15:00" };
      isModified = true;
      modifiedReason = "Time changed for C1 Modified";
    }

    const key = sessionKeyForTrack(courseId, rawSession);
    const override = overrideMap[key];
    if (override) {
      session = {
        ...session,
        Staff: override.Staff ?? session.Staff,
        Time: override.Time ?? session.Time,
        DayWeekName: override.DayWeekName ?? session.DayWeekName,
        DayWeek: override.DayWeek ?? session.DayWeek,
      };
      isModified = true;
      modifiedReason = "Manual modify";
    }

    return { session, isModified, modifiedReason, key };
  }

  useEffect(() => {
    if (!modifyTrackId && trackOptions.length > 0) {
      setModifyTrackId(trackOptions[0].id);
    }
  }, [modifyTrackId, trackOptions]);

  useEffect(() => {
    if (globalTrackPick) {
      setModifyTrackId(globalTrackPick);
    }
  }, [globalTrackPick]);

  const globalTrackSessions = useMemo(() => {
    if (!globalTrack?.trackId || !globalTrack?.prefix) return [];

    const sectionSet = new Set((globalTrack.sections || []).map((s) => String(s).trim().toUpperCase()));
    const prefixUpper = globalTrack.prefix.toUpperCase();
    const trackId = globalTrack.trackId;
    const trackOverrideMap = trackOverrides[trackId] || {};
    const out = [];

    for (const course of courses) {
      for (const raw of course.sessions) {
        const gName = String(raw.GroupName || "").trim().toUpperCase();
        const matchesLecture = isLecture(raw.Type) && gName === prefixUpper;
        const matchesSubgroup = isSubgroup(raw.Type) && sectionSet.has(gName);
        if (!matchesLecture && !matchesSubgroup) continue;

        const adjusted = applyTrackSpecificAdjustments(raw, course.id, trackById.get(trackId), trackOverrideMap);
        const { session, isModified, modifiedReason, key } = adjusted;

        out.push({
          ...session,
          courseId: course.id,
          courseName: course.name,
          source: "track",
          isModified,
          modifiedReason,
          trackSessionKey: key,
        });
      }
    }

    return out;
  }, [globalTrack, courses, trackOverrides, trackById]);

  const tableSessions = useMemo(() => {
    const all = [...registeredSessions, ...globalTrackSessions, ...previewSessions];
    const seen = new Set();
    const output = [];

    for (const s of all) {
      let normalized = applyStaffPreset(s);
      let isModified = Boolean(s.isModified);
      let modifiedReason = s.modifiedReason || "";

      if (s.source !== "track") {
        const globalKey = sessionKeyForTrack(normalized.courseId || "", normalized);
        const globalOverride = globalOverridesMap[globalKey];
        if (globalOverride) {
          normalized = {
            ...normalized,
            Staff: globalOverride.Staff ?? normalized.Staff,
            Time: globalOverride.Time ?? normalized.Time,
          };
          isModified = true;
          modifiedReason = "Synced from modified track";
        }
      }

      if (shouldSyncWithModified && s.source !== "track") {
        const adjusted = applyTrackSpecificAdjustments(
          normalized,
          normalized.courseId || "",
          activeTrackOption,
          activeTrackOverrideMap
        );
        normalized = adjusted.session;
        if (adjusted.isModified) {
          isModified = true;
          modifiedReason = adjusted.modifiedReason;
        }
      }

      normalized = { ...normalized, isModified, modifiedReason };
      const key = `${normalized.courseId || normalized.courseName}|${normalized.GroupId}|${normalized.DayWeek}|${normalized.Time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
    }

    return output;
  }, [
    registeredSessions,
    globalTrackSessions,
    previewSessions,
    globalOverridesMap,
    shouldSyncWithModified,
    activeTrackOption,
    activeTrackOverrideMap,
  ]);
  const registeredCount = registrations.length;
  const activePreviewCount =
    Object.values(preview).filter((p) => p?.lectures || p?.subgroups).length + (globalTrack ? 1 : 0);
  const hasAllPreviewMode = Object.values(preview).some((p) => p?.lectures || p?.subgroups);
  const scoreEnabled = !hasAllPreviewMode && courses.length > 0;
  const hasBuiltSchedule = tableSessions.length > 0 || Boolean(globalTrackPick);

  const printTitle = useMemo(() => {
    if (globalTrack?.selectedSubgroup) {
      return `${globalTrack.selectedSubgroup} Schedule`;
    }
    if (selectedCourse?.name) {
      return `${selectedCourse.name} Sections`;
    }
    return "Weekly Schedule";
  }, [globalTrack, selectedCourse]);

  const currentTrackLabel = useMemo(() => {
    if (globalTrack?.selectedSubgroup) return globalTrack.selectedSubgroup;
    if (!globalTrackPick) return "";
    return trackById.get(globalTrackPick)?.label || "";
  }, [globalTrack, globalTrackPick, trackById]);

  function displayGroupNameInCard(session) {
    if (!isSubgroup(session?.Type)) return session?.GroupName;
    if (session?.source === "preview") return pairedSectionLabel(session?.GroupName);
    if (!globalTrackPick) return session?.GroupName;
    return pairedSectionLabel(session?.GroupName);
  }

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
      if ((startMin ?? -1) >= LATE_THRESHOLD_MINUTES) {
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
    const conflictCount = countSessionConflicts(sessions);
    const scoreDays = Math.max(0, 100 - Math.max(0, activeDays - 1) * 18);
    const scoreGaps = Math.max(0, 100 - gapSlots * 10);
    const scoreLate = Math.max(0, 100 - after4Sessions * 24);
    const scoreConflict = Math.max(0, 100 - conflictCount * 40);
    const overall = Math.round(scoreDays * 0.34 + scoreGaps * 0.3 + scoreLate * 0.2 + scoreConflict * 0.16);

    return {
      activeDays,
      gapSlots,
      after4Sessions,
      conflictCount,
      scoreDays,
      scoreGaps,
      scoreLate,
      scoreConflict,
      overall,
    };
  }

  const currentScheduleScore = useMemo(() => evaluateSchedule(tableSessions), [tableSessions]);

  const allTrackCandidates = useMemo(() => {
    if (!scoreEnabled) return [];
    const candidates = [];

    for (const track of baseTrackOptions) {
      const prefixUpper = track.prefix.toUpperCase();
      const sectionSet = new Set(track.sections.map((s) => String(s).trim().toUpperCase()));
      const trackSessions = [];

      for (const course of courses) {
        for (const session of course.sessions) {
          const gName = String(session.GroupName || "").trim().toUpperCase();
          if (isLecture(session.Type) && gName === prefixUpper) {
            trackSessions.push({ ...session, courseId: course.id, courseName: course.name, source: "track" });
          }
          if (isSubgroup(session.Type) && sectionSet.has(gName)) {
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
        id: track.id,
        name: track.label,
        prefix: track.prefix,
        score: evaluateSchedule(merged),
      });
    }

    return candidates;
  }, [scoreEnabled, baseTrackOptions, courses, registeredSessions]);

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

  const currentDamageScore = useMemo(() => {
    return (
      currentScheduleScore.conflictCount * 1200 +
      currentScheduleScore.gapSlots * 18 +
      currentScheduleScore.after4Sessions * 28 +
      currentScheduleScore.activeDays * 4
    );
  }, [currentScheduleScore]);

  function generateDamagePlans() {
    if (!registeredCourseAlternatives.length) {
      setDamagePlans([]);
      showNotice("info", "Damage Planner", "Register at least one course first.");
      return;
    }

    const coursesToPlan = registeredCourseAlternatives.map((item) => {
      const lockKey = plannerLocks[item.courseId] || "";
      const lockMatch = item.combos.find((combo) => combo.key === lockKey);
      const allowChange = plannerChangeFlags[item.courseId] !== false;

      const filtered = lockMatch ? [lockMatch] : item.combos;
      const choices = filtered.map((combo) => ({
        ...combo,
        changeCost: combo.key === item.currentKey ? 0 : 1,
      }));

      return {
        ...item,
        allowChange,
        choices,
      };
    });

    const ordered = [...coursesToPlan].sort((a, b) => a.choices.length - b.choices.length);
    const pool = [];
    let explored = 0;

    const dfs = (index, selectedChoices, changeCount) => {
      if (explored >= MAX_PLAN_SEARCH_LIMIT) return;
      if (changeCount > plannerMaxChanges) return;

      if (index >= ordered.length) {
        explored += 1;

        const nextRegistrations = registrations.map((reg) => {
          const picked = selectedChoices.get(reg.courseId);
          if (!picked) return reg;
          return {
            ...reg,
            selectedGroupIds: picked.groupIds,
          };
        });

        const sessions = flattenSessions(coursesById, nextRegistrations);
        const score = evaluateSchedule(sessions);
        const damage =
          score.conflictCount * 1200 + score.gapSlots * 18 + score.after4Sessions * 28 + score.activeDays * 4;

        const changed = [];
        for (const course of coursesToPlan) {
          const nextChoice = selectedChoices.get(course.courseId);
          if (!nextChoice || nextChoice.key === course.currentKey) continue;
          const currentChoice = course.combos.find((combo) => combo.key === course.currentKey);
          changed.push({
            courseId: course.courseId,
            courseName: course.courseName,
            from: currentChoice?.label || "Current",
            to: nextChoice.label,
          });
        }

        pool.push({
          id: `plan-${pool.length + 1}`,
          changes: changed,
          changeCount: changed.length,
          nextRegistrations,
          score,
          damage,
          improves: damage < currentDamageScore,
        });
        return;
      }

      const course = ordered[index];
      for (const choice of course.choices) {
        if (!course.allowChange && choice.key !== course.currentKey) continue;
        selectedChoices.set(course.courseId, choice);
        dfs(index + 1, selectedChoices, changeCount + choice.changeCost);
        selectedChoices.delete(course.courseId);
      }
    };

    dfs(0, new Map(), 0);

    const ranked = pool
      .sort((a, b) => {
        if (a.damage !== b.damage) return a.damage - b.damage;
        if (a.changeCount !== b.changeCount) return a.changeCount - b.changeCount;
        return b.score.overall - a.score.overall;
      })
      .slice(0, 8);

    setDamagePlans(ranked);
    setShowDamagePlanner(true);
    if (!ranked.length) {
      showNotice("info", "Damage Planner", "No valid plan found with current limits.");
      return;
    }

    const improved = ranked.filter((plan) => plan.improves).length;
    showNotice(
      "success",
      "Damage Planner",
      improved
        ? `Found ${improved} improving plans. Fewer changes are prioritized.`
        : "Plans generated, but no plan improved the current damage score."
    );
  }

  function applyDamagePlan(planId) {
    const plan = damagePlans.find((item) => item.id === planId);
    if (!plan) return;
    setRegistrations(plan.nextRegistrations);
    setPreview({});
    showNotice("success", "Plan Applied", `Applied plan with ${plan.changeCount} change(s).`);
  }

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
    setGlobalTrackPick("");
    setDamagePlans([]);
    setPlannerLocks({});
    setPlannerChangeFlags({});
    setTrackOverrides({});
    setCustomTrackOptions([]);
    setRemovedModifiedTrackIds([]);
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
    const selectedId = String((selectedValue ?? globalTrackPick) || "").trim();
    if (!selectedId) {
      setGlobalTrack(null);
      return;
    }

    const selectedTrack = trackById.get(selectedId);
    if (!selectedTrack?.prefix) {
      showNotice("error", "Section Track", "Could not detect section prefix from group name.");
      return;
    }

    setGlobalTrack({
      trackId: selectedTrack.id,
      section: selectedTrack.label,
      prefix: selectedTrack.prefix,
      sections: selectedTrack.sections,
      selectedSubgroup: selectedTrack.label,
      isModified: Boolean(selectedTrack.isModified),
    });
    setPreview({});
  }

  function applyRankedTrack(name) {
    const selected = baseTrackOptions.find((track) => track.label === name);
    if (!selected) return;
    setGlobalTrackPick(selected.id);
    applyGlobalSectionTrack(selected.id);
  }

  const modifyTargetTrack = trackById.get(modifyTrackId);
  const modifyTrackOverrides = modifyTargetTrack ? trackOverrides[modifyTargetTrack.id] || {} : {};
  const modifyTrackHasChanges = Boolean(
    modifyTargetTrack && (modifyTargetTrack.isModified || Object.keys(modifyTrackOverrides).length)
  );
  const modifyTrackIsRemovable = Boolean(modifyTargetTrack?.isModified);

  const editableTrackSessions = useMemo(() => {
    if (!modifyTargetTrack) return [];
    const prefixUpper = modifyTargetTrack.prefix.toUpperCase();
    const sectionSet = new Set(modifyTargetTrack.sections.map((s) => String(s).trim().toUpperCase()));
    const out = [];

    for (const course of courses) {
      for (const raw of course.sessions) {
        const gName = String(raw.GroupName || "").trim().toUpperCase();
        const matchesLecture = isLecture(raw.Type) && gName === prefixUpper;
        const matchesSubgroup = isSubgroup(raw.Type) && sectionSet.has(gName);
        if (!matchesLecture && !matchesSubgroup) continue;
        out.push({
          ...raw,
          courseId: course.id,
          courseName: course.name,
          sessionKey: sessionKeyForTrack(course.id, raw),
        });
      }
    }

    out.sort((a, b) => {
      const dayOrder = DAYS.indexOf(normalizeDay(a)) - DAYS.indexOf(normalizeDay(b));
      if (dayOrder !== 0) return dayOrder;
      return String(a.courseName || "").localeCompare(String(b.courseName || ""));
    });
    return out;
  }, [modifyTargetTrack, courses]);

  const editableSessionOptions = useMemo(() => {
    const map = new Map();
    for (const session of editableTrackSessions) {
      const day = normalizeDay(session);
      const time = session.Time;
      const courseId = session.courseId;
      const courseName = session.courseName;
      const isSub = isSubgroup(session.Type);
      const groupLabel = isSub ? pairedSectionLabel(session.GroupName) : String(session.GroupName || "").trim();
      const key = isSub
        ? `pair|${courseId}|${groupLabel}|${day}|${time}|${session.NameEn || ""}`
        : `single|${session.sessionKey}`;

      if (!map.has(key)) {
        map.set(key, {
          key,
          label: `${courseName} | ${groupLabel} | ${day} | ${formatSessionTimeLabel(time, timeFormat)}`,
          targetKeys: [],
          sample: session,
          dayIndex: DAYS.indexOf(day),
          courseName,
        });
      }
      const option = map.get(key);
      if (!option.targetKeys.includes(session.sessionKey)) {
        option.targetKeys.push(session.sessionKey);
      }
    }

    const out = Array.from(map.values());
    out.sort((a, b) => {
      const byDay = a.dayIndex - b.dayIndex;
      if (byDay !== 0) return byDay;
      return a.courseName.localeCompare(b.courseName);
    });
    return out;
  }, [editableTrackSessions, timeFormat]);

  const selectedEditableOption = useMemo(
    () => editableSessionOptions.find((option) => option.key === modifySessionKey) || null,
    [editableSessionOptions, modifySessionKey]
  );
  const selectedEditableSession = selectedEditableOption?.sample || null;

  function applyTrackModification() {
    if (!modifyTargetTrack) {
      showNotice("error", "Modify", "Select a section track first.");
      return;
    }
    if (!selectedEditableSession) {
      showNotice("error", "Modify", "Select a session to modify.");
      return;
    }

    let nextTime = "";
    if (modifyStartIndex !== "") {
      const start = Number(modifyStartIndex);
      if (Number.isNaN(start) || start < 0 || start >= TIME_SLOTS.length) {
        showNotice("error", "Modify", "Invalid start slot.");
        return;
      }

      const span = forcedSpanByType(selectedEditableSession.Type);
      const end = start + span - 1;
      if (end >= TIME_SLOTS.length) {
        showNotice("error", "Modify", "Selected slot does not fit this session duration.");
        return;
      }

      const startText = toSecondsHHMM(TIME_SLOTS[start].split("-")[0].trim());
      const endText = toSecondsHHMM(TIME_SLOTS[end].split("-")[1].trim());
      nextTime = `${startText} - ${endText}`;
    }

    const payload = {};
    if (modifyStaff.trim()) payload.Staff = modifyStaff.trim();
    if (nextTime) payload.Time = nextTime;
    if (modifyDay) {
      payload.DayWeekName = modifyDay;
      payload.DayWeek = DAY_WEEK_BY_NAME[modifyDay] ?? selectedEditableSession.DayWeek;
    }
    if (!Object.keys(payload).length) {
      showNotice("error", "Modify", "Enter a new staff name, choose a new day, or choose a new start time.");
      return;
    }

    const targetKeys = selectedEditableOption?.targetKeys || [];
    if (!targetKeys.length) {
      showNotice("error", "Modify", "Select a valid session option.");
      return;
    }

    if (modifyMode === "new") {
      const existingLabels = new Set(trackOptions.map((track) => track.label));
      const label = buildAutoModifiedLabel(modifyTargetTrack.label, existingLabels);
      const id = `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;

      setCustomTrackOptions((prev) => [
        ...prev,
        {
          id,
          label,
          prefix: modifyTargetTrack.prefix,
          sections: [...modifyTargetTrack.sections],
          isModified: true,
          mode: "modified",
          baseTrackId: modifyTargetTrack.id,
        },
      ]);

      setTrackOverrides((prev) => ({
        ...prev,
        [id]: {
          ...(prev[modifyTargetTrack.id] || {}),
          ...Object.fromEntries(targetKeys.map((key) => [key, payload])),
        },
      }));

      setGlobalTrackPick(id);
      setGlobalTrack({
        trackId: id,
        section: label,
        prefix: modifyTargetTrack.prefix,
        sections: [...modifyTargetTrack.sections],
        selectedSubgroup: label,
        isModified: true,
      });
      showNotice("success", "Modify", `${label} created successfully.`);
    } else {
      setTrackOverrides((prev) => ({
        ...prev,
        [modifyTargetTrack.id]: {
          ...(prev[modifyTargetTrack.id] || {}),
          ...Object.fromEntries(
            targetKeys.map((key) => [key, { ...(prev[modifyTargetTrack.id]?.[key] || {}), ...payload }])
          ),
        },
      }));
      if (globalTrackPick === modifyTargetTrack.id) {
        applyGlobalSectionTrack(modifyTargetTrack.id);
      }
      showNotice("success", "Modify", `${modifyTargetTrack.label} updated successfully.`);
    }

    setModifySessionKey("");
    setModifyStaff("");
    setModifyStartIndex("");
    setModifyDay("");
  }

  function revertTrackChanges() {
    if (!modifyTargetTrack) return;

    setTrackOverrides((prev) => {
      const next = { ...prev };
      delete next[modifyTargetTrack.id];
      return next;
    });

    if (modifyTargetTrack.id === PRESET_C1_MODIFIED_ID && modifyTargetTrack.baseTrackId) {
      setGlobalTrackPick(modifyTargetTrack.baseTrackId);
      applyGlobalSectionTrack(modifyTargetTrack.baseTrackId);
    } else if (globalTrackPick === modifyTargetTrack.id) {
      applyGlobalSectionTrack(modifyTargetTrack.id);
    }

    showNotice("info", "Reverted", `${modifyTargetTrack.label} changes were reverted.`);
  }

  function removeModifiedTrack() {
    if (!modifyTargetTrack?.isModified) return;

    const fallbackTrackId = modifyTargetTrack.baseTrackId || "";
    setTrackOverrides((prev) => {
      const next = { ...prev };
      delete next[modifyTargetTrack.id];
      return next;
    });

    if (modifyTargetTrack.id.startsWith("custom-")) {
      setCustomTrackOptions((prev) => prev.filter((track) => track.id !== modifyTargetTrack.id));
    }
    setRemovedModifiedTrackIds((prev) =>
      prev.includes(modifyTargetTrack.id) ? prev : [...prev, modifyTargetTrack.id]
    );

    if (globalTrackPick === modifyTargetTrack.id) {
      setGlobalTrackPick(fallbackTrackId);
      applyGlobalSectionTrack(fallbackTrackId);
      if (!fallbackTrackId) {
        setGlobalTrack(null);
      }
    }

    if (modifyTrackId === modifyTargetTrack.id) {
      setModifyTrackId(fallbackTrackId);
    }

    showNotice("info", "Removed", `${modifyTargetTrack.label} was removed.`);
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
                  <option value="">Section Track (Merged + Modified)</option>
                  {trackOptions.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.label}
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
              <button
                className={`btn secondary ${showModifyPanel ? "on" : ""}`}
                type="button"
                onClick={() =>
                  setShowModifyPanel((v) => {
                    const next = !v;
                    if (next && globalTrackPick) {
                      setModifyTrackId(globalTrackPick);
                    }
                    return next;
                  })
                }
              >
                Modify
              </button>
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
          {showModifyPanel && (
            <div className="modify-panel">
              <div className="modify-row">
                <label htmlFor="modify-track">Track</label>
                <select
                  id="modify-track"
                  className="track-select"
                  value={modifyTrackId}
                  onChange={(e) => {
                    setModifyTrackId(e.target.value);
                    setModifySessionKey("");
                  }}
                >
                  <option value="">Select Track</option>
                  {trackOptions.map((track) => (
                    <option key={`modify-track-${track.id}`} value={track.id}>
                      {track.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="modify-row mode">
                <button
                  type="button"
                  className={`mini ${modifyMode === "regular" ? "on" : ""}`}
                  onClick={() => setModifyMode("regular")}
                >
                  Modify Same Track
                </button>
                <button
                  type="button"
                  className={`mini ${modifyMode === "new" ? "on" : ""}`}
                  onClick={() => setModifyMode("new")}
                >
                  Create Modified Copy
                </button>
              </div>

              <div className="modify-row">
                <label htmlFor="modify-session">Session</label>
                <select
                  id="modify-session"
                  className="track-select"
                  value={modifySessionKey}
                  onChange={(e) => setModifySessionKey(e.target.value)}
                >
                  <option value="">Select Session</option>
                  {editableSessionOptions.map((option) => (
                    <option key={`editable-${option.key}`} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="modify-grid">
                <div className="modify-row">
                  <label htmlFor="modify-staff">Staff Name</label>
                  <input
                    id="modify-staff"
                    type="text"
                    value={modifyStaff}
                    onChange={(e) => setModifyStaff(e.target.value)}
                    placeholder={selectedEditableSession?.Staff || "New staff name"}
                  />
                </div>
                <div className="modify-row">
                  <label htmlFor="modify-day">New Day</label>
                  <select
                    id="modify-day"
                    className="track-select"
                    value={modifyDay}
                    onChange={(e) => setModifyDay(e.target.value)}
                  >
                    <option value="">Keep current</option>
                    {DAYS.map((day) => (
                      <option key={`modify-day-${day}`} value={day}>
                        {day}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="modify-row">
                  <label htmlFor="modify-time">New Start Slot</label>
                  <select
                    id="modify-time"
                    className="track-select"
                    value={modifyStartIndex}
                    onChange={(e) => setModifyStartIndex(e.target.value)}
                  >
                    <option value="">Keep current</option>
                    {TIME_SLOTS.map((slot, idx) => {
                      const span = forcedSpanByType(selectedEditableSession?.Type || "Group");
                      if (idx + span > TIME_SLOTS.length) return null;
                      return (
                        <option key={`modify-slot-${slot}`} value={idx}>
                          {formatSlotLabel(slot, timeFormat)}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <div className="modify-row actions">
                <button type="button" className="btn" onClick={applyTrackModification}>
                  Apply Modify
                </button>
                {modifyTrackHasChanges && (
                  <button type="button" className="btn secondary" onClick={revertTrackChanges}>
                    Revert Changes
                  </button>
                )}
                {modifyTrackIsRemovable && (
                  <button type="button" className="mini danger" onClick={removeModifiedTrack}>
                    Remove Modified
                  </button>
                )}
              </div>
            </div>
          )}
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
                          } ${s.isModified ? "modified" : ""} ${
                            globalTrack?.isModified && s.source === "track" ? "modified-track" : ""
                          }`}
                          style={{ gridColumn: `${range.start + 1} / span ${forcedSpanByType(s.Type)}` }}
                          title={`${s.courseName} | ${displayGroupNameInCard(s)} | ${s.Time}${
                            s.isModified ? ` | ${s.modifiedReason || "Modified"}` : ""
                          }`}
                        >
                          <div className="lesson-content">
                            {s.isModified && <div className="modified-tag">Modified</div>}
                            <div>
                              <strong>Course:</strong> {s.courseName}
                            </div>
                            <div>
                              <strong>{groupLabelByType(s.Type)}:</strong> {displayGroupNameInCard(s)}
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
              <button className="mini" type="button" onClick={generateDamagePlans}>
                Suggest Low-Damage Plans
              </button>
              <button className="mini" type="button" onClick={() => setShowPlannerManual((v) => !v)}>
                {showPlannerManual ? "Hide Section Picker" : "Section Picker"}
              </button>
            </div>

            {showAnalytics && (
              <>
                <div className="planner-controls">
                  <label htmlFor="planner-max-changes">Max changes</label>
                  <select
                    id="planner-max-changes"
                    className="track-select"
                    value={plannerMaxChanges}
                    onChange={(e) => setPlannerMaxChanges(Number(e.target.value) || 1)}
                  >
                    <option value={1}>1 change</option>
                    <option value={2}>2 changes</option>
                    <option value={3}>3 changes</option>
                  </select>
                </div>

                {showPlannerManual && registeredCourseAlternatives.length > 0 && (
                  <div className="planner-manual-panel">
                    <h3>Optional Section Picker</h3>
                    <div className="planner-manual-list">
                      {registeredCourseAlternatives.map((course) => (
                        <article key={`planner-course-${course.courseId}`} className="planner-manual-item">
                          <div className="planner-manual-head">
                            <strong>{course.courseName}</strong>
                            <label>
                              <input
                                type="checkbox"
                                checked={plannerChangeFlags[course.courseId] !== false}
                                onChange={(e) =>
                                  setPlannerChangeFlags((prev) => ({
                                    ...prev,
                                    [course.courseId]: e.target.checked,
                                  }))
                                }
                              />{" "}
                              Allow change
                            </label>
                          </div>
                          <select
                            className="track-select"
                            value={plannerLocks[course.courseId] || ""}
                            onChange={(e) =>
                              setPlannerLocks((prev) => ({
                                ...prev,
                                [course.courseId]: e.target.value,
                              }))
                            }
                          >
                            <option value="">Auto (any available)</option>
                            {course.combos.map((combo) => (
                              <option key={`planner-lock-${course.courseId}-${combo.key}`} value={combo.key}>
                                {combo.label}
                              </option>
                            ))}
                          </select>
                        </article>
                      ))}
                    </div>
                  </div>
                )}

                {showDamagePlanner && damagePlans.length > 0 && (
                  <div className="planner-results">
                    <h3>Low-Damage Plan Suggestions</h3>
                    <div className="planner-result-list">
                      {damagePlans.map((plan) => (
                        <article key={plan.id} className={`planner-result-item ${plan.improves ? "improves" : ""}`}>
                          <div className="planner-result-head">
                            <strong>
                              {plan.improves ? "Improves current schedule" : "Fallback plan"} | {plan.changeCount} change(s)
                            </strong>
                            <button className="mini" type="button" onClick={() => applyDamagePlan(plan.id)}>
                              Apply Plan
                            </button>
                          </div>
                          <p className="planner-score-line">
                            Score {plan.score.overall} | Days {plan.score.activeDays} | Gaps {plan.score.gapSlots} |
                            After 4:15 {plan.score.after4Sessions} | Conflicts {plan.score.conflictCount}
                          </p>
                          {plan.changes.length > 0 ? (
                            <ul className="planner-change-list">
                              {plan.changes.map((change) => (
                                <li key={`${plan.id}-${change.courseId}`}>
                                  <strong>{change.courseName}</strong>: {change.from} {"->"} {change.to}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted score-line">No change needed for this plan.</p>
                          )}
                        </article>
                      ))}
                    </div>
                  </div>
                )}

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
                      <h3>{currentTrackLabel ? `${currentTrackLabel} Analytics` : "Current Schedule Analytics"}</h3>
                    </div>
                    <div className="metric-badges">
                      <span className="metric-badge overall">Score {currentScheduleScore.overall}/100</span>
                      <span className="metric-badge days">Days {currentScheduleScore.activeDays}</span>
                      <span className="metric-badge gaps">Gaps {currentScheduleScore.gapSlots}</span>
                      <span className="metric-badge late">After 4:15 PM {currentScheduleScore.after4Sessions}</span>
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
                        <option value="late">No Sessions After 4:15 PM</option>
                      </select>
                    </div>
                    <div className="ranked-tracks">
                      {rankedTrackCandidates.slice(0, 10).map((c) => (
                        <button
                          key={`rank-${c.id}`}
                          type="button"
                          className={`rank-item ${globalTrackPick === c.id ? "active" : ""}`}
                          onClick={() => applyRankedTrack(c.name)}
                        >
                          <span>{c.name}</span>
                          <small>
                            Score {c.score.overall} | Days {c.score.activeDays} | Gaps {c.score.gapSlots} | After 4:15:{" "}
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
                      {currentTrackLabel ? ` for ${currentTrackLabel}` : ""}
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
