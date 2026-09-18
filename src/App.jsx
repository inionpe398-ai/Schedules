import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadCourses } from "./lib/data";
import {
  extractLecturePrefix,
  extractSectionPrefix,
  groupTrackKey,
  lectureMatchesSection,
  pairedSectionLabel,
  parseSectionGroupName,
} from "./lib/groupIdentity";
import {
  DAYS,
  TIME_SLOTS,
  buildTimeSlots,
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
const REGISTER_PRESETS_KEY = "scheduleRegisterPresetsV1";
const SHARED_TRACK_OVERRIDES_KEY = "scheduleSharedTrackOverridesV1";
const CUSTOM_TRACK_OPTIONS_KEY = "scheduleCustomTrackOptionsV1";
const TRACK_OVERRIDES_KEY = "scheduleTrackOverridesV1";
const REMOVED_MODIFIED_TRACK_IDS_KEY = "scheduleRemovedModifiedTrackIdsV1";
const LATE_THRESHOLD_MINUTES = 16 * 60 + 15;
const MAX_PLAN_SEARCH_LIMIT = 20000;
const LEVEL_ONE_SECTION_PRESET_COURSES = new Set([
  "DEN 1101", "DEN 1103", "DEN 1104", "DEN 1106", "DEN 1108", "DEN 1201", "DEN 1202",
]);
const DAY_WEEK_BY_NAME = {
  Sunday: 1,
  Monday: 2,
  Tuesday: 3,
  Wednesday: 4,
  Thursday: 5,
  Friday: 6,
  Saturday: 7,
};

const TIME_PROFILES = {
  regular: {
    id: "regular",
    label: "Regular (45m, 08:45-22:30)",
    slots: TIME_SLOTS,
  },
  ramadan: {
    id: "ramadan",
    label: "Ramadan (30m, 09:00-21:30)",
    slots: buildTimeSlots(9, 0, 21, 30, 30),
  },
};

function sanitizeRegisterPresets(raw, courses) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(courses.map((c) => c.id));
  return raw
    .filter((item) => item && typeof item.name === "string")
    .map((item) => {
      const selections = Array.isArray(item.selections) ? item.selections : [];
      return {
        id: String(item.id || `preset-${Date.now()}`),
        name: item.name.trim() || "Unnamed Preset",
        selections: selections.filter(
          (r) =>
            r &&
            ids.has(r.courseId) &&
            Array.isArray(r.selectedGroupIds) &&
            r.selectedGroupIds.length > 0
        ),
      };
    })
    .filter((item) => item.selections.length > 0);
}

function sanitizeCustomTrackOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const sections = Array.isArray(item?.sections)
        ? item.sections.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      if (!sections.length) return null;

      const id = String(item?.id || "").trim();
      const label = String(item?.label || "").trim();
      const prefix = String(item?.prefix || "").trim().toUpperCase();
      if (!id || !label || !prefix) return null;

      return {
        id,
        label,
        prefix,
        sections,
        isModified: item?.isModified !== false,
        mode: "modified",
        baseTrackId: String(item?.baseTrackId || "").trim() || undefined,
      };
    })
    .filter(Boolean);
}

function sanitizeTrackOverrides(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};

  for (const [trackId, rawMap] of Object.entries(raw)) {
    if (!rawMap || typeof rawMap !== "object") continue;
    const cleanMap = {};
    for (const [sessionKey, payload] of Object.entries(rawMap)) {
      if (!payload || typeof payload !== "object") continue;
      const cleanPayload = {};
      if (typeof payload.Staff === "string") cleanPayload.Staff = payload.Staff.trim();
      if (typeof payload.Time === "string") cleanPayload.Time = payload.Time.trim();
      if (typeof payload.DayWeekName === "string") cleanPayload.DayWeekName = payload.DayWeekName.trim();
      if (payload.DayWeek != null && Number.isFinite(Number(payload.DayWeek))) {
        cleanPayload.DayWeek = Number(payload.DayWeek);
      }
      if (Object.keys(cleanPayload).length) cleanMap[sessionKey] = cleanPayload;
    }
    if (Object.keys(cleanMap).length) out[trackId] = cleanMap;
  }

  return out;
}

function sanitizeRemovedModifiedTrackIds(raw) {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((id) => String(id || "").trim()).filter(Boolean)));
}

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

