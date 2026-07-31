// Unit tests for hardening logic extracted from operational scripts.
// These verify path canonicalization, directory filtering, and env isolation
// without spinning up subprocesses.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ──────────────────────────────────────────────────
// resolveBackupPath — mirrors scripts/backup-verify.ts and backup-restore.ts
// ──────────────────────────────────────────────────

function resolveBackupPath(backupsRoot: string, input: string): string {
  const canonicalRoot = fs.existsSync(backupsRoot)
    ? fs.realpathSync(backupsRoot)
    : backupsRoot;
  const rawCandidate = path.resolve(canonicalRoot, input);
  let candidate: string;
  try {
    candidate = fs.existsSync(rawCandidate) ? fs.realpathSync(rawCandidate) : rawCandidate;
  } catch {
    throw new Error("Backup directory not found");
  }
  const rel = path.relative(canonicalRoot, candidate);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return candidate;
  }
  throw new Error("Backup path must remain inside the configured backup directory");
}

describe("resolveBackupPath — path traversal prevention", () => {
  let tmpRoot: string;

  beforeEach(() => {
    // realpathSync resolves /var → /private/var on macOS (symlink)
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-")));
    fs.mkdirSync(path.join(tmpRoot, "good-backup"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves a valid subdirectory inside the root", () => {
    const result = resolveBackupPath(tmpRoot, "good-backup");
    expect(result).toBe(path.join(tmpRoot, "good-backup"));
  });

  it("throws for ../ traversal to parent", () => {
    expect(() => resolveBackupPath(tmpRoot, "../../../etc")).toThrow(
      "Backup path must remain inside"
    );
  });

  it("throws when input resolves to the root itself", () => {
    expect(() => resolveBackupPath(tmpRoot, ".")).toThrow(
      "Backup path must remain inside"
    );
  });

  it("throws for absolute path outside the root", () => {
    expect(() => resolveBackupPath(tmpRoot, "/tmp/evil")).toThrow(
      "Backup path must remain inside"
    );
  });

  it("throws for a path that escapes after normalization", () => {
    expect(() => resolveBackupPath(tmpRoot, "good-backup/../../outside")).toThrow(
      "Backup path must remain inside"
    );
  });
});

// ──────────────────────────────────────────────────
// listMigrationDirectories — mirrors scripts/release-manifest.ts
// ──────────────────────────────────────────────────

function listMigrationDirectories(migrationsRoot: string): string[] {
  if (!fs.existsSync(migrationsRoot)) return [];
  return fs
    .readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

describe("listMigrationDirectories — excludes files, includes only dirs", () => {
  let tmpMigrations: string;

  beforeEach(() => {
    tmpMigrations = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-")));
    fs.mkdirSync(path.join(tmpMigrations, "20240101_initial"));
    fs.mkdirSync(path.join(tmpMigrations, "20240202_add_complaints"));
    fs.writeFileSync(path.join(tmpMigrations, "migration_lock.toml"), "[provider]\nprovider = \"sqlite\"");
    fs.writeFileSync(path.join(tmpMigrations, "README.md"), "# Migrations");
  });

  afterEach(() => {
    fs.rmSync(tmpMigrations, { recursive: true, force: true });
  });

  it("returns only directory names, sorted ascending", () => {
    const dirs = listMigrationDirectories(tmpMigrations);
    expect(dirs).toEqual(["20240101_initial", "20240202_add_complaints"]);
  });

  it("does not include migration_lock.toml", () => {
    const dirs = listMigrationDirectories(tmpMigrations);
    expect(dirs).not.toContain("migration_lock.toml");
  });

  it("does not include README.md", () => {
    const dirs = listMigrationDirectories(tmpMigrations);
    expect(dirs).not.toContain("README.md");
  });

  it("latestMigration is the last directory alphabetically, not a file", () => {
    const dirs = listMigrationDirectories(tmpMigrations);
    const latest = dirs.at(-1) ?? "none";
    expect(latest).toBe("20240202_add_complaints");
  });

  it("returns empty array when directory does not exist", () => {
    const dirs = listMigrationDirectories("/nonexistent/path/migrations");
    expect(dirs).toEqual([]);
  });
});

// ──────────────────────────────────────────────────
// buildAllowedEnv — mirrors scripts/backup-restore.ts
// ──────────────────────────────────────────────────

function buildAllowedEnv(
  env: Record<string, string | undefined>,
  safePath: string
): Record<string, string | undefined> {
  return {
    PATH: safePath,
    DATABASE_URL: env.DATABASE_URL,
    BACKUP_PATH: env.BACKUP_PATH,
    IMPORT_STORAGE_PATH: env.IMPORT_STORAGE_PATH,
    REPORT_STORAGE_PATH: env.REPORT_STORAGE_PATH,
    HOME: env.HOME,
    NODE_ENV: env.NODE_ENV,
  };
}

describe("buildAllowedEnv — minimal environment for subprocess", () => {
  it("only passes the expected keys", () => {
    const fakeEnv: Record<string, string | undefined> = {
      DATABASE_URL: "file:./test.db",
      BACKUP_PATH: "./backups",
      IMPORT_STORAGE_PATH: "./storage/imports",
      REPORT_STORAGE_PATH: "./storage/reports",
      HOME: "/home/user",
      NODE_ENV: "production",
      AWS_SECRET_ACCESS_KEY: "should-not-appear",
      OPENAI_API_KEY: "sk-should-not-appear",
      AUTH_SECRET: "auth-should-not-appear",
    };
    const result = buildAllowedEnv(fakeEnv, "/usr/bin:/bin");
    const keys = Object.keys(result);

    // Must include only the safe allow-list
    expect(keys).toContain("PATH");
    expect(keys).toContain("DATABASE_URL");
    expect(keys).toContain("NODE_ENV");

    // Must NOT forward sensitive keys not on the allow-list
    expect(result).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).not.toHaveProperty("AUTH_SECRET");

    // Must not contain any sk- style API key values
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-should-not-appear");
    expect(serialized).not.toContain("auth-should-not-appear");
  });

  it("uses the provided safe PATH, not the inherited one", () => {
    const result = buildAllowedEnv({}, "/usr/local/bin:/usr/bin:/bin");
    expect(result.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});
