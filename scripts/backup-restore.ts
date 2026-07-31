#!/usr/bin/env tsx
// Restores from a verified backup.
// REQUIRES --confirm flag to prevent accidental restores.
// Creates a pre-restore backup automatically.
// Does NOT restore .env or secrets.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  resolveSqliteDatabaseFiles,
  buildAllowedEnv,
  getSafePath,
  type SqliteDatabaseFiles,
} from "./lib/backup-utils";

const args = process.argv.slice(2);
const backupArg = args.find(a => !a.startsWith("--"));
const confirmed = args.includes("--confirm");
const allowWithoutSafetyBackup = args.includes("--allow-without-safety-backup");

if (!backupArg) {
  console.error("Usage: tsx scripts/backup-restore.ts <backup-path> --confirm [--allow-without-safety-backup]");
  console.error("  --confirm                       Required to proceed with restore");
  console.error("  --allow-without-safety-backup   Continue even if the pre-restore safety backup fails");
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

interface BackupManifest {
  readonly checksums: Record<string, string>;
  readonly backupName: string;
  readonly createdAt: string;
}

function removeSidecarsIfPresent(files: SqliteDatabaseFiles): void {
  // Remove stale WAL/SHM before restoring so no old data mixes with
  // the restored main database.
  if (fs.existsSync(files.wal)) fs.rmSync(files.wal, { force: true });
  if (fs.existsSync(files.shm)) fs.rmSync(files.shm, { force: true });
}

// Extracted to reduce cognitive complexity of main().
// Verifies all entries in manifest.checksums; calls process.exit on any failure.
function verifyAllChecksums(dir: string, manifest: BackupManifest): void {
  for (const [relPath, expectedHash] of Object.entries(manifest.checksums)) {
    const normalized = path.normalize(relPath);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      console.error("SECURITY: path traversal in manifest");
      process.exit(1);
    }
    const fullPath = path.join(dir, normalized);
    if (!fs.existsSync(fullPath)) {
      console.error(`MISSING file: ${path.basename(normalized)}`);
      process.exit(1);
    }
    if (sha256File(fullPath) !== expectedHash) {
      console.error(`CHECKSUM MISMATCH: ${path.basename(normalized)} — aborting restore.`);
      process.exit(1);
    }
  }
}

// Restores database main file plus WAL/SHM sidecars if present in backup.
// Removes stale destination sidecars first to prevent state mixing.
function restoreDatabase(dir: string, dbDest: string): void {
  const dbSrc = path.join(dir, "db", "database.sqlite");
  if (!fs.existsSync(dbSrc)) return;

  fs.mkdirSync(path.dirname(dbDest), { recursive: true });

  const destFiles = resolveSqliteDatabaseFiles(dbDest);
  removeSidecarsIfPresent(destFiles);

  fs.copyFileSync(dbSrc, dbDest);

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

// Restores a storage directory from backup; no-op if source is absent.
function restoreStorageDirectory(
  dir: string,
  srcSubPath: string,
  destPath: string,
  label: string
): void {
  const src = path.join(dir, srcSubPath);
  if (!fs.existsSync(src)) return;
  fs.rmSync(destPath, { recursive: true, force: true });
  copyDir(src, destPath);
  console.log(`✓ ${label} restored`);
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

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;

  console.log("Verifying backup integrity...");
  verifyAllChecksums(backupDir, manifest);
  console.log("✓ Integrity verified");

  console.log("Creating pre-restore backup...");
  const backupResult = spawnSync(
    tsxBin,
    [path.join(ROOT, "scripts", "backup-create.ts")],
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
      env: buildAllowedEnv(process.env, getSafePath()) as NodeJS.ProcessEnv,
    }
  );
  if (backupResult.status !== 0) {
    if (!allowWithoutSafetyBackup) {
      throw new Error("Pre-restore safety backup failed. Restore aborted. Use --allow-without-safety-backup to override.");
    }
    console.warn("Proceeding without a safety backup because the explicit override flag was provided.");
  }

  restoreDatabase(backupDir, path.resolve(ROOT, DB_PATH));
  restoreStorageDirectory(backupDir, "storage/imports", path.resolve(ROOT, IMPORT_STORAGE), "Import storage");
  restoreStorageDirectory(backupDir, "storage/reports", path.resolve(ROOT, REPORT_STORAGE), "Report storage");

  console.log(`\n✓ Restore complete from: ${manifest.backupName} (${manifest.createdAt})`);
  console.log("Note: .env and secrets were NOT restored. Restart the application to apply changes.");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error("Restore failed:", msg);
  process.exit(1);
});