function normalizedCourseCode(course) {
  return String(course?.code || course?.id || "").trim().toUpperCase().replace(/\s+/g, " ");
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

      const label = `${prefix}${pairStart}/${prefix}${pairStart + 1}`;
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

function findConflict(candidate, existing, slots = TIME_SLOTS) {
  for (const a of candidate) {
    const dayA = normalizeDay(a);
    const rangeA = slotRange(a, slots);
    if (!DAYS.includes(dayA) || !rangeA) continue;

    for (const b of existing) {
      const dayB = normalizeDay(b);
      const rangeB = slotRange(b, slots);
      if (dayA !== dayB || !rangeB) continue;

      if (rangesOverlap(rangeA, rangeB)) {
        return {
          day: dayA,
          existing: b,
          overlap: overlapLabel(rangeA, rangeB, slots),
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

function sessionsOverlap(a, b, slots = TIME_SLOTS) {
  const dayA = normalizeDay(a);
  const dayB = normalizeDay(b);
  if (dayA !== dayB) return false;
  const rangeA = slotRange(a, slots);
  const rangeB = slotRange(b, slots);
  if (!rangeA || !rangeB) return false;
  return rangesOverlap(rangeA, rangeB);
}

function countSessionConflicts(sessions, slots = TIME_SLOTS) {
  let total = 0;
  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      if (sessionsOverlap(sessions[i], sessions[j], slots)) total += 1;
    }
  }
  return total;
}

function sessionVerticalMergeSignature(session) {
  return [
    session.courseId || session.courseName || "",
    session.courseName || "",
    session.Time || "",
    session.GroupName || "",
    session.ClassRoomName || "",
    session.Staff || "",
    session.Type || "",
    session.isModified ? "1" : "0",
  ].join("|");
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
  const [timeProfile, setTimeProfile] = useState("regular");
  const [registerPresets, setRegisterPresets] = useState([]);
  const [selectedRegisterPresetId, setSelectedRegisterPresetId] = useState("");
  const [dayExplorer, setDayExplorer] = useState("all");
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [analyticsMode, setAnalyticsMode] = useState("regular");
  const [irregularScheduleCandidates, setIrregularScheduleCandidates] = useState([]);
  const [isGeneratingIrregular, setIsGeneratingIrregular] = useState(false);
  const [rankingCriterion, setRankingCriterion] = useState("balanced");
  const [recommendSearch, setRecommendSearch] = useState("");
  const [recommendTypeFilter, setRecommendTypeFilter] = useState("all");
  const [recommendDayFilter, setRecommendDayFilter] = useState("all");
  const [showPlannerModal, setShowPlannerModal] = useState(false);
  const [plannerModalTab, setPlannerModalTab] = useState("panel");
  const [showPlannerManual, setShowPlannerManual] = useState(false);
  const [plannerPreviewPlanId, setPlannerPreviewPlanId] = useState("");
  const [plannerMaxChanges, setPlannerMaxChanges] = useState(2);
  const [plannerLocks, setPlannerLocks] = useState({});
  const [plannerChangeFlags, setPlannerChangeFlags] = useState({});
  const [damagePlans, setDamagePlans] = useState([]);
  const [customTrackOptions, setCustomTrackOptions] = useState([]);
  const [trackOverrides, setTrackOverrides] = useState({});
  const [sharedTrackOverrides, setSharedTrackOverrides] = useState({});
  const [removedModifiedTrackIds, setRemovedModifiedTrackIds] = useState([]);
  const [isHydrated, setIsHydrated] = useState(false);
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
  const allPdfAutoStartedRef = useRef(false);

  const coursesById = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const isLevelOne = new URLSearchParams(window.location.search).get("level") === "1";
  const sectionPresetCourses = useMemo(
    () => (isLevelOne ? courses.filter((course) => LEVEL_ONE_SECTION_PRESET_COURSES.has(normalizedCourseCode(course))) : courses),
    [courses, isLevelOne]
  );
  const currentTimeSlots = useMemo(() => {
    const profile = TIME_PROFILES[timeProfile];
    return Array.isArray(profile?.slots) && profile.slots.length ? profile.slots : TIME_SLOTS;
  }, [timeProfile]);

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

        let rawPresets = [];
        try {
          const savedPresets = localStorage.getItem(REGISTER_PRESETS_KEY);
          rawPresets = savedPresets ? JSON.parse(savedPresets) : [];
        } catch {
          rawPresets = [];
        }
        setRegisterPresets(sanitizeRegisterPresets(rawPresets, loaded));

        let sharedOverrides = {};
        try {
          const savedOverrides = localStorage.getItem(SHARED_TRACK_OVERRIDES_KEY);
          const parsedOverrides = savedOverrides ? JSON.parse(savedOverrides) : {};
          sharedOverrides = parsedOverrides && typeof parsedOverrides === "object" ? parsedOverrides : {};
        } catch {
          sharedOverrides = {};
        }
        setSharedTrackOverrides(sharedOverrides);

        let rawCustomTracks = [];
        try {
          const savedCustomTracks = localStorage.getItem(CUSTOM_TRACK_OPTIONS_KEY);
          rawCustomTracks = savedCustomTracks ? JSON.parse(savedCustomTracks) : [];
        } catch {
          rawCustomTracks = [];
        }
        setCustomTrackOptions(sanitizeCustomTrackOptions(rawCustomTracks));

        let rawTrackOverrides = {};
        try {
          const savedTrackOverrides = localStorage.getItem(TRACK_OVERRIDES_KEY);
          rawTrackOverrides = savedTrackOverrides ? JSON.parse(savedTrackOverrides) : {};
        } catch {
          rawTrackOverrides = {};
        }
        setTrackOverrides(sanitizeTrackOverrides(rawTrackOverrides));

        let rawRemovedTrackIds = [];
        try {
          const savedRemovedTrackIds = localStorage.getItem(REMOVED_MODIFIED_TRACK_IDS_KEY);
          rawRemovedTrackIds = savedRemovedTrackIds ? JSON.parse(savedRemovedTrackIds) : [];
        } catch {
          rawRemovedTrackIds = [];
        }
        const removedTrackIds = sanitizeRemovedModifiedTrackIds(rawRemovedTrackIds);
        setRemovedModifiedTrackIds(removedTrackIds);
        setIsHydrated(true);
      })
      .catch((e) => {
        setError(e.message || "Failed to load courses.");
        setIsHydrated(true);
      });
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registrations));
  }, [registrations, isHydrated]);

  useEffect(() => {
    localStorage.setItem(TIME_FORMAT_KEY, timeFormat);
  }, [timeFormat]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(REGISTER_PRESETS_KEY, JSON.stringify(registerPresets));
  }, [registerPresets, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(SHARED_TRACK_OVERRIDES_KEY, JSON.stringify(sharedTrackOverrides));
  }, [sharedTrackOverrides, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(CUSTOM_TRACK_OPTIONS_KEY, JSON.stringify(customTrackOptions));
  }, [customTrackOptions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(TRACK_OVERRIDES_KEY, JSON.stringify(trackOverrides));
  }, [trackOverrides, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(REMOVED_MODIFIED_TRACK_IDS_KEY, JSON.stringify(removedModifiedTrackIds));
  }, [removedModifiedTrackIds, isHydrated]);

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

  useEffect(() => {
    if (!selectedRegisterPresetId) return;
    if (registerPresets.some((preset) => preset.id === selectedRegisterPresetId)) return;
    setSelectedRegisterPresetId("");
  }, [registerPresets, selectedRegisterPresetId]);

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

        const matchedSections = sectionChoices.filter((section) => lectureMatchesSection(lecture.name, section.name));
        // If DULMS renamed groups in a way that carries no shared prefix, keep
        // every explicit lecture/section choice usable instead of hiding it.
        for (const section of matchedSections.length ? matchedSections : sectionChoices) {
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

  useEffect(() => {
    if (!damagePlans.length) {
      setPlannerPreviewPlanId("");
      return;
    }
    if (!plannerPreviewPlanId || !damagePlans.some((plan) => plan.id === plannerPreviewPlanId)) {
      setPlannerPreviewPlanId(damagePlans[0].id);
    }
  }, [damagePlans, plannerPreviewPlanId]);

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

  const dayExplorerSessions = useMemo(() => {
    if (dayExplorer === "all") return [];
    const out = [];
    for (const course of courses) {
      for (const session of course.sessions) {
        if (normalizeDay(session) !== dayExplorer) continue;
        out.push({
          ...session,
          courseId: course.id,
          courseName: course.name,
          source: "day-explorer",
        });
      }
    }
    return out;
  }, [courses, dayExplorer]);

  const applyStaffPreset = (session) => session;

  const subgroupNames = useMemo(() => {
    const names = new Set();
    for (const course of sectionPresetCourses) {
      for (const session of course.sessions) {
        if (isSubgroup(session.Type)) {
          const name = String(session.GroupName || "").trim();
          if (name) names.add(name);
        }
      }
    }
    return Array.from(names);
  }, [sectionPresetCourses]);

  const baseTrackOptions = useMemo(() => buildMergedTrackOptions(subgroupNames), [subgroupNames]);

  const trackOptions = useMemo(() => {
    const out = [...baseTrackOptions];
    out.push(...customTrackOptions);
    return out.filter((track) => !removedModifiedTrackIds.includes(track.id));
  }, [baseTrackOptions, customTrackOptions, removedModifiedTrackIds]);

  useEffect(() => {
    const shouldAutoExport = new URLSearchParams(window.location.search).get("export") === "all-pdf";
    if (!shouldAutoExport || !trackOptions.length || allPdfAutoStartedRef.current) return;
    allPdfAutoStartedRef.current = true;
    const timer = setTimeout(() => downloadAllLevelPdf(), 250);
    return () => clearTimeout(timer);
  }, [trackOptions]);

  const trackById = useMemo(() => new Map(trackOptions.map((track) => [track.id, track])), [trackOptions]);
  const removableModifiedTracks = useMemo(() => trackOptions.filter((track) => track.isModified), [trackOptions]);
  const activeTrackOption = useMemo(() => trackById.get(globalTrackPick) || null, [trackById, globalTrackPick]);
  const activeTrackOverrideMap = useMemo(
    () => (activeTrackOption ? trackOverrides[activeTrackOption.id] || {} : {}),
    [activeTrackOption, trackOverrides]
  );
  function applyTrackSpecificAdjustments(rawSession, courseId, track, overrideMap = {}) {
    let session = applyStaffPreset(rawSession);
    let isModified = false;
    let modifiedReason = "";

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

  useEffect(() => {
    if (selectedRegisterPresetId && modifyMode === "new") {
      setModifyMode("regular");
    }
  }, [selectedRegisterPresetId, modifyMode]);

  const globalTrackSessions = useMemo(() => {
    if (!globalTrack?.trackId || !globalTrack?.prefix) return [];

    const sectionSet = new Set((globalTrack.sections || []).map(groupTrackKey).filter(Boolean));
    const prefixUpper = globalTrack.prefix.toUpperCase();
    const trackId = globalTrack.trackId;
    const trackOverrideMap = trackOverrides[trackId] || {};
    const out = [];

    for (const course of sectionPresetCourses) {
      for (const raw of course.sessions) {
        const gName = groupTrackKey(raw.GroupName);
        const matchesLecture = isLecture(raw.Type) && extractLecturePrefix(gName) === prefixUpper;
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
  }, [globalTrack, sectionPresetCourses, trackOverrides, trackById]);

  const plannerPreviewPlan = useMemo(
    () => damagePlans.find((plan) => plan.id === plannerPreviewPlanId) || null,
    [damagePlans, plannerPreviewPlanId]
  );
  const plannerPreviewActive = showPlannerModal && plannerModalTab === "preview" && Boolean(plannerPreviewPlan);
  const plannerPreviewSessions = useMemo(() => {
    if (!plannerPreviewPlan) return [];
    return flattenSessions(coursesById, plannerPreviewPlan.nextRegistrations).map((session) => ({
      ...session,
      source: "planner-preview",
      isModified: true,
      modifiedReason: "Preview plan",
    }));
  }, [plannerPreviewPlan, coursesById]);

  const tableSessions = useMemo(() => {
    const all = plannerPreviewActive
      ? [...plannerPreviewSessions]
      : [...registeredSessions, ...globalTrackSessions, ...previewSessions, ...dayExplorerSessions];
    const seen = new Set();
    const output = [];

    for (const s of all) {
      let normalized = s;
      let isModified = Boolean(s.isModified);
      let modifiedReason = s.modifiedReason || "";

      normalized = { ...normalized, isModified, modifiedReason };
      const key = `${normalized.courseId || normalized.courseName}|${normalized.GroupId}|${normalized.DayWeek}|${normalized.Time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
    }

    return output;
  }, [
    registeredSessions,
    plannerPreviewActive,
    plannerPreviewSessions,
    globalTrackSessions,
    previewSessions,
    dayExplorerSessions,
  ]);
  const registeredCount = registrations.length;
  const activePreviewCount =
    Object.values(preview).filter((p) => p?.lectures || p?.subgroups).length +
    (globalTrack ? 1 : 0) +
    (dayExplorer !== "all" ? 1 : 0);
  const hasAllPreviewMode =
    Object.values(preview).some((p) => p?.lectures || p?.subgroups) || dayExplorer !== "all";
  const scoreEnabled = !hasAllPreviewMode && courses.length > 0;
  const hasBuiltSchedule = tableSessions.length > 0 || Boolean(globalTrackPick);

  const printTitle = useMemo(() => {
    if (dayExplorer !== "all") {
      return `${dayExplorer} · Combined Sections Schedule`;
    }
    if (globalTrack?.selectedSubgroup) {
      return `${globalTrack.selectedSubgroup} Schedule`;
    }
    if (selectedCourse?.name) {
      return `${selectedCourse.name} Sections`;
    }
    return "Weekly Schedule";
  }, [dayExplorer, globalTrack, selectedCourse]);

  const currentTrackLabel = useMemo(() => {
    if (globalTrack?.selectedSubgroup) return globalTrack.selectedSubgroup;
    if (!globalTrackPick) return "";
    return trackById.get(globalTrackPick)?.label || "";
  }, [globalTrack, globalTrackPick, trackById]);
  const visibleDays = useMemo(() => (dayExplorer === "all" ? DAYS : [dayExplorer]), [dayExplorer]);
  const daySectionRows = useMemo(() => {
    const tracks = baseTrackOptions.map((track) => {
      const firstParsed = parseSectionGroupName(track.sections[0] || "");
      return {
        id: track.id,
        label: track.label,
        prefix: track.prefix,
        sections: track.sections,
        sectionSet: new Set(track.sections.map((s) => String(s).trim().toUpperCase())),
        sortPrefix: firstParsed?.prefix || track.prefix || "",
        sortNumber: firstParsed?.number ?? 999,
      };
    });
    tracks.sort((a, b) => {
      const byPrefix = a.sortPrefix.localeCompare(b.sortPrefix);
      if (byPrefix !== 0) return byPrefix;
      if (a.sortNumber !== b.sortNumber) return a.sortNumber - b.sortNumber;
      return a.label.localeCompare(b.label, undefined, { numeric: true });
    });
    return tracks;
  }, [baseTrackOptions]);
  const dayExplorerSessionsOnly = useMemo(
    () => (dayExplorer === "all" ? [] : tableSessions.filter((s) => normalizeDay(s) === dayExplorer)),
    [tableSessions, dayExplorer]
  );
  const dayExplorerSessionMap = useMemo(() => {
    const map = new Map(daySectionRows.map((row) => [row.id, []]));
    if (dayExplorer === "all") return map;

    for (const session of dayExplorerSessionsOnly) {
      if (isSubgroup(session.Type)) {
        const g = String(session.GroupName || "").trim().toUpperCase();
        for (const row of daySectionRows) {
          if (row.sectionSet.has(g)) {
            map.get(row.id).push(session);
          }
        }
        continue;
      }

      const lecturePrefix = extractLecturePrefix(session.GroupName);
      for (const row of daySectionRows) {
        if (String(row.prefix || "").toUpperCase() === lecturePrefix) {
          map.get(row.id).push(session);
        }
      }
    }

    for (const row of daySectionRows) {
      const list = map.get(row.id) || [];
      const seenLecture = new Set();
      const compacted = [];
      for (const session of list) {
        if (isLecture(session.Type)) {
          const lectureKey = [
            session.courseId || session.courseName,
            session.Time,
            String(session.GroupName || "").trim().toUpperCase(),
            String(session.ClassRoomName || "").trim().toUpperCase(),
            String(session.Staff || "").trim().toUpperCase(),
          ].join("|");
          if (seenLecture.has(lectureKey)) continue;
          seenLecture.add(lectureKey);
        }
        compacted.push(session);
      }
      map.set(row.id, compacted);
    }

    return map;
  }, [daySectionRows, dayExplorer, dayExplorerSessionsOnly]);
  const dayExplorerTableModel = useMemo(() => {
    if (dayExplorer === "all") return null;

    const rows = daySectionRows;
    const rowCount = rows.length;
    const colCount = currentTimeSlots.length;
    const occupancy = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => null));

    for (let r = 0; r < rowCount; r += 1) {
      const sessions = dayExplorerSessionMap.get(rows[r].id) || [];
      for (const session of sessions) {
        const range = slotRange(session, currentTimeSlots);
        if (!range) continue;
        const signature = sessionVerticalMergeSignature(session);
        for (let c = range.start; c < range.end; c += 1) {
          occupancy[r][c] = {
            session,
            signature,
            colStart: range.start,
            colEnd: range.end,
          };
        }
      }
    }

    const starts = new Map();
    const covered = new Set();
    const keyOf = (r, c) => `${r}:${c}`;

    for (let r = 0; r < rowCount; r += 1) {
      for (let c = 0; c < colCount; c += 1) {
        const cell = occupancy[r][c];
        if (!cell || c !== cell.colStart) continue;
        const startKey = keyOf(r, c);
        if (covered.has(startKey)) continue;

        let rowEnd = r + 1;
        while (rowEnd < rowCount) {
          let canExtend = true;
          for (let cc = cell.colStart; cc < cell.colEnd; cc += 1) {
            const nextCell = occupancy[rowEnd][cc];
            if (!nextCell) {
              canExtend = false;
              break;
            }
            if (
              nextCell.signature !== cell.signature ||
              nextCell.colStart !== cell.colStart ||
              nextCell.colEnd !== cell.colEnd
            ) {
              canExtend = false;
              break;
            }
          }
          if (!canExtend) break;
          rowEnd += 1;
        }

        for (let rr = r; rr < rowEnd; rr += 1) {
          for (let cc = cell.colStart; cc < cell.colEnd; cc += 1) {
            covered.add(keyOf(rr, cc));
          }
        }

        starts.set(startKey, {
          session: cell.session,
          colSpan: cell.colEnd - cell.colStart,
          rowSpan: rowEnd - r,
          colStart: cell.colStart,
        });
      }
    }

    return { rows, starts, covered, colCount };
  }, [dayExplorer, daySectionRows, currentTimeSlots, dayExplorerSessionMap]);

  function displayGroupNameInCard(session) {
    if (!isSubgroup(session?.Type)) return session?.GroupName;
    if (session?.source === "preview") return pairedSectionLabel(session?.GroupName);
    if (!globalTrackPick) return session?.GroupName;
    return pairedSectionLabel(session?.GroupName);
  }

  const slotStartByIndex = useMemo(() => currentTimeSlots.map((slot) => slotStartMinutes(slot)), [currentTimeSlots]);

  const freeTimeByDay = useMemo(() => {
    const occupied = new Map(DAYS.map((d) => [d, new Set()]));
    for (const s of tableSessions) {
      const day = normalizeDay(s);
      const range = slotRange(s, currentTimeSlots);
      if (!occupied.has(day) || !range) continue;
      for (let i = range.start; i < range.end; i += 1) occupied.get(day).add(i);
    }

    const result = new Map();
    for (const day of DAYS) {
      const used = occupied.get(day) || new Set();
      if (!used.size) continue;
      const blocks = [];
      let start = null;
      for (let i = 0; i < currentTimeSlots.length; i += 1) {
        const busy = used.has(i);
        if (!busy && start == null) start = i;
        if ((busy || i === currentTimeSlots.length - 1) && start != null) {
          const endIndex = busy ? i - 1 : i;
          const startText = currentTimeSlots[start].split("-")[0].trim();
          const endText = currentTimeSlots[endIndex].split("-")[1].trim();
          blocks.push(formatSessionTimeLabel(`${startText} - ${endText}`, "12h"));
          start = null;
        }
      }
      result.set(day, blocks);
    }
    return result;
  }, [tableSessions, currentTimeSlots]);

  const recommendationItems = useMemo(() => {
    if (!tableSessions.length) return [];

    const occupied = new Map(DAYS.map((d) => [d, new Set()]));
    for (const s of tableSessions) {
      const day = normalizeDay(s);
      const range = slotRange(s, currentTimeSlots);
      if (!occupied.has(day) || !range) continue;
      for (let i = range.start; i < range.end; i += 1) occupied.get(day).add(i);
    }

    const freeRangesByDay = new Map();
    for (const day of DAYS) {
      const used = occupied.get(day) || new Set();
      if (!used.size) continue;
      const ranges = [];
      let start = null;

      for (let i = 0; i < currentTimeSlots.length; i += 1) {
        const busy = used.has(i);
        if (!busy && start == null) start = i;
        if ((busy || i === currentTimeSlots.length - 1) && start != null) {
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

        const range = slotRange(session, currentTimeSlots);
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
  }, [tableSessions, courses, currentTimeSlots]);

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
    const earlySections = new Set();
    for (const s of sessions) {
      const day = normalizeDay(s);
      const range = slotRange(s, currentTimeSlots);
      if (!occupied.has(day) || !range) continue;
      for (let i = range.start; i < range.end; i += 1) occupied.get(day).add(i);
      const startMin = slotStartByIndex[range.start];
      if ((startMin ?? -1) >= LATE_THRESHOLD_MINUTES) {
        const key = `${day}|${s.courseId || s.courseName}|${s.GroupId}|${s.Time}`;
        lateSessions.add(key);
      }
      if (isSubgroup(s.Type) && (startMin ?? Number.POSITIVE_INFINITY) < 10 * 60 + 15) {
        const key = `${day}|${s.courseId || s.courseName}|${s.GroupId}|${s.Time}`;
        earlySections.add(key);
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
    const earlySectionCount = earlySections.size;
    const conflictCount = countSessionConflicts(sessions, currentTimeSlots);
    const scoreDays = Math.max(0, 100 - Math.max(0, activeDays - 1) * 18);
    const scoreGaps = Math.max(0, 100 - gapSlots * 10);
    const scoreLate = Math.max(0, 100 - after4Sessions * 24);
    const scoreConflict = Math.max(0, 100 - conflictCount * 40);
    const overall = Math.round(scoreDays * 0.34 + scoreGaps * 0.3 + scoreLate * 0.2 + scoreConflict * 0.16);

    return {
      activeDays,
      gapSlots,
      after4Sessions,
      earlySectionCount,
      conflictCount,
      scoreDays,
      scoreGaps,
      scoreLate,
      scoreConflict,
      overall,
    };
  }

  const currentScheduleScore = useMemo(() => evaluateSchedule(tableSessions), [tableSessions, currentTimeSlots]);

  const allTrackCandidates = useMemo(() => {
    if (!scoreEnabled) return [];
    const candidates = [];

    for (const track of baseTrackOptions) {
      const prefixUpper = track.prefix.toUpperCase();
      const sectionSet = new Set(track.sections.map(groupTrackKey).filter(Boolean));
      const trackSessions = [];

      for (const course of sectionPresetCourses) {
        for (const session of course.sessions) {
          const gName = groupTrackKey(session.GroupName);
          if (isLecture(session.Type) && extractLecturePrefix(gName) === prefixUpper) {
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
  }, [scoreEnabled, baseTrackOptions, sectionPresetCourses, registeredSessions, currentTimeSlots]);

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

  async function generateIrregularSchedules() {
    if (!scoreEnabled || !courses.length || isGeneratingIrregular) return;
    setIsGeneratingIrregular(true);
    setIrregularScheduleCandidates([]);
    const courseChoices = courses.map((course) => {
      const split = groupsByCourseId.get(course.id) || { lectures: [], subgroups: [] };
      const lectures = split.lectures || [];
      const sections = split.subgroups || [];
      const options = [];

      for (const lecture of lectures) {
        const sectionChoices = sections.length ? sections : [null];
        for (const section of sectionChoices) {
          const groups = [lecture, section].filter(Boolean);
          options.push({
            groupIds: groups.map((group) => group.id),
            label: section ? `Lecture ${lecture.name} + Section ${section.name}` : `Lecture ${lecture.name}`,
            sessions: groups.flatMap((group) =>
              group.sessions.map((session) => ({
                ...session,
                courseId: course.id,
                courseName: course.name,
                source: "irregular-plan",
              }))
            ),
          });
        }
      }

      return { course, options };
    });

    if (courseChoices.some((item) => !item.options.length)) {
      setIsGeneratingIrregular(false);
      showNotice("error", "Irregular Analysis", "One or more courses have no available lecture groups.");
      return;
    }

    let beam = [{ registrations: [], sessions: [], choices: [], score: evaluateSchedule([]) }];
    const beamWidth = 120;

    for (const { course, options } of courseChoices) {
      const next = [];
      for (const partial of beam) {
        for (const option of options) {
          const sessions = [...partial.sessions, ...option.sessions];
          next.push({
            registrations: [
              ...partial.registrations,
              { courseId: course.id, selectedGroupIds: option.groupIds },
            ],
            sessions,
            choices: [...partial.choices, `${course.name}: ${option.label}`],
            score: evaluateSchedule(sessions),
          });
        }
      }
      next.sort(
        (a, b) =>
          a.score.conflictCount - b.score.conflictCount ||
          Math.abs(a.score.activeDays - 4) - Math.abs(b.score.activeDays - 4) ||
          a.score.earlySectionCount - b.score.earlySectionCount ||
          b.score.overall - a.score.overall ||
          a.score.activeDays - b.score.activeDays ||
          a.score.gapSlots - b.score.gapSlots
      );
      beam = next.slice(0, beamWidth);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const results = beam.slice(0, 10).map((candidate, index) => ({
      ...candidate,
      id: `irregular-${index + 1}`,
      name: `Irregular Plan ${index + 1}`,
    }));
    setIrregularScheduleCandidates(results);
    setIsGeneratingIrregular(false);
    showNotice("success", "Irregular Analysis", `Found ${results.length} optimized schedules.`);
  }

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
    setShowPlannerModal(true);
    setPlannerModalTab("panel");
    setPlannerPreviewPlanId((prev) => {
      if (prev && ranked.some((plan) => plan.id === prev)) return prev;
      return ranked[0]?.id || "";
    });
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
    setShowPlannerModal(false);
    setPlannerModalTab("panel");
    showNotice("success", "Plan Applied", `Applied plan with ${plan.changeCount} change(s).`);
  }

  function showNotice(type, title, message) {
    setNotice({ type, title, message });
  }

  function registerSelection(e) {
    e.preventDefault();
    if (!selectedCourse) return;

    const chosenSub = subPick ? Number(subPick) : null;
    const hasSubgroups = subgroupGroups.length > 0;

    const selectedSubgroup = chosenSub ? subgroupGroups.find((group) => group.id === chosenSub) : null;
    const linkedLecture = selectedSubgroup
      ? lectureGroups.find((group) => lectureMatchesSection(group.name, selectedSubgroup.name))
      : null;
    const chosenLecture = linkedLecture?.id || Number(lecturePick);

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
    const conflict = findConflict(candidate, existing, currentTimeSlots);

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

  function saveCurrentRegistrationPreset() {
    if (!registrations.length) {
      showNotice("error", "Register Preset", "Register at least one course before saving a preset.");
      return;
    }

    const rawName = window.prompt("Preset name");
    if (rawName == null) return;
    const name = rawName.trim();
    if (!name) {
      showNotice("error", "Register Preset", "Preset name is required.");
      return;
    }

    const id = `register-${Date.now()}`;
    const nextPreset = {
      id,
      name,
      selections: registrations.map((r) => ({
        courseId: r.courseId,
        selectedGroupIds: [...r.selectedGroupIds],
      })),
    };
    setRegisterPresets((prev) => [...prev.filter((item) => item.name !== name), nextPreset]);
    setSelectedRegisterPresetId(id);
    showNotice(
      "success",
      "Register Preset",
      `${name} saved with ${nextPreset.selections.length} registered course(s).`
    );
  }

  function applyRegisterPreset(presetId) {
    if (!presetId) {
      setSelectedRegisterPresetId("");
      return;
    }
    const preset = registerPresets.find((item) => item.id === presetId);
    if (!preset) return;
    setSelectedRegisterPresetId(preset.id);
    setRegistrations(normalizeRegistrations(courses, preset.selections));
    setPreview({});
    setDayExplorer("all");
    setGlobalTrack(null);
    setGlobalTrackPick("");
    showNotice("success", "Register Preset", `${preset.name} applied.`);
  }

  function deleteRegisterPreset(presetId) {
    const preset = registerPresets.find((item) => item.id === presetId);
    if (!preset) return;
    setRegisterPresets((prev) => prev.filter((item) => item.id !== presetId));
    if (selectedRegisterPresetId === presetId) setSelectedRegisterPresetId("");
    showNotice("info", "Register Preset", `${preset.name} deleted.`);
  }

  function clearAll() {
    setRegistrations([]);
    setPreview({});
    setDayExplorer("all");
    setGlobalTrack(null);
    setGlobalTrackPick("");
    setSelectedRegisterPresetId("");
    setDamagePlans([]);
    setShowPlannerModal(false);
    setPlannerModalTab("panel");
    setPlannerPreviewPlanId("");
    setPlannerLocks({});
    setPlannerChangeFlags({});
    setTrackOverrides({});
    setSharedTrackOverrides({});
    setCustomTrackOptions([]);
    setRemovedModifiedTrackIds([]);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SHARED_TRACK_OVERRIDES_KEY);
    localStorage.removeItem(CUSTOM_TRACK_OPTIONS_KEY);
    localStorage.removeItem(TRACK_OVERRIDES_KEY);
    localStorage.removeItem(REMOVED_MODIFIED_TRACK_IDS_KEY);
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
    setDayExplorer("all");
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
    setDayExplorer("all");
    setPreview({});
  }

  function applyDayExplorer(day) {
    const next = String(day || "all");
    setDayExplorer((prev) => (prev === next ? "all" : next));
    setPreview({});
    setGlobalTrack(null);
    setGlobalTrackPick("");
  }

  function applyRankedTrack(name) {
    const selected = baseTrackOptions.find((track) => track.label === name);
    if (!selected) return;
    setGlobalTrackPick(selected.id);
    applyGlobalSectionTrack(selected.id);
  }

  function applyIrregularSchedule(candidate) {
    if (!candidate?.registrations?.length) return;
    setRegistrations(candidate.registrations);
    setGlobalTrack(null);
    setGlobalTrackPick("");
    setDayExplorer("all");
    setPreview({});
    showNotice("success", "Irregular Schedule Applied", `${candidate.name} was registered successfully.`);
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
    const sectionSet = new Set(modifyTargetTrack.sections.map(groupTrackKey).filter(Boolean));
    const out = [];

    for (const course of sectionPresetCourses) {
      for (const raw of course.sessions) {
        const gName = groupTrackKey(raw.GroupName);
        const matchesLecture = isLecture(raw.Type) && extractLecturePrefix(gName) === prefixUpper;
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
  }, [modifyTargetTrack, sectionPresetCourses]);

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
      if (Number.isNaN(start) || start < 0 || start >= currentTimeSlots.length) {
        showNotice("error", "Modify", "Invalid start slot.");
        return;
      }

      const span = slotRange(selectedEditableSession, currentTimeSlots)?.span || forcedSpanByType(selectedEditableSession.Type);
      const end = start + span - 1;
      if (end >= currentTimeSlots.length) {
        showNotice("error", "Modify", "Selected slot does not fit this session duration.");
        return;
      }

      const startText = toSecondsHHMM(currentTimeSlots[start].split("-")[0].trim());
      const endText = toSecondsHHMM(currentTimeSlots[end].split("-")[1].trim());
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

    const mergePayloadToMap = (baseMap = {}) =>
      Object.fromEntries(targetKeys.map((key) => [key, { ...(baseMap[key] || {}), ...payload }]));

    let destinationTrackId = modifyTargetTrack.id;
    let destinationTrackLabel = modifyTargetTrack.label;
    let destinationTrackIsModified = Boolean(modifyTargetTrack.isModified);
    let destinationBaseTrackId = modifyTargetTrack.baseTrackId || modifyTargetTrack.id;

    const shouldAutoCreateModified = modifyMode === "new";

    if (shouldAutoCreateModified) {
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
          baseTrackId: modifyTargetTrack.baseTrackId || modifyTargetTrack.id,
        },
      ]);
      destinationTrackId = id;
      destinationTrackLabel = label;
      destinationTrackIsModified = true;
      destinationBaseTrackId = modifyTargetTrack.baseTrackId || modifyTargetTrack.id;
    }

    const destinationOverrides = shouldAutoCreateModified
      ? modifyTrackOverrides
      : trackOverrides[destinationTrackId] || {};
    const beforeSessions = editableTrackSessions.map((session) => ({
      ...session,
      ...(destinationOverrides[session.sessionKey] || {}),
    }));
    const afterSessions = editableTrackSessions.map((session) => ({
      ...session,
      ...(destinationOverrides[session.sessionKey] || {}),
      ...(targetKeys.includes(session.sessionKey) ? payload : {}),
    }));
    const conflictsBefore = countSessionConflicts(beforeSessions, currentTimeSlots);
    const conflictsAfter = countSessionConflicts(afterSessions, currentTimeSlots);
    if (conflictsAfter > conflictsBefore) {
      showNotice("error", "Modify Conflict", `This change creates ${conflictsAfter - conflictsBefore} new conflict(s). Choose another day or time.`);
      return;
    }

    setTrackOverrides((prev) => ({
      ...prev,
      [destinationTrackId]: {
        ...destinationOverrides,
        ...mergePayloadToMap(destinationOverrides),
      },
    }));

    setModifyTrackId(destinationTrackId);
    setGlobalTrackPick(destinationTrackId);
    setGlobalTrack({
      trackId: destinationTrackId,
      section: destinationTrackLabel,
      prefix: modifyTargetTrack.prefix,
      sections: [...modifyTargetTrack.sections],
      selectedSubgroup: destinationTrackLabel,
      isModified: destinationTrackIsModified,
      baseTrackId: destinationBaseTrackId,
    });
    showNotice("success", "Modify", `${destinationTrackLabel} updated successfully.`);

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
    if (globalTrackPick === modifyTargetTrack.id) {
      applyGlobalSectionTrack(modifyTargetTrack.id);
    }

    showNotice("info", "Reverted", `${modifyTargetTrack.label} changes were reverted.`);
  }

  function removeModifiedTrackById(trackId) {
    const targetTrack = trackById.get(trackId);
    if (!targetTrack?.isModified) return;
    const fallbackTrackId = targetTrack.baseTrackId || "";

    setTrackOverrides((prev) => {
      const next = { ...prev };
      delete next[targetTrack.id];
      return next;
    });
    if (targetTrack.id.startsWith("custom-")) {
      setCustomTrackOptions((prev) => prev.filter((track) => track.id !== targetTrack.id));
    }
    setRemovedModifiedTrackIds((prev) =>
      prev.includes(targetTrack.id) ? prev : [...prev, targetTrack.id]
    );

    if (globalTrackPick === targetTrack.id) {
      setGlobalTrackPick(fallbackTrackId);
      applyGlobalSectionTrack(fallbackTrackId);
      if (!fallbackTrackId) {
        setGlobalTrack(null);
      }
    }

    if (modifyTrackId === targetTrack.id) {
      setModifyTrackId(fallbackTrackId);
    }

    showNotice("info", "Removed", `${targetTrack.label} was removed.`);
  }

  function removeModifiedTrack() {
    if (!modifyTargetTrack?.isModified) return;
    removeModifiedTrackById(modifyTargetTrack.id);
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

  function captureScheduleImage(mode = "download", titleOverride = "") {
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

        const exportHeader = document.createElement("div");
        const selectedLevel = new URLSearchParams(window.location.search).get("level") || "3";
        const facultyTitle = document.createElement("h1");
        facultyTitle.style.margin = "0 0 6px";
        facultyTitle.textContent = "Faculty of Oral & Dental Medicine";
        const scheduleTitle = document.createElement("h2");
        scheduleTitle.style.margin = "0 0 6px";
        scheduleTitle.textContent = titleOverride || printTitle;
        const exportMeta = document.createElement("p");
        exportMeta.style.margin = "0 0 14px";
        exportMeta.textContent = `Level ${selectedLevel} · Current semester · Exported ${new Date().toLocaleString()}`;
        exportHeader.append(facultyTitle, scheduleTitle, exportMeta);
        snapshotRoot.appendChild(exportHeader);

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

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
        if (mode === "collect") return canvas;
        if (mode === "pdf") {
          const { jsPDF } = await import("jspdf");
          const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          const margin = 6;
          const renderWidth = pageWidth - margin * 2;
          const renderHeight = (canvas.height * renderWidth) / canvas.width;
          const usableHeight = pageHeight - margin * 2;
          const pageCount = Math.max(1, Math.ceil(renderHeight / usableHeight));
          const image = canvas.toDataURL("image/png", 1);

          for (let page = 0; page < pageCount; page += 1) {
            if (page > 0) pdf.addPage("a4", "landscape");
            pdf.addImage(image, "PNG", margin, margin - page * usableHeight, renderWidth, renderHeight, undefined, "FAST");
            pdf.setFillColor(255, 255, 255);
            if (page > 0) pdf.rect(0, 0, pageWidth, margin, "F");
            pdf.setFontSize(8);
            pdf.setTextColor(70, 85, 105);
            pdf.text(`Page ${page + 1} of ${pageCount}`, pageWidth - margin, pageHeight - 2, { align: "right" });
          }

          const selectedLevel = new URLSearchParams(window.location.search).get("level") || "3";
          pdf.save(`dentistry-level-${selectedLevel}-${printTitle.replace(/\s+/g, "-").toLowerCase()}.pdf`);
          showNotice("success", "Download PDF", "PDF downloaded using the same timetable design as the copied image.");
        } else if (mode === "copy" && navigator.clipboard?.write && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          showNotice("success", "Copy as Image", "The complete schedule was copied to the clipboard.");
        } else {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${printTitle.replace(/\s+/g, "-").toLowerCase()}-schedule.png`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          showNotice("success", mode === "copy" ? "Copy as Image" : "Download PNG", mode === "copy" ? "Clipboard images are unavailable; PNG downloaded instead." : "Schedule PNG downloaded.");
        }
      } catch (err) {
        showNotice("error", "Download Schedule", err?.message || "Failed to capture schedule.");
      } finally {
        if (snapshotRoot?.parentNode) snapshotRoot.parentNode.removeChild(snapshotRoot);
      }
    };

    return exportSchedule();
  }

  async function downloadAllLevelPdf() {
    if (!trackOptions.length) {
      showNotice("error", "Download All Level PDF", "No Group/Section schedules are available for this level.");
      return;
    }

    const originalPick = globalTrackPick;
    const originalTrack = globalTrack;
    const originalPreview = preview;
    const originalDay = dayExplorer;
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      let firstPage = true;

      for (const track of trackOptions) {
        setGlobalTrackPick(track.id);
        setGlobalTrack({
          trackId: track.id,
          section: track.label,
          prefix: track.prefix,
          sections: track.sections,
          selectedSubgroup: track.label,
          isModified: Boolean(track.isModified),
        });
        setPreview({});
        setDayExplorer("all");
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const canvas = await captureScheduleImage("collect", `${track.label} Schedule`);
        if (!canvas) continue;
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const margin = 6;
        const renderWidth = pageWidth - margin * 2;
        const renderHeight = (canvas.height * renderWidth) / canvas.width;
        const usableHeight = pageHeight - margin * 2;
        const pageCount = Math.max(1, Math.ceil(renderHeight / usableHeight));
        const image = canvas.toDataURL("image/png", 1);

        for (let page = 0; page < pageCount; page += 1) {
          if (!firstPage) pdf.addPage("a4", "landscape");
          firstPage = false;
          pdf.addImage(image, "PNG", margin, margin - page * usableHeight, renderWidth, renderHeight, undefined, "FAST");
        }
      }

      const totalPages = pdf.getNumberOfPages();
      for (let page = 1; page <= totalPages; page += 1) {
        pdf.setPage(page);
        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, pdf.internal.pageSize.getHeight() - 5, pdf.internal.pageSize.getWidth(), 5, "F");
        pdf.setFontSize(8).setTextColor(70, 85, 105);
        pdf.text(`Page ${page} of ${totalPages}`, pdf.internal.pageSize.getWidth() - 6, pdf.internal.pageSize.getHeight() - 2, { align: "right" });
      }
      const selectedLevel = new URLSearchParams(window.location.search).get("level") || "3";
      pdf.save(`dentistry-level-${selectedLevel}-all-schedules.pdf`);
      showNotice("success", "Download All Level PDF", `Combined ${trackOptions.length} Editor schedules in one PDF.`);
    } catch (err) {
      showNotice("error", "Download All Level PDF", err?.message || "Failed to export all schedules.");
    } finally {
      setGlobalTrackPick(originalPick);
      setGlobalTrack(originalTrack);
      setPreview(originalPreview);
      setDayExplorer(originalDay);
    }
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
                                  onChange={(ev) => {
                                    const sectionId = Number(ev.target.value);
                                    const section = subgroupGroups.find((group) => group.id === sectionId);
                                    const lecture = section
                                      ? lectureGroups.find((group) => lectureMatchesSection(group.name, section.name))
                                      : null;
                                    setSubPick(sectionId);
                                    if (lecture) setLecturePick(lecture.id);
                                  }}
                                />
                                <span>
                                  <strong>{g.name}</strong> ({g.type})
                                </span>
                                <small>{summarize(g)}</small>
                              </label>
                            ))}
                          </div>
                        )}

                        <div className="register-actions">
                          <button className="btn" type="submit">
                            Register Selection
                          </button>
                        </div>
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
              <div className="global-track">
                <select
                  value={selectedRegisterPresetId}
                  onChange={(e) => applyRegisterPreset(e.target.value)}
                  className="track-select"
                >
                  <option value="">Register Presets</option>
                  {registerPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="mini"
                  disabled={!selectedRegisterPresetId}
                  onClick={() => deleteRegisterPreset(selectedRegisterPresetId)}
                >
                  Delete Preset
                </button>
                <button
                  type="button"
                  className="mini"
                  disabled={!registrations.length}
                  onClick={saveCurrentRegistrationPreset}
                >
                  Save All Reg
                </button>
              </div>
              <div className="global-track">
                <select
                  value={timeProfile}
                  onChange={(e) => setTimeProfile(e.target.value)}
                  className="track-select"
                >
                  {Object.values(TIME_PROFILES).map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
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
              <button className="btn secondary" type="button" onClick={() => captureScheduleImage("copy")}>
                Copy as Image
              </button>
              <button className="btn secondary" type="button" onClick={() => captureScheduleImage("download")}>
                Download PNG
              </button>
              <button className="btn secondary" type="button" onClick={() => captureScheduleImage("pdf")}>
                Download Level PDF
              </button>
              <button className="btn secondary" type="button" onClick={downloadAllLevelPdf}>
                Download All Level PDF
              </button>
              <button className="btn secondary" type="button" onClick={clearAll}>
                Clear All
              </button>
            </div>
          </div>
          <div className="combined-tables-picker" aria-label="Combined section schedules">
            <div className="combined-tables-copy">
              <strong>Combined Section Tables</strong>
              <span>Choose a day to view every section together, with shared lectures merged vertically.</span>
            </div>
            <div className="day-filter-row">
              <button
                key="day-explorer-all"
                type="button"
                className={`mini ${dayExplorer === "all" ? "on" : ""}`}
                onClick={() => applyDayExplorer("all")}
                aria-pressed={dayExplorer === "all"}
              >
                Weekly View
              </button>
            {DAYS.map((day) => (
              <button
                key={`day-explorer-${day}`}
                type="button"
                className={`mini ${dayExplorer === day ? "on" : ""}`}
                onClick={() => applyDayExplorer(day)}
                aria-pressed={dayExplorer === day}
              >
                {day}
              </button>
            ))}
            </div>
          </div>
          <div className="saved-management">
            <div className="saved-block">
              <strong>Delete Modified Tables</strong>
              {removableModifiedTracks.length > 0 ? (
                <div className="saved-list">
                  {removableModifiedTracks.map((track) => (
                    <div key={`remove-track-${track.id}`} className="saved-item">
                      <span>{track.label}</span>
                      <button type="button" className="mini danger" onClick={() => removeModifiedTrackById(track.id)}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted score-line">No modified tables to delete.</p>
              )}
            </div>

            <div className="saved-block">
              <strong>Delete Saved Presets</strong>
              {registerPresets.length > 0 ? (
                <div className="saved-list">
                  {registerPresets.map((preset) => (
                    <div key={`remove-preset-${preset.id}`} className="saved-item">
                      <span>{preset.name}</span>
                      <button type="button" className="mini danger" onClick={() => deleteRegisterPreset(preset.id)}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted score-line">No saved presets to delete.</p>
              )}
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
                {!selectedRegisterPresetId && (
                  <button
                    type="button"
                    className={`mini ${modifyMode === "new" ? "on" : ""}`}
                    onClick={() => setModifyMode("new")}
                  >
                    Create Modified Copy
                  </button>
                )}
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
                    {currentTimeSlots.map((slot, idx) => {
                      const span =
                        slotRange(selectedEditableSession, currentTimeSlots)?.span ||
                        forcedSpanByType(selectedEditableSession?.Type || "Group");
                      if (idx + span > currentTimeSlots.length) return null;
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
          <div className={`combined-table-title ${dayExplorer !== "all" ? "visible" : ""}`} aria-live="polite">
            {dayExplorer !== "all" && (
              <>
                <strong>{dayExplorer} Combined Sections</strong>
                <span>{daySectionRows.length} section tracks · shared lectures are merged</span>
              </>
            )}
          </div>
          <h1 className="print-export-title">{printTitle}</h1>
          <div
            className={`timetable ${dayExplorer !== "all" ? "day-sections-mode" : ""}`}
            style={{ "--slots-count": currentTimeSlots.length }}
          >
            <div className="time-header">
              <div className="corner">{dayExplorer === "all" ? "Day / Time" : "Section / Time"}</div>
              {currentTimeSlots.map((slot) => (
                <div className="time-cell" key={slot}>
                  {formatSlotLabel(slot, timeFormat)}
                </div>
              ))}
            </div>

            {dayExplorer === "all" &&
              visibleDays.map((day) => (
                <div className="day-row" key={day}>
                  <div className="day-label">{day}</div>
                  <div className="day-grid">
                    {currentTimeSlots.map((slot) => (
                      <div className="slot-cell" key={`${day}-${slot}`} />
                    ))}
                    {tableSessions
                      .filter((s) => normalizeDay(s) === day)
                      .map((s, idx) => {
                        const range = slotRange(s, currentTimeSlots);
                        if (!range) return null;

                        return (
                          <article
                            key={`${day}-${s.courseName}-${s.GroupId}-${idx}-${s.Time}`}
                            className={`lesson ${blockKindByType(s.Type)} ${
                              s.source === "preview" || s.source === "planner-preview" ? "preview" : ""
                            } ${
                              s.source === "track" ? "track" : ""
                            } ${s.isModified ? "modified" : ""} ${
                              globalTrack?.isModified && s.source === "track" ? "modified-track" : ""
                            }`}
                            style={{ gridColumn: `${range.start + 1} / span ${range.span}` }}
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

            {dayExplorer !== "all" && dayExplorerTableModel && (
              <table className="sections-day-table">
                <tbody>
                  {dayExplorerTableModel.rows.map((row, r) => (
                    <tr key={`section-row-${row.id}`}>
                      <th scope="row" className="sections-day-label">
                        {row.label}
                      </th>
                      {Array.from({ length: dayExplorerTableModel.colCount }).map((_, c) => {
                        const cellKey = `${r}:${c}`;
                        const block = dayExplorerTableModel.starts.get(cellKey);
                        if (block) {
                          const s = block.session;
                          return (
                            <td
                              key={`block-${row.id}-${c}`}
                              rowSpan={block.rowSpan}
                              colSpan={block.colSpan}
                              className={`sections-day-lesson ${blockKindByType(s.Type)} ${
                                s.isModified ? "modified" : ""
                              } ${isLecture(s.Type) && block.rowSpan > 1 ? "vertical-merged" : ""}`}
                              title={`${s.courseName} | ${displayGroupNameInCard(s)} | ${s.Time}`}
                            >
                              <div className="sections-day-lesson-content">
                                <strong>{s.courseName}</strong>
                                <span>{displayGroupNameInCard(s)}</span>
                                <span>{s.ClassRoomName || "N/A"}</span>
                              </div>
                            </td>
                          );
                        }
                        if (dayExplorerTableModel.covered.has(cellKey)) return null;
                        return <td key={`empty-${row.id}-${c}`} className="sections-day-empty" />;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
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
              <button
                className="mini"
                type="button"
                onClick={() => {
                  if (!damagePlans.length) {
                    generateDamagePlans();
                    return;
                  }
                  setShowPlannerModal(true);
                }}
              >
                Open Damage Planner
              </button>
            </div>

            {showAnalytics && (
              <>
                <div className="analytics-mode-switch" role="tablist" aria-label="Analytics type">
                  <button type="button" className={`switch-btn ${analyticsMode === "regular" ? "active" : ""}`} onClick={() => setAnalyticsMode("regular")}>
                    Regular Track Analytics
                  </button>
                  <button type="button" className={`switch-btn ${analyticsMode === "irregular" ? "active" : ""}`} onClick={() => setAnalyticsMode("irregular")}>
                    Irregular Registration Analytics
                  </button>
                </div>

                {analyticsMode === "regular" && tableSessions.length > 0 && (
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

                {analyticsMode === "regular" && scoreEnabled && hasBuiltSchedule && (
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

                {analyticsMode === "regular" && scoreEnabled && !hasBuiltSchedule && (
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

                {analyticsMode === "irregular" && scoreEnabled && (
                  <div className="score-panel">
                    <div className="score-header">
                      <div>
                        <h3>Best Irregular Schedules</h3>
                        <p className="muted score-line">
                          Lecture and section groups may differ between courses. Conflict-free plans are ranked first.
                        </p>
                      </div>
                      <button
                        className="mini"
                        type="button"
                        disabled={isGeneratingIrregular}
                        onClick={generateIrregularSchedules}
                      >
                        {isGeneratingIrregular ? "Analyzing..." : "Run Irregular Analysis"}
                      </button>
                    </div>
                    {irregularScheduleCandidates.length > 0 ? (
                      <div className="ranked-tracks">
                        {irregularScheduleCandidates.map((candidate) => (
                        <article key={candidate.id} className="rank-item irregular-rank-item">
                          <div>
                            <strong>{candidate.name}</strong>
                            <small>
                              Score {candidate.score.overall} | Days {candidate.score.activeDays}/4 target | Gaps{" "}
                              {candidate.score.gapSlots} | After 4:15: {candidate.score.after4Sessions} | Conflicts{" "}
                              {candidate.score.conflictCount} | Early Sections {candidate.score.earlySectionCount}
                            </small>
                            <details>
                              <summary>Show selected groups</summary>
                              <ul>
                                {candidate.choices.map((choice) => (
                                  <li key={`${candidate.id}-${choice}`}>{choice}</li>
                                ))}
                              </ul>
                            </details>
                          </div>
                          <button className="mini" type="button" onClick={() => applyIrregularSchedule(candidate)}>
                            Apply
                          </button>
                        </article>
                        ))}
                      </div>
                    ) : (
                      <p className="muted score-line">
                        The optimizer runs only when requested, so opening the page stays fast.
                      </p>
                    )}
                  </div>
                )}

                {!scoreEnabled && (
                  <p className="muted score-line">
                    Analytics is disabled while preview mode is active (All Lectures, All Sections, or Day View).
                  </p>
                )}

                {analyticsMode === "regular" && tableSessions.length > 0 && (
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
          {showPlannerModal && (
            <div className="planner-modal-overlay" role="dialog" aria-modal="true" aria-label="Damage Planner">
              <div className="planner-modal">
                <div className="planner-modal-head">
                  <h3>Damage Planner</h3>
                  <div className="planner-modal-actions">
                    <button
                      type="button"
                      className={`mini ${plannerModalTab === "panel" ? "on" : ""}`}
                      onClick={() => setPlannerModalTab("panel")}
                    >
                      Control Panel
                    </button>
                    <button
                      type="button"
                      className={`mini ${plannerModalTab === "preview" ? "on" : ""}`}
                      onClick={() => setPlannerModalTab("preview")}
                      disabled={!plannerPreviewPlanId}
                    >
                      Preview
                    </button>
                    <button className="mini" type="button" onClick={() => setShowPlannerModal(false)}>
                      Close
                    </button>
                  </div>
                </div>

                {plannerModalTab === "panel" && (
                  <div className="planner-modal-body">
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
                      <button className="mini" type="button" onClick={generateDamagePlans}>
                        Regenerate
                      </button>
                      <button className="mini" type="button" onClick={() => setShowPlannerManual((v) => !v)}>
                        {showPlannerManual ? "Hide Section Picker" : "Show Section Picker"}
                      </button>
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

                    <div className="planner-results">
                      <h3>Low-Damage Plan Suggestions</h3>
                      {damagePlans.length > 0 ? (
                        <div className="planner-result-list">
                          {damagePlans.map((plan) => (
                            <article key={plan.id} className={`planner-result-item ${plan.improves ? "improves" : ""}`}>
                              <div className="planner-result-head">
                                <strong>
                                  {plan.improves ? "Improves current schedule" : "Fallback plan"} | {plan.changeCount} change(s)
                                </strong>
                                <div className="planner-result-actions">
                                  <button
                                    className="mini"
                                    type="button"
                                    onClick={() => {
                                      setPlannerPreviewPlanId(plan.id);
                                      setPlannerModalTab("preview");
                                    }}
                                  >
                                    Preview
                                  </button>
                                  <button className="mini" type="button" onClick={() => applyDamagePlan(plan.id)}>
                                    Apply
                                  </button>
                                </div>
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
                      ) : (
                        <p className="muted score-line">No plans yet. Click Regenerate to create suggestions.</p>
                      )}
                    </div>
                  </div>
                )}

                {plannerModalTab === "preview" && (
                  <div className="planner-modal-body planner-preview-body">
                    <div className="planner-controls">
                      <label htmlFor="planner-preview-select">Plan</label>
                      <select
                        id="planner-preview-select"
                        className="track-select"
                        value={plannerPreviewPlanId}
                        onChange={(e) => setPlannerPreviewPlanId(e.target.value)}
                      >
                        {damagePlans.map((plan) => (
                          <option key={`preview-plan-${plan.id}`} value={plan.id}>
                            {plan.improves ? "Improves" : "Fallback"} | {plan.changeCount} change(s) | Score {plan.score.overall}
                          </option>
                        ))}
                      </select>
                      <button className="mini" type="button" onClick={() => setPlannerModalTab("panel")}>
                        Back To Panel
                      </button>
                    </div>
                    {plannerPreviewPlan ? (
                      <div className="planner-results">
                        <h3>Preview Summary</h3>
                        <p className="planner-score-line">
                          Score {plannerPreviewPlan.score.overall} | Days {plannerPreviewPlan.score.activeDays} | Gaps{" "}
                          {plannerPreviewPlan.score.gapSlots} | After 4:15 {plannerPreviewPlan.score.after4Sessions} |
                          Conflicts {plannerPreviewPlan.score.conflictCount}
                        </p>
                        {plannerPreviewPlan.changes.length > 0 ? (
                          <ul className="planner-change-list">
                            {plannerPreviewPlan.changes.map((change) => (
                              <li key={`preview-change-${plannerPreviewPlan.id}-${change.courseId}`}>
                                <strong>{change.courseName}</strong>: {change.from} {"->"} {change.to}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted score-line">No changes in this preview plan.</p>
                        )}
                      </div>
                    ) : (
                      <p className="muted score-line">Select a plan from the list to preview it on the timetable.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

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

