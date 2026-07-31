import path from "node:path";
import fs from "node:fs";

export interface SqliteDatabaseFiles {
  readonly main: string;
  readonly wal: string;
  readonly shm: string;
}

export function resolveSqliteDatabaseFiles(databasePath: string): SqliteDatabaseFiles {
  return {
    main: databasePath,
    wal: `${databasePath}-wal`,
    shm: `${databasePath}-shm`,
  };
}

export function resolvePrismaSqlitePath(
  databaseUrl: string,
  schemaDirectory: string
): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("Only SQLite file DATABASE_URL values are supported");
  }
  const rawPath = databaseUrl.slice("file:".length);
  const pathWithoutQuery = rawPath.split("?")[0];
  if (!pathWithoutQuery) {
    throw new Error("DATABASE_URL does not contain a SQLite file path");
  }
  return path.isAbsolute(pathWithoutQuery)
    ? path.normalize(pathWithoutQuery)
    : path.resolve(schemaDirectory, pathWithoutQuery);
}

export function buildAllowedEnv(): Record<string, string | undefined> {
  const SAFE_PATH = process.platform === "win32"
    ? (process.env.PATH ?? "")
    : "/usr/local/bin:/usr/bin:/bin";
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

export function escapeSqliteDotCommandPath(filePath: string): string {
  return filePath.replaceAll("'", "''");
}

// Verifies that a sqlite3 `.backup` snapshot produced a usable file:
// destination exists, is a regular file, is non-empty, and stderr shows no failure.
export function isValidSqliteSnapshot(destPath: string, stderr: string): boolean {
  if (!fs.existsSync(destPath)) return false;
  const stat = fs.statSync(destPath);
  if (!stat.isFile() || stat.size <= 0) return false;
  const lowered = (stderr ?? "").toLowerCase();
  return !lowered.includes("error") && !lowered.includes("malformed") && !lowered.includes("unable to");
}
