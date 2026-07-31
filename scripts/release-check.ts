#!/usr/bin/env tsx
// Pre-release validation checklist.
// Read-only: checks configuration, git state, and manifest existence.
// Does not modify the project.

import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");

type CheckStatus = "pass" | "fail" | "warn";
interface CheckResult { name: string; status: CheckStatus; detail?: string; }
const results: CheckResult[] = [];

function pass(name: string, detail?: string) { results.push({ name, status: "pass", detail }); }
function fail(name: string, detail: string) { results.push({ name, status: "fail", detail }); }
function warn(name: string, detail: string) { results.push({ name, status: "warn", detail }); }

function run(cmd: string, fallback = ""): string {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim(); } catch { return fallback; }
}

function runFile(file: string, fileArgs: string[], fallback = ""): string {
  try {
    return execFileSync(file, fileArgs, { cwd: ROOT, encoding: "utf8", shell: false }).trim();
  } catch { return fallback; }
}

function resultSymbol(status: CheckStatus): string {
  if (status === "pass") return "✓";
  if (status === "warn") return "⚠";
  return "✗";
}

function formatCheckLine(result: CheckResult): string {
  const symbol = resultSymbol(result.status);
  const detail = result.detail ? ` — ${result.detail}` : "";
  return `${symbol} ${result.name}${detail}`;
}

function checkEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) { warn("env_file", ".env not found — using defaults"); return; }
  const content = fs.readFileSync(envPath, "utf8");
  const placeholders = ["CHANGE_ME", "your-secret", "replace-me", "placeholder"];
  for (const p of placeholders) {
    if (content.includes(p)) {
      fail("env_placeholders", `Found placeholder value "${p}" in .env`);
      return;
    }
  }
  pass("env_placeholders");
}

function checkTrackedSecrets() {
  const tracked = run("git ls-files .env .env.admin 2>/dev/null");
  if (tracked.trim()) {
    fail("tracked_secrets", `.env or .env.admin is tracked by git: ${tracked}`);
  } else {
    pass("tracked_secrets");
  }
}

function checkTrackedDb() {
  const tracked = run("git ls-files prisma/*.db prisma/*.sqlite");
  if (tracked.trim()) {
    fail("tracked_database", `Database file tracked by git: ${tracked}`);
  } else {
    pass("tracked_database");
  }
}

function checkTrackedUploads() {
  const tracked = run("git ls-files storage/");
  if (tracked.trim()) {
    fail("tracked_uploads", `Storage files tracked by git: ${tracked.split("\n").slice(0, 3).join(", ")}`);
  } else {
    pass("tracked_uploads");
  }
}

function checkTrackedBackups() {
  const tracked = run("git ls-files backups/");
  if (tracked.trim()) {
    fail("tracked_backups", `Backup files tracked by git: ${tracked}`);
  } else {
    pass("tracked_backups");
  }
}

function checkUncommittedChanges() {
  const status = run("git status --porcelain");
  if (status.trim()) {
    fail("uncommitted_changes", `Uncommitted changes detected:\n${status.slice(0, 200)}`);
  } else {
    pass("uncommitted_changes");
  }
}

function checkManifest() {
  const manifestPath = path.join(ROOT, "release-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail("release_manifest", "release-manifest.json not found — run: npm run release:manifest");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version: string; commitSha: string };
  if (!manifest.version || !manifest.commitSha) {
    fail("release_manifest", "release-manifest.json is incomplete");
    return;
  }
  const currentCommit = runFile("git", ["rev-parse", "HEAD"]);
  if (!currentCommit) {
    warn("release_manifest", `v${manifest.version} @ ${manifest.commitSha.slice(0, 8)} (git unavailable, cannot verify HEAD match)`);
    return;
  }
  if (manifest.commitSha !== currentCommit) {
    fail("release_manifest", `Release manifest commit does not match HEAD (manifest: ${manifest.commitSha.slice(0, 8)}, HEAD: ${currentCommit.slice(0, 8)})`);
    return;
  }
  pass("release_manifest", `v${manifest.version} @ ${manifest.commitSha.slice(0, 8)}`);
}

function checkPrismaSchema() {
  const schemaPath = path.join(ROOT, "prisma", "schema.prisma");
  if (!fs.existsSync(schemaPath)) { fail("prisma_schema", "schema.prisma not found"); return; }
  pass("prisma_schema");
}

function checkGitignore() {
  const gitignorePath = path.join(ROOT, ".gitignore");
  if (!fs.existsSync(gitignorePath)) { fail("gitignore", ".gitignore not found"); return; }
  const content = fs.readFileSync(gitignorePath, "utf8");
  const required = [".env", "*.db", "*.sqlite", "storage/", "backups/"];
  let anyMissing = false;
  for (const r of required) {
    if (!content.includes(r)) {
      fail("gitignore", `${r} missing from .gitignore`);
      anyMissing = true;
    }
  }
  if (!anyMissing) {
    pass("gitignore", "Required entries present");
  }
}

function checkStorageDirectories() {
  const dirs = [
    process.env.IMPORT_STORAGE_PATH ?? "./storage/imports",
    process.env.REPORT_STORAGE_PATH ?? "./storage/reports",
  ];
  for (const dir of dirs) {
    const full = path.resolve(ROOT, dir);
    if (!fs.existsSync(full)) {
      warn("storage_directories", `Storage dir missing (will be created on first use): ${path.basename(dir)}`);
    } else {
      try {
        fs.accessSync(full, fs.constants.R_OK | fs.constants.W_OK);
        pass("storage_directories", path.basename(dir));
      } catch {
        fail("storage_directories", `Storage dir not writable: ${path.basename(dir)}`);
      }
    }
  }
}

const REQUIRED_NODE_MAJOR = 24;

function checkNodeVersion() {
  const version = process.version;
  const major = Number.parseInt(version.slice(1).split(".")[0] ?? "0", 10);
  if (major !== REQUIRED_NODE_MAJOR) {
    fail("node_version", `Node ${version} — requires Node ${REQUIRED_NODE_MAJOR}.x`);
  } else {
    pass("node_version", version);
  }
}

async function main() {
  console.log("Release Check\n" + "═".repeat(60));

  checkEnvFile();
  checkTrackedSecrets();
  checkTrackedDb();
  checkTrackedUploads();
  checkTrackedBackups();
  checkUncommittedChanges();
  checkManifest();
  checkPrismaSchema();
  checkGitignore();
  checkStorageDirectories();
  checkNodeVersion();

  const failures = results.filter(r => r.status === "fail");
  const warnings = results.filter(r => r.status === "warn");
  const passes = results.filter(r => r.status === "pass");

  for (const r of results) {
    console.log(formatCheckLine(r));
  }

  console.log("═".repeat(60));
  console.log(`${passes.length} passed  |  ${warnings.length} warnings  |  ${failures.length} failures`);

  if (failures.length > 0) {
    console.error("\n✗ Release check failed. Fix the above issues before releasing.");
    process.exit(1);
  } else if (warnings.length > 0) {
    console.warn("\n⚠ Release check passed with warnings.");
  } else {
    console.log("\n✓ All checks passed. System appears ready for v1.0.0 release.");
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error("Release check error:", msg);
  process.exit(1);
});
