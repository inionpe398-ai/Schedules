import { jsPDF } from "jspdf";

function safe(value) { return value == null || value === "" ? "—" : String(value); }
function slug(value) { return String(value || "current").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

export function createLevelPdf({ level, semester, courses, sessions, lastSyncedAt }) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const title = level === "general" ? "GEN / FEL" : `Level ${level}`;
  const groups = new Set(sessions.filter((s) => s.group_type === "Group").map((s) => s.group_name));
  const subgroups = new Set(sessions.filter((s) => s.group_type === "SubGroup").map((s) => s.group_name));
  doc.setFont("helvetica", "bold").setFontSize(20).text("Faculty of Oral & Dental Medicine", 148, 35, { align: "center" });
  doc.setFontSize(17).text(`${title} Schedule`, 148, 49, { align: "center" });
  doc.setFont("helvetica", "normal").setFontSize(11);
  const summary = [
    `Semester: ${safe(semester)}`, `Generated at: ${new Date().toISOString()}`,
    `Last synced at: ${safe(lastSyncedAt)}`, `Courses: ${courses.length}`,
    `Sessions: ${sessions.length}`, `Groups: ${groups.size}`, `SubGroups: ${subgroups.size}`,
  ];
  summary.forEach((line, index) => doc.text(line, 25, 70 + index * 8));

  const ordered = [...sessions].sort((a, b) =>
    String(a.group_type).localeCompare(String(b.group_type)) || String(a.group_name).localeCompare(String(b.group_name), undefined, { numeric: true }) ||
    Number(a.day_week) - Number(b.day_week) || String(a.start_time).localeCompare(String(b.start_time)) || String(a.course_code).localeCompare(String(b.course_code))
  );
  let y = 20;
  let currentGroup = "";
  const rowHeight = 8;
  const headers = ["Course", "Title", "Type / Group", "Day", "Time", "Hall", "Instructor"];
  const widths = [24, 54, 34, 24, 35, 55, 50];
  const drawHeader = () => {
    doc.setFont("helvetica", "bold").setFontSize(8);
    let x = 8;
    headers.forEach((header, index) => { doc.rect(x, y, widths[index], rowHeight); doc.text(header, x + 1.5, y + 5); x += widths[index]; });
    y += rowHeight;
  };
  for (const session of ordered) {
    const groupKey = `${session.group_type}: ${session.group_name}`;
    if (groupKey !== currentGroup || y > 185) {
      doc.addPage("a4", "landscape"); y = 15; currentGroup = groupKey;
      doc.setFont("helvetica", "bold").setFontSize(13).text(groupKey, 8, y); y += 6; drawHeader();
    }
    const cells = [session.course_code, session.course_name, `${session.group_type} / ${session.group_name}`, session.day_name, session.raw_time, session.room_raw, session.staff];
    doc.setFont("helvetica", "normal").setFontSize(7);
    let x = 8;
    cells.forEach((cell, index) => {
      doc.rect(x, y, widths[index], rowHeight);
      const clipped = doc.splitTextToSize(safe(cell), widths[index] - 3)[0] || "—";
      doc.text(clipped, x + 1.5, y + 5); x += widths[index];
    });
    y += rowHeight;
  }
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page).setFontSize(8).setTextColor(90).text(`Page ${page} of ${pages}`, 287, 204, { align: "right" });
  }
  return { buffer: Buffer.from(doc.output("arraybuffer")), filename: `dentistry-level-${level}-${slug(semester)}-schedule.pdf` };
}
