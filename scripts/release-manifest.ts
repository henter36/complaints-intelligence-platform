#!/usr/bin/env tsx
// Generates release-manifest.json with build metadata.
// Does NOT include secrets, passwords, or sensitive paths.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(__dirname, "..");

function run(cmd: string, fallback = ""): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return fallback;
  }
}

function countFiles(dir: string, ext: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (entry.name.endsWith(ext)) count++;
    }
  };
  walk(dir);
  return count;
}

// Returns migration directories only (excludes files like migration_lock.toml).
function listMigrationDirectories(migrationsRoot: string): string[] {
  if (!fs.existsSync(migrationsRoot)) return [];
  return fs.readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    version: string;
    dependencies: Record<string, string>;
  };

  const commitSha = run("git rev-parse HEAD");
  const buildTime = new Date().toISOString();
  const nodeVersion = process.version;
  const npmVersion = run("npm --version", "unknown");
  const prismaVersion = pkg.dependencies?.prisma ?? pkg.dependencies?.["@prisma/client"] ?? "unknown";

  const migrationsDir = path.join(ROOT, "prisma", "migrations");
  const migrationDirs = listMigrationDirectories(migrationsDir);
  const migrationCount = migrationDirs.length;
  const latestMigration = migrationDirs.at(-1) ?? "none";

  const testCount = countFiles(path.join(ROOT, "src"), ".test.ts")
    + countFiles(path.join(ROOT, "src"), ".test.tsx")
    + countFiles(path.join(ROOT, "scripts"), ".test.ts");

  const artifactChecksums: Record<string, string> = {};
  const buildDir = path.join(ROOT, ".next");
  if (fs.existsSync(path.join(buildDir, "BUILD_ID"))) {
    const buildId = fs.readFileSync(path.join(buildDir, "BUILD_ID"), "utf8").trim();
    artifactChecksums["BUILD_ID"] = crypto.createHash("sha256").update(buildId).digest("hex");
  }

  const manifest = {
    version: pkg.version,
    commitSha,
    buildTime,
    nodeVersion,
    npmVersion,
    prismaVersion,
    databaseProvider: "sqlite",
    migrationCount,
    latestMigration,
    testCount,
    artifactChecksums,
  };

  const outPath = path.join(ROOT, "release-manifest.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Release manifest written to: ${outPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error("Release manifest generation failed:", msg);
  process.exit(1);
});
