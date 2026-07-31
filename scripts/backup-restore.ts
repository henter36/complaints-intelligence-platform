#!/usr/bin/env tsx
// Restores from a verified backup.
// REQUIRES --confirm flag to prevent accidental restores.
// Creates a pre-restore backup automatically.
// Does NOT restore .env or secrets.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const backupArg = args.find(a => !a.startsWith("--"));
const confirmed = args.includes("--confirm");

if (!backupArg) {
  console.error("Usage: tsx scripts/backup-restore.ts <backup-path> --confirm");
  console.error("  --confirm  Required to proceed with restore");
  process.exit(1);
}

if (!confirmed) {
  console.error("Restore requires --confirm flag. The system must be stopped during restore.");
  console.error("A pre-restore backup will be created automatically.");
  process.exit(1);
}

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.DATABASE_URL?.replace("file:", "") ?? "./prisma/dev.db";
const IMPORT_STORAGE = process.env.IMPORT_STORAGE_PATH ?? "./storage/imports";
const REPORT_STORAGE = process.env.REPORT_STORAGE_PATH ?? "./storage/reports";
const BACKUP_PATH = process.env.BACKUP_PATH ?? "./backups";

// SQLite WAL-mode databases can have up to three files.
interface SqliteDatabaseFiles {
  readonly main: string;
  readonly wal: string;
  readonly shm: string;
}

function resolveSqliteDatabaseFiles(databasePath: string): SqliteDatabaseFiles {
  return {
    main: databasePath,
    wal: `${databasePath}-wal`,
    shm: `${databasePath}-shm`,
  };
}

// Resolve the backup dir and validate it stays inside the backups root.
const BACKUPS_ROOT = path.resolve(ROOT, BACKUP_PATH);

function resolveBackupPath(input: string): string {
  const rawCandidate = path.resolve(BACKUPS_ROOT, input);
  const canonicalRoot = fs.existsSync(BACKUPS_ROOT)
    ? fs.realpathSync(BACKUPS_ROOT)
    : BACKUPS_ROOT;
  const candidate = fs.existsSync(rawCandidate)
    ? fs.realpathSync(rawCandidate)
    : rawCandidate;
  const rel = path.relative(canonicalRoot, candidate);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return candidate;
  }
  throw new Error("Backup path must remain inside the configured backup directory");
}

let backupDir: string;
try {
  backupDir = resolveBackupPath(backupArg);
} catch (err) {
  const msg = err instanceof Error ? err.message : "Invalid backup path";
  console.error(`Security: ${msg}`);
  process.exit(1);
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function copyDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) { console.warn(`Skipping symlink: ${entry.name}`); continue; }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

const tsxBin = path.resolve(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);

const SAFE_PATH = process.platform === "win32"
  ? (process.env.PATH ?? "")
  : "/usr/local/bin:/usr/bin:/bin";

function buildAllowedEnv(): Record<string, string | undefined> {
  return {
    PATH: SAFE_PATH,
    DATABASE_URL: process.env.DATABASE_URL,
    BACKUP_PATH: process.env.BACKUP_PATH,
    IMPORT_STORAGE_PATH: process.env.IMPORT_STORAGE_PATH,
    REPORT_STORAGE_PATH: process.env.REPORT_STORAGE_PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV,
  };
}

function removeSidecarsIfPresent(files: SqliteDatabaseFiles): void {
  // Remove stale WAL/SHM before restoring so no old data mixes with
  // the restored main database.
  if (fs.existsSync(files.wal)) fs.rmSync(files.wal, { force: true });
  if (fs.existsSync(files.shm)) fs.rmSync(files.shm, { force: true });
}

async function main() {
  if (!fs.existsSync(backupDir)) {
    console.error("Backup directory not found");
    process.exit(1);
  }

  const manifestPath = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("manifest.json not found — backup corrupt.");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    checksums: Record<string, string>;
    backupName: string;
    createdAt: string;
  };

  // Verify checksums first
  console.log("Verifying backup integrity...");
  for (const [relPath, expectedHash] of Object.entries(manifest.checksums)) {
    const normalized = path.normalize(relPath);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      console.error("SECURITY: path traversal in manifest");
      process.exit(1);
    }
    const fullPath = path.join(backupDir, normalized);
    if (!fs.existsSync(fullPath)) {
      console.error(`MISSING file: ${path.basename(normalized)}`);
      process.exit(1);
    }
    if (sha256File(fullPath) !== expectedHash) {
      console.error(`CHECKSUM MISMATCH: ${path.basename(normalized)} — aborting restore.`);
      process.exit(1);
    }
  }
  console.log("✓ Integrity verified");

  // Create pre-restore backup using explicit binary and minimal env
  console.log("Creating pre-restore backup...");
  const backupResult = spawnSync(
    tsxBin,
    [path.join(ROOT, "scripts", "backup-create.ts")],
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
      env: buildAllowedEnv() as NodeJS.ProcessEnv,
    }
  );
  if (backupResult.status !== 0) {
    console.warn("Pre-restore backup failed — proceeding (manual backup recommended).");
  }

  // Restore database
  const dbDest = path.resolve(ROOT, DB_PATH);
  const dbSrc = path.join(backupDir, "db", "database.sqlite");
  if (fs.existsSync(dbSrc)) {
    fs.mkdirSync(path.dirname(dbDest), { recursive: true });

    // Remove stale sidecars BEFORE restoring the main file to prevent
    // SQLite from merging old WAL data into the freshly restored database.
    const destFiles = resolveSqliteDatabaseFiles(dbDest);
    removeSidecarsIfPresent(destFiles);

    // Restore main database
    fs.copyFileSync(dbSrc, dbDest);

    // Restore WAL/SHM sidecars if they were present in the backup
    const srcFiles = resolveSqliteDatabaseFiles(dbSrc);
    if (fs.existsSync(srcFiles.wal)) {
      fs.copyFileSync(srcFiles.wal, destFiles.wal);
      console.log("✓ WAL sidecar restored");
    }
    if (fs.existsSync(srcFiles.shm)) {
      fs.copyFileSync(srcFiles.shm, destFiles.shm);
      console.log("✓ SHM sidecar restored");
    }

    console.log("✓ Database restored");
  }

  // Restore import storage
  const importSrc = path.join(backupDir, "storage", "imports");
  const importDest = path.resolve(ROOT, IMPORT_STORAGE);
  if (fs.existsSync(importSrc)) {
    fs.rmSync(importDest, { recursive: true, force: true });
    copyDir(importSrc, importDest);
    console.log("✓ Import storage restored");
  }

  // Restore report storage
  const reportSrc = path.join(backupDir, "storage", "reports");
  const reportDest = path.resolve(ROOT, REPORT_STORAGE);
  if (fs.existsSync(reportSrc)) {
    fs.rmSync(reportDest, { recursive: true, force: true });
    copyDir(reportSrc, reportDest);
    console.log("✓ Report storage restored");
  }

  console.log(`\n✓ Restore complete from: ${manifest.backupName} (${manifest.createdAt})`);
  console.log("Note: .env and secrets were NOT restored. Restart the application to apply changes.");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error("Restore failed:", msg);
  process.exit(1);
});
