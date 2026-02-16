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

function AppBody() {
  const [courses, setCourses] = useState([]);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [registrations, setRegistrations] = useState([]);
  const [preview, setPreview] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [tableOnly, setTableOnly] = useState(false);
  const [controlTab, setControlTab] = useState("courses");
  const [globalTrackPick, setGlobalTrackPick] = useState("");
  const [globalTrack, setGlobalTrack] = useState(null);
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
        if (loaded.length) {
          setSelectedCourseId(loaded[0].id);
        }

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

  const selectedCourse = coursesById.get(selectedCourseId);
  const selectedGroups = selectedCourse ? collectGroups(selectedCourse) : [];
  const lectureGroups = selectedGroups.filter((g) => isLecture(g.type));
  const subgroupGroups = selectedGroups.filter((g) => isSubgroup(g.type));

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
  const activePreviewCount = Object.values(preview).filter((p) => p?.lectures || p?.subgroups).length;

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
    setPreview((prev) => {
      const current = prev[courseId] || { lectures: false, subgroups: false };
      return {
        ...prev,
        [courseId]: {
          ...current,
          [key]: !current[key],
        },
      };
    });
  }

  function applyGlobalSectionTrack() {
    const selectedName = String(globalTrackPick || "").trim();
    if (!selectedName) {
      showNotice("error", "Section Track", "Choose a section first (e.g. B1).");
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
    showNotice("success", "Section Track Enabled", `Showing lectures ${prefix} + section ${selectedName} across all courses.`);
  }

  function clearGlobalSectionTrack() {
    setGlobalTrack(null);
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

  return (
    <div className={`app ${tableOnly ? "table-only" : ""}`}>
      <header className="header">
        <div className="header-main">
          <h1>University Schedule Manager</h1>
          <p>Organize courses, sections, and tracks with conflict-safe planning.</p>
        </div>
        <div className="header-stats">
          <span className="stat-pill">Registered: {registeredCount}</span>
          <span className="stat-pill">Previews: {activePreviewCount}</span>
        </div>
      </header>

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
          <div className="rail-tabs">
            <button
              type="button"
              className={`rail-tab ${controlTab === "courses" ? "active" : ""}`}
              onClick={() => setControlTab("courses")}
            >
              Courses
            </button>
            <button
              type="button"
              className={`rail-tab ${controlTab === "registration" ? "active" : ""}`}
              onClick={() => setControlTab("registration")}
            >
              Registration
            </button>
          </div>

          <section className={`panel courses-panel ${controlTab === "courses" ? "show" : "hide-mobile"}`}>
            <h2>Courses</h2>
            <div className="course-list">
              {courses.map((course) => {
                const p = preview[course.id] || { lectures: false, subgroups: false };
                return (
                  <div key={course.id} className={`course-card ${selectedCourseId === course.id ? "active" : ""}`}>
                    <button className="course-name" onClick={() => setSelectedCourseId(course.id)} type="button">
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
                  </div>
                );
              })}
            </div>
          </section>

          <section className={`panel registration-panel ${controlTab === "registration" ? "show" : "hide-mobile"}`}>
            <h2>Registration</h2>
            {!selectedCourse && <p className="muted">Select a course.</p>}
            {selectedCourse && (
              <form onSubmit={registerSelection} className="reg-form">
                <h3>{selectedCourse.name}</h3>

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

                <div className="group-box">
                  <h4>{subgroupGroups.length ? "Section/Lab (required, one only)" : "Section/Lab (none for this course)"}</h4>
                  {!subgroupGroups.length && <small className="muted">No section groups for this course.</small>}
                  {!subgroupGroups.length && (
                    <label className="group-item">
                      <input
                        type="radio"
                        name="sub"
                        value=""
                        checked={subPick === ""}
                        onChange={() => setSubPick("")}
                      />
                      <span>No section</span>
                    </label>
                  )}
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

                <button className="btn" type="submit">
                  Register Selection
                </button>
              </form>
            )}
          </section>
        </aside>

        <section className="panel schedule-panel" ref={scheduleRef}>
          <div className="schedule-head">
            <h2>Weekly Timetable</h2>
            <div className="head-actions">
              <div className="global-track">
                <select
                  value={globalTrackPick}
                  onChange={(e) => setGlobalTrackPick(e.target.value)}
                  className="track-select"
                >
                  <option value="">Section Track (e.g. B1)</option>
                  {globalSubgroupOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button className="mini" type="button" onClick={applyGlobalSectionTrack}>
                  Show Track
                </button>
                <button className="mini" type="button" onClick={clearGlobalSectionTrack}>
                  Clear Track
                </button>
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
              <button className="btn secondary" type="button" onClick={clearAll}>
                Clear All
              </button>
            </div>
          </div>
          {globalTrack && (
            <div className="track-banner">
              Active Track: {globalTrack.selectedSubgroup} =&gt; lectures {globalTrack.prefix} + section{" "}
              {globalTrack.selectedSubgroup} across all courses
            </div>
          )}

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

