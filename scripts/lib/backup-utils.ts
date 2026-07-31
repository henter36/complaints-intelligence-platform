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

export function getSafePath(): string {
  return process.platform === "win32"
    ? (process.env.PATH ?? "")
    : "/usr/local/bin:/usr/bin:/bin";
}

export function buildAllowedEnv(
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

export function resolveBackupPath(backupsRoot: string, input: string): string {
  const canonicalRoot = fs.existsSync(backupsRoot)
    ? fs.realpathSync(backupsRoot)
    : backupsRoot;
  const rawCandidate = path.resolve(canonicalRoot, input);
  let candidate: string;
  try {
    candidate = fs.existsSync(rawCandidate)
      ? fs.realpathSync(rawCandidate)
      : rawCandidate;
  } catch {
    throw new Error("Backup directory not found");
  }
  const rel = path.relative(canonicalRoot, candidate);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return candidate;
  }
  throw new Error("Backup path must remain inside the configured backup directory");
}

export const SHA256_PATTERN = /\b[a-f0-9]{64}\b/gi;

// Control characters (newline, carriage return, tab, null bytes, DEL) and secret-assignment
// patterns that must never appear in log output derived from untrusted manifest values.
const LOG_CONTROL_CHARACTERS = /[\r\n\t\u0000-\u001f\u007f]/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:AUTH_SECRET|DATABASE_URL|OPENAI_API_KEY|TOKEN|PASSWORD)\s*=\s*\S+/gi;

export function sanitizeLogValue(value: string): string {
  return value
    .replace(LOG_CONTROL_CHARACTERS, " ")
    .replace(SECRET_ASSIGNMENT_PATTERN, "<redacted>")
    .trim();
}

// Minimal manifest shape needed by toSafeBackupMetadata —
// only the `checksums` field is required (backupName comes from the trusted filesystem path).
export interface BackupManifestLike {
  readonly checksums: Record<string, string>;
}

export type SafeBackupMetadata = Readonly<{
  backupName: string;
  fileCount: number;
}>;

export function toSafeBackupMetadata(
  verifiedPath: string,
  manifest: BackupManifestLike
): SafeBackupMetadata {
  return {
    backupName: sanitizeLogValue(path.basename(verifiedPath)),
    fileCount: Object.keys(manifest.checksums).length,
  };
}

export function formatBackupMetadataLog(meta: SafeBackupMetadata): string {
  return `Backup: ${meta.backupName} | Files to verify: ${meta.fileCount}`;
}

export function sanitizeLogMessage(
  message: string,
  opts: {
    databaseUrl?: string;
    backupsRoot?: string;
    projectRoot?: string;
  }
): string {
  let msg = message;
  const { databaseUrl, backupsRoot, projectRoot } = opts;
  if (databaseUrl) msg = msg.replaceAll(databaseUrl, "<database-url>");
  const dbPath = databaseUrl?.startsWith("file:")
    ? databaseUrl.slice("file:".length)
    : undefined;
  if (dbPath && dbPath !== databaseUrl) msg = msg.replaceAll(dbPath, "<database>");
  if (backupsRoot) msg = msg.replaceAll(backupsRoot, "<backups>");
  if (projectRoot) msg = msg.replaceAll(projectRoot, "<project>");
  msg = msg.replace(SHA256_PATTERN, "<checksum>");
  return msg;
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
