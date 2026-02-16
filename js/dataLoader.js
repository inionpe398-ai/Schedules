const DATA_FOLDER = "./data";

function normalizeCourseName(fileName) {
  return fileName
    .replace(/\.json$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function isJsonLink(href) {
  return typeof href === "string" && href.toLowerCase().endsWith(".json");
}

async function loadManifestList() {
  const response = await fetch(`${DATA_FOLDER}/manifest.json`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  const manifest = await response.json();
  if (!Array.isArray(manifest.files)) {
    return null;
  }

  return manifest.files.filter((f) => typeof f === "string" && f.toLowerCase().endsWith(".json"));
}

async function parseDirectoryListing() {
  const response = await fetch(`${DATA_FOLDER}/`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const links = Array.from(doc.querySelectorAll("a"));

  const files = links
    .map((link) => link.getAttribute("href"))
    .filter(isJsonLink)
    .filter((name) => !name.toLowerCase().endsWith("manifest.json"));

  return files.length ? files : null;
}

export async function listCourseFiles() {
  const manifestFiles = await loadManifestList();
  if (manifestFiles?.length) {
    return manifestFiles;
  }

  const directoryFiles = await parseDirectoryListing();
  if (directoryFiles?.length) {
    return directoryFiles;
  }

  throw new Error(
    "No course files found. Add .json files in /data and include data/manifest.json or run from a server that exposes directory listing."
  );
}

export async function loadAllCourses() {
  const fileNames = await listCourseFiles();
  const courses = [];

  for (const fileName of fileNames) {
    const response = await fetch(`${DATA_FOLDER}/${fileName}`, { cache: "no-store" });
    if (!response.ok) {
      // Skip missing files listed in manifest.
      continue;
    }

    const rawGroups = await response.json();
    if (!Array.isArray(rawGroups)) {
      continue;
    }

    courses.push({
      id: fileName.replace(/\.json$/i, ""),
      fileName,
      name: normalizeCourseName(fileName),
      groups: rawGroups,
    });
  }

  return courses;
}
