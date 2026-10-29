import { execSync } from "child_process";
import fs from "fs";
import path from "path";

let cachedVersion = "0.2.172";
try {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.version) cachedVersion = pkg.version;
  }
} catch {
  // fallback
}

let cachedCommit = "unknown";
let cachedCommitDate = "";

try {
  cachedCommit = execSync("git rev-parse --short HEAD", { stdio: ["pipe", "pipe", "ignore"] })
    .toString()
    .trim();
  cachedCommitDate = execSync("git log -1 --format=%cd --date=iso", { stdio: ["pipe", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  // Graceful fallback if git is not available in environment
  cachedCommit = process.env.GIT_COMMIT || "prod";
  cachedCommitDate = process.env.BUILD_DATE || new Date().toISOString();
}

export interface VersionInfo {
  version: string;
  commit: string;
  commitDate: string;
  buildTime: string;
}

export const APP_VERSION_INFO: VersionInfo = {
  version: cachedVersion,
  commit: cachedCommit,
  commitDate: cachedCommitDate,
  buildTime: new Date().toISOString(),
};
