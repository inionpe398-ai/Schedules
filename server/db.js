import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storageDir = path.join(root, "storage");
fs.mkdirSync(storageDir, { recursive: true });
export const db = new DatabaseSync(process.env.SCHEDULE_DB_PATH || path.join(storageDir, "schedules.sqlite"));
db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");

export function migrate() {
  const dir = path.join(root, "server", "migrations");
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    db.prepare("INSERT OR IGNORE INTO app_migrations(name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  }
}

export function json(value, fallback = null) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
