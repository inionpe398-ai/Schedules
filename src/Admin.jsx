import React, { useDeferredValue, useEffect, useMemo, useState } from "react";

const scopes = ["1", "2", "3", "4", "5", "general", "all"];

async function adminFetch(path, apiKey, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "x-admin-key": apiKey, "x-requested-with": "schedule-admin", ...(options.headers || {}) },
  });
  const body = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

export default function Admin() {
  const [apiKey, setApiKey] = useState("");
  const [scope, setScope] = useState("3");
  const [refreshCatalog, setRefreshCatalog] = useState(true);
  const [run, setRun] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [courses, setCourses] = useState([]);
  const [courseLevel, setCourseLevel] = useState("3");
  const [courseSearch, setCourseSearch] = useState("");
  const [selectedCourses, setSelectedCourses] = useState(new Set());
  const [assignmentsDirty, setAssignmentsDirty] = useState(false);
  const [saveState, setSaveState] = useState("");
  const deferredSearch = useDeferredValue(courseSearch);

  async function loadCourses() {
    try { setCourses(await adminFetch("/api/admin/dulms-courses", apiKey)); setError(""); }
    catch (err) { setError(err.message); }
  }

  useEffect(() => {
    const level = Number(courseLevel);
    setSelectedCourses(new Set(courses.filter((course) => course.linkedLevels?.includes(level)).map((course) => course.id)));
    setAssignmentsDirty(false);
    setSaveState("");
  }, [courses, courseLevel]);

  const filteredCourses = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return courses.filter((course) => !query || `${course.course_code} ${course.course_name}`.toLowerCase().includes(query));
  }, [courses, deferredSearch]);

  function toggleCourse(courseId) {
    setSelectedCourses((current) => {
      const next = new Set(current);
      next.has(courseId) ? next.delete(courseId) : next.add(courseId);
      return next;
    });
    setAssignmentsDirty(true);
    setSaveState("");
  }

  function setFilteredSelection(checked) {
    setSelectedCourses((current) => {
      const next = new Set(current);
      filteredCourses.forEach((course) => checked ? next.add(course.id) : next.delete(course.id));
      return next;
    });
    setAssignmentsDirty(true);
    setSaveState("");
  }

  async function saveLevelCourses() {
    setBusy(true); setError(""); setSaveState("");
    try {
      const result = await adminFetch(`/api/admin/levels/${courseLevel}/courses`, apiKey, { method: "PUT", body: JSON.stringify({ courseIds: [...selectedCourses] }) });
      setCourses((current) => current.map((course) => ({ ...course, linkedLevels: selectedCourses.has(course.id) ? [...new Set([...(course.linkedLevels || []).filter((level) => level !== Number(courseLevel)), Number(courseLevel)])] : (course.linkedLevels || []).filter((level) => level !== Number(courseLevel)) })));
      setAssignmentsDirty(false);
      setSaveState(`${result.assigned} courses saved for Level ${courseLevel}`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function preview() {
    setBusy(true); setError(""); setRun(null);
    try {
      const result = await adminFetch("/api/admin/dulms-sync/preview", apiKey, { method: "POST", body: JSON.stringify({ scope, refreshCatalog }) });
      setRun({ id: result.runId, status: "running" });
    } catch (err) { setError(err.message); setBusy(false); }
  }

  useEffect(() => {
    if (!run?.id || run.status !== "running") return undefined;
    const timer = setInterval(async () => {
      try {
        const latest = await adminFetch(`/api/admin/dulms-sync/${run.id}`, apiKey);
        setRun(latest);
        if (latest.status !== "running") setBusy(false);
      } catch (err) { setError(err.message); setBusy(false); clearInterval(timer); }
    }, 1000);
    return () => clearInterval(timer);
  }, [run?.id, run?.status, apiKey]);

  async function apply() {
    if (!window.confirm("Apply this preview to the schedule database?")) return;
    setBusy(true);
    try {
      const result = await adminFetch("/api/admin/dulms-sync/apply", apiKey, { method: "POST", body: JSON.stringify({ runId: run.id, confirm: true }) });
      setRun((current) => ({ ...current, status: "applied", summary: result.summary }));
      await loadCourses();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function downloadPdf() {
    if (scope === "all") { setError("Choose one Level or GEN/FEL for PDF export."); return; }
    if (scope === "general") { setError("Open a numbered Level to export its Editor schedules."); return; }
    window.location.href = `/?level=${encodeURIComponent(scope)}&export=all-pdf`;
  }

  const summary = run?.summary;
  return (
    <main className="admin-page">
      <header className="admin-header"><div><h1>DULMS Schedule Admin</h1><p>Server-side preview, change detection, and safe apply.</p></div><a href="/">Back to schedules</a></header>
      <section className="panel admin-auth"><label>Admin API key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" /></label><button className="btn" onClick={loadCourses}>Connect</button></section>
      {error && <div className="notice error"><strong>Error</strong><p>{error}</p></div>}
      <section className="panel admin-sync">
        <h2>Sync from DULMS</h2>
        <div className="admin-controls">
          <label>Scope<select value={scope} onChange={(e) => setScope(e.target.value)}>{scopes.map((value) => <option key={value} value={value}>{value === "general" ? "GEN / FEL" : value === "all" ? "All" : `Level ${value}`}</option>)}</select></label>
          <label><input type="checkbox" checked={refreshCatalog} onChange={(e) => setRefreshCatalog(e.target.checked)} /> Refresh course catalog</label>
          <label><input type="checkbox" checked readOnly /> Dry run / Preview changes</label>
          <button className="btn" disabled={busy || !apiKey} onClick={preview}>{busy ? "Syncing..." : "Preview Sync"}</button>
          <button className="mini" disabled={!apiKey || scope === "all"} onClick={downloadPdf}>Download All Level PDF</button>
        </div>
        {run && <div className="sync-result"><p>Status: <strong>{run.status}</strong> {run.progress_total ? `(${run.progress_current}/${run.progress_total})` : ""}</p>{run.safe_error && <p>{run.safe_error}</p>}{summary && <><div className="metric-badges"><span>Added {summary.created}</span><span>Updated {summary.updated}</span><span>Deactivated {summary.deactivated}</span><span>Unchanged {summary.unchanged}</span><span>Failed {summary.failed?.length || 0}</span></div><pre>{JSON.stringify(summary.coverageByLevel, null, 2)}</pre>{run.status === "preview_ready" && <button className="btn" disabled={busy} onClick={apply}>Confirm & Apply</button>}</>}</div>}
      </section>
      <section className="panel level-course-manager">
        <div className="level-course-heading">
          <div><p className="eyebrow">Level content</p><h2>Assign courses to a Level</h2><p>Choose exactly which courses appear in each level's schedule.</p></div>
          <label className="level-picker">Level<select value={courseLevel} onChange={(e) => setCourseLevel(e.target.value)}>{[1, 2, 3, 4, 5].map((level) => <option key={level} value={level}>Level {level}</option>)}</select></label>
        </div>
        <div className="course-manager-toolbar">
          <label className="course-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search by course name or code..." value={courseSearch} onChange={(e) => setCourseSearch(e.target.value)} /></label>
          <div className="selection-actions"><button className="mini" onClick={() => setFilteredSelection(true)} disabled={!courses.length}>Select visible</button><button className="mini" onClick={() => setFilteredSelection(false)} disabled={!courses.length}>Clear visible</button></div>
        </div>
        <div className="course-manager-meta"><span><strong>{selectedCourses.size}</strong> selected</span><span>{filteredCourses.length} shown</span>{assignmentsDirty && <span className="unsaved-dot">Unsaved changes</span>}</div>
        <div className="course-checklist">
          {filteredCourses.map((course) => <label className={`course-check-card ${selectedCourses.has(course.id) ? "selected" : ""}`} key={course.id}>
            <input type="checkbox" checked={selectedCourses.has(course.id)} onChange={() => toggleCourse(course.id)} />
            <span className="custom-check" aria-hidden="true">✓</span>
            <span className="course-check-copy"><strong>{course.course_name}</strong><small>{course.course_code} · Source: {course.academic_level ? `Level ${course.academic_level}` : "GEN/FEL"}</small></span>
          </label>)}
          {!filteredCourses.length && <div className="empty-course-search">{courses.length ? "No courses match your search." : "Connect with the Admin API key to load courses."}</div>}
        </div>
        <div className="course-manager-footer"><span className={saveState ? "save-success" : ""}>{saveState || (assignmentsDirty ? "Review your selection, then save." : "All changes saved.")}</span><button className="btn" onClick={saveLevelCourses} disabled={!apiKey || busy || !assignmentsDirty}>{busy ? "Saving..." : `Save Level ${courseLevel}`}</button></div>
      </section>
      <section className="panel"><h2>Course Catalog ({courses.length})</h2><div className="admin-course-table"><table><thead><tr><th>Code</th><th>Name</th><th>Level</th><th>Last Sync</th></tr></thead><tbody>{courses.map((course) => <tr key={course.id}><td>{course.course_code}</td><td>{course.course_name}</td><td>{course.academic_level || "GEN/FEL"}</td><td>{course.last_synced_at || "—"}</td></tr>)}</tbody></table></div></section>
    </main>
  );
}
