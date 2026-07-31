#!/usr/bin/env tsx
// Creates a timestamped backup of the SQLite database and import/report storage.
// Does NOT include .env, secrets, node_modules, or backups themselves.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.DATABASE_URL?.replace("file:", "") ?? "./prisma/dev.db";
const BACKUP_PATH = process.env.BACKUP_PATH ?? "./backups";
const IMPORT_STORAGE = process.env.IMPORT_STORAGE_PATH ?? "./storage/imports";
const REPORT_STORAGE = process.env.REPORT_STORAGE_PATH ?? "./storage/reports";

// SQLite WAL-mode databases can have up to three files.
// All three must be backed up together to avoid a corrupt restore.
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
  const backupResult = spawnSync(
    sqlite3Bin,
    [dbSrc, `.backup '${dbDest}'`],
    { shell: false, encoding: "utf8" }
  );

  if (backupResult.status === 0) {
    console.log("Database backup via sqlite3 .backup (WAL-safe snapshot)");
    return;
  }

  // sqlite3 CLI unavailable — fallback to raw copy.
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
    console.warn("Database file not found — skipping database backup");
    return;
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
    dbPath: DB_PATH,
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
