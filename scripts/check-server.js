import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(dir, item.name);
    return item.isDirectory() ? files(full) : item.name.endsWith(".js") ? [full] : [];
  });
}

for (const file of [...files("server"), ...files("scripts")]) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status) process.exit(result.status);
}
console.log("Server JavaScript syntax check passed.");
