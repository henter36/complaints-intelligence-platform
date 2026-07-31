#!/usr/bin/env tsx
// Creates a timestamped backup of the SQLite database and import/report storage.
// Does NOT include .env, secrets, node_modules, or backups themselves.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  resolvePrismaSqlitePath,
  resolveSqliteDatabaseFiles,
  escapeSqliteDotCommandPath,
  isValidSqliteSnapshot,
} from "./lib/backup-utils";

const ROOT = path.resolve(__dirname, "..");
// Resolve the SQLite file relative to the prisma schema directory (Prisma semantics).
const DB_PATH = resolvePrismaSqlitePath(
  process.env.DATABASE_URL ?? "file:./dev.db",
  path.resolve(ROOT, "prisma")
);
const BACKUP_PATH = process.env.BACKUP_PATH ?? "./backups";
const IMPORT_STORAGE = process.env.IMPORT_STORAGE_PATH ?? "./storage/imports";
const REPORT_STORAGE = process.env.REPORT_STORAGE_PATH ?? "./storage/reports";

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha256Dir(dirPath: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  if (!fs.existsSync(dirPath)) return checksums;
  const walk = (dir: string, base: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full);
      if (rel.includes("..")) continue;
      if (entry.isDirectory()) walk(full, base);
      else checksums[rel] = sha256File(full);
    }
  };
  walk(dirPath, dirPath);
  return checksums;
}

function copyDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      console.warn(`Skipping symlink: ${entry.name}`);
      continue;
    }
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function tryCheckpointWal(dbSrc: string): boolean {
  const sqlite3Bin = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  const result = spawnSync(
    sqlite3Bin,
    [dbSrc, "PRAGMA wal_checkpoint(TRUNCATE);"],
    { shell: false, encoding: "utf8" }
  );
  return result.status === 0;
}

function backupDatabaseAtomic(dbSrc: string, dbDest: string): void {
  fs.mkdirSync(path.dirname(dbDest), { recursive: true });

  // Attempt WAL checkpoint so the hot journal is flushed before the .backup snapshot.
  const sqlite3Bin = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  const escapedDest = escapeSqliteDotCommandPath(dbDest);
  const backupResult = spawnSync(
    sqlite3Bin,
    [dbSrc, `.backup '${escapedDest}'`],
    { shell: false, encoding: "utf8" }
  );

  // Only trust the snapshot when the CLI succeeded AND the destination is a
  // valid, non-empty regular file with no failure text on stderr. Otherwise
  // fall back to a raw copy so a truncated/corrupt snapshot is never kept.
  if (backupResult.status === 0 && isValidSqliteSnapshot(dbDest, backupResult.stderr ?? "")) {
    console.log("Database backup via sqlite3 .backup (WAL-safe snapshot)");
    return;
  }

  // sqlite3 CLI unavailable or produced an invalid snapshot — fallback to raw copy.
  // Remove any partial snapshot before copying.
  if (fs.existsSync(dbDest)) fs.rmSync(dbDest, { force: true });

  // Attempt WAL checkpoint first to minimise open transactions.
  const files = resolveSqliteDatabaseFiles(dbSrc);
  tryCheckpointWal(dbSrc);

  fs.copyFileSync(files.main, dbDest);

  // Copy WAL and SHM sidecars that exist alongside the main database.
  // Omitting them when they exist would leave the restored database in an
  // inconsistent state on a WAL-mode SQLite.
  const walDest = `${dbDest}-wal`;
  const shmDest = `${dbDest}-shm`;
  if (fs.existsSync(files.wal)) {
    fs.copyFileSync(files.wal, walDest);
    console.log("Database WAL sidecar included in backup");
  }
  if (fs.existsSync(files.shm)) {
    fs.copyFileSync(files.shm, shmDest);
    console.log("Database SHM sidecar included in backup");
  }

  console.log("Database backup via file copy (sqlite3 CLI not available)");
}

function backupDatabase(dbSrc: string, dbDest: string): void {
  if (!fs.existsSync(dbSrc)) {
    // A missing database is a hard failure: never produce a partial backup or
    // print a success message for a backup that omits the database.
    throw new Error("Database file not found — aborting backup");
  }
  backupDatabaseAtomic(dbSrc, dbDest);
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupName = `backup-${ts}`;
  const backupDir = path.join(ROOT, BACKUP_PATH, backupName);

  console.log(`Creating backup: ${backupName}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const dbSrc = path.resolve(ROOT, DB_PATH);
  const dbDest = path.join(backupDir, "db", "database.sqlite");
  backupDatabase(dbSrc, dbDest);

  const importDest = path.join(backupDir, "storage", "imports");
  copyDir(path.resolve(ROOT, IMPORT_STORAGE), importDest);
  console.log("Import storage backed up");

  const reportDest = path.join(backupDir, "storage", "reports");
  copyDir(path.resolve(ROOT, REPORT_STORAGE), reportDest);
  console.log("Report storage backed up");

  const checksums: Record<string, string> = {};
  if (fs.existsSync(dbDest)) checksums["db/database.sqlite"] = sha256File(dbDest);
  // Include WAL/SHM checksums if they were backed up
  const walDest = `${dbDest}-wal`;
  const shmDest = `${dbDest}-shm`;
  if (fs.existsSync(walDest)) checksums["db/database.sqlite-wal"] = sha256File(walDest);
  if (fs.existsSync(shmDest)) checksums["db/database.sqlite-shm"] = sha256File(shmDest);

  Object.assign(checksums, Object.fromEntries(
    Object.entries(sha256Dir(importDest)).map(([k, v]) => [`storage/imports/${k}`, v])
  ));
  Object.assign(checksums, Object.fromEntries(
    Object.entries(sha256Dir(reportDest)).map(([k, v]) => [`storage/reports/${k}`, v])
  ));

  const manifest = {
    version: "1",
    backupName,
    createdAt: new Date().toISOString(),
    nodeVersion: process.version,
    // Store only the basename so the manifest never embeds an absolute path.
    dbPath: path.basename(DB_PATH),
    checksums,
    note: "Does not include .env, secrets, or node_modules.",
  };

  fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nBackup complete: ${backupName}`);
  console.log(`Files: ${Object.keys(checksums).length}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error("Backup failed:", msg);
  process.exit(1);
});
