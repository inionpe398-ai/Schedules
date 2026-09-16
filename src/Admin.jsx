import React, { useEffect, useState } from "react";

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

  async function loadCourses() {
    try { setCourses(await adminFetch("/api/admin/dulms-courses", apiKey)); setError(""); }
    catch (err) { setError(err.message); }
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
      <section className="panel"><h2>Course Catalog ({courses.length})</h2><div className="admin-course-table"><table><thead><tr><th>Code</th><th>Name</th><th>Level</th><th>Last Sync</th></tr></thead><tbody>{courses.map((course) => <tr key={course.id}><td>{course.course_code}</td><td>{course.course_name}</td><td>{course.academic_level || "GEN/FEL"}</td><td>{course.last_synced_at || "—"}</td></tr>)}</tbody></table></div></section>
    </main>
  );
}
