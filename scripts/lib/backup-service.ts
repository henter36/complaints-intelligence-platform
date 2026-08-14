import crypto from "node:crypto";
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  escapeSqliteDotCommandPath,
  formatBackupMetadataLog,
  isValidSqliteSnapshot,
  resolveBackupPath,
  resolvePrismaSqlitePath,
  resolveSqliteDatabaseFiles,
  toSafeBackupMetadata,
} from "./backup-utils";

const MAX_MANIFEST_SIZE = 10 * 1024 * 1024;
const SQLITE_EXECUTABLES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/usr/bin/sqlite3",
  linux: "/usr/bin/sqlite3",
  win32: "C:\\Windows\\System32\\sqlite3.exe",
};

export type BackupLogger = Pick<Console, "log" | "warn" | "error">;

export type BackupServiceOptions = {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  logger?: BackupLogger;
  now?: Date;
  spawnSync?: typeof nodeSpawnSync;
};

export type BackupCreationResult = {
  backupName: string;
  fileCount: number;
};

export type BackupVerificationResult = {
  backupName: string;
  fileCount: number;
  ok: number;
  errors: number;
};

export type VerifiedBackupResult = {
  backupName: string;
  verified: true;
};

export type BackupManifest = {
  readonly version: string;
  readonly checksums: Record<string, string>;
  readonly createdAt: string;
  readonly backupName: string;
};

type BackupSettings = {
  projectRoot: string;
  backupsRoot: string;
  databasePath: string;
  importStoragePath: string;
  reportStoragePath: string;
  logger: BackupLogger;
  now: Date;
  spawnSync: typeof nodeSpawnSync;
  env: NodeJS.ProcessEnv;
};

function resolveSettings(options: BackupServiceOptions = {}): BackupSettings {
  const projectRoot = options.projectRoot ?? path.resolve(__dirname, "../..");
  const env = options.env ?? process.env;
  const databasePath = resolvePrismaSqlitePath(
    env.DATABASE_URL ?? "file:./dev.db",
    path.resolve(projectRoot, "prisma")
  );
  return {
    projectRoot,
    backupsRoot: path.resolve(projectRoot, env.BACKUP_PATH ?? "./backups"),
    databasePath,
    importStoragePath: path.resolve(projectRoot, env.IMPORT_STORAGE_PATH ?? "./storage/imports"),
    reportStoragePath: path.resolve(projectRoot, env.REPORT_STORAGE_PATH ?? "./storage/reports"),
    logger: options.logger ?? console,
    now: options.now ?? new Date(),
    spawnSync: options.spawnSync ?? nodeSpawnSync,
    env,
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Dir(directoryPath: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  if (!fs.existsSync(directoryPath)) return checksums;

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(directoryPath, fullPath);
      if (relativePath.includes("..")) continue;
      if (entry.isDirectory()) walk(fullPath);
      else checksums[relativePath] = sha256File(fullPath);
    }
  };
  walk(directoryPath);
  return checksums;
}

function copyDirectory(source: string, destination: string, logger: BackupLogger): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      logger.warn(`Skipping symlink: ${entry.name}`);
      continue;
    }
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath, logger);
    else fs.copyFileSync(sourcePath, destinationPath);
  }
}

function runSqlite(
  settings: BackupSettings,
  databasePath: string,
  command: string
): SpawnSyncReturns<string> {
  const executable = SQLITE_EXECUTABLES[process.platform] ?? "/usr/bin/sqlite3";
  return settings.spawnSync(executable, [databasePath, command], {
    shell: false,
    encoding: "utf8",
  });
}

function tryCheckpointWal(settings: BackupSettings, databasePath: string): boolean {
  return runSqlite(settings, databasePath, "PRAGMA wal_checkpoint(TRUNCATE);").status === 0;
}

function copyDatabaseWithSidecars(
  settings: BackupSettings,
  databaseSource: string,
  databaseDestination: string
): void {
  const files = resolveSqliteDatabaseFiles(databaseSource);
  tryCheckpointWal(settings, databaseSource);
  fs.copyFileSync(files.main, databaseDestination);

  if (fs.existsSync(files.wal)) {
    fs.copyFileSync(files.wal, `${databaseDestination}-wal`);
    settings.logger.log("Database WAL sidecar included in backup");
  }
  if (fs.existsSync(files.shm)) {
    fs.copyFileSync(files.shm, `${databaseDestination}-shm`);
    settings.logger.log("Database SHM sidecar included in backup");
  }
  settings.logger.log("Database backup via file copy (sqlite3 CLI not available)");
}

function backupDatabaseAtomic(
  settings: BackupSettings,
  databaseSource: string,
  databaseDestination: string
): void {
  fs.mkdirSync(path.dirname(databaseDestination), { recursive: true });
  const escapedDestination = escapeSqliteDotCommandPath(databaseDestination);
  const result = runSqlite(settings, databaseSource, `.backup '${escapedDestination}'`);
  if (result.status === 0 && isValidSqliteSnapshot(databaseDestination, result.stderr ?? "")) {
    settings.logger.log("Database backup via sqlite3 .backup (WAL-safe snapshot)");
    return;
  }
  if (fs.existsSync(databaseDestination)) fs.rmSync(databaseDestination, { force: true });
  copyDatabaseWithSidecars(settings, databaseSource, databaseDestination);
}

function backupDatabase(
  settings: BackupSettings,
  databaseSource: string,
  databaseDestination: string
): void {
  if (!fs.existsSync(databaseSource)) {
    throw new Error("Database file not found — aborting backup");
  }
  backupDatabaseAtomic(settings, databaseSource, databaseDestination);
}

function addDirectoryChecksums(
  checksums: Record<string, string>,
  directoryPath: string,
  manifestPrefix: string
): void {
  const entries = Object.entries(sha256Dir(directoryPath)).map(([relativePath, checksum]) => [
    `${manifestPrefix}/${relativePath}`,
    checksum,
  ]);
  Object.assign(checksums, Object.fromEntries(entries));
}

function collectBackupChecksums(input: {
  databaseDestination: string;
  importDestination: string;
  reportDestination: string;
}): Record<string, string> {
  const checksums: Record<string, string> = {};
  if (fs.existsSync(input.databaseDestination)) {
    checksums["db/database.sqlite"] = sha256File(input.databaseDestination);
  }
  if (fs.existsSync(`${input.databaseDestination}-wal`)) {
    checksums["db/database.sqlite-wal"] = sha256File(`${input.databaseDestination}-wal`);
  }
  if (fs.existsSync(`${input.databaseDestination}-shm`)) {
    checksums["db/database.sqlite-shm"] = sha256File(`${input.databaseDestination}-shm`);
  }
  addDirectoryChecksums(checksums, input.importDestination, "storage/imports");
  addDirectoryChecksums(checksums, input.reportDestination, "storage/reports");
  return checksums;
}

export function createBackup(options: BackupServiceOptions = {}): BackupCreationResult {
  const settings = resolveSettings(options);
  const timestamp = settings.now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupName = `backup-${timestamp}`;
  const backupDirectory = path.join(settings.backupsRoot, backupName);
  settings.logger.log(`Creating backup: ${backupName}`);
  fs.mkdirSync(backupDirectory, { recursive: true });

  const databaseDestination = path.join(backupDirectory, "db", "database.sqlite");
  backupDatabase(settings, settings.databasePath, databaseDestination);

  const importDestination = path.join(backupDirectory, "storage", "imports");
  copyDirectory(settings.importStoragePath, importDestination, settings.logger);
  settings.logger.log("Import storage backed up");

  const reportDestination = path.join(backupDirectory, "storage", "reports");
  copyDirectory(settings.reportStoragePath, reportDestination, settings.logger);
  settings.logger.log("Report storage backed up");

  const checksums = collectBackupChecksums({
    databaseDestination,
    importDestination,
    reportDestination,
  });
  const manifest = {
    version: "1",
    backupName,
    createdAt: settings.now.toISOString(),
    nodeVersion: process.version,
    dbPath: path.basename(settings.databasePath),
    checksums,
    note: "Does not include .env, secrets, or node_modules.",
  };
  fs.writeFileSync(
    path.join(backupDirectory, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  settings.logger.log(`\nBackup complete: ${backupName}`);
  settings.logger.log(`Files: ${Object.keys(checksums).length}`);
  return { backupName, fileCount: Object.keys(checksums).length };
}

function loadBackupManifest(manifestPath: string): BackupManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json not found — backup may be corrupt");
  }
  if (fs.statSync(manifestPath).size > MAX_MANIFEST_SIZE) {
    throw new Error("manifest.json exceeds maximum allowed size");
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
}

function safeDisplayName(filePath: string): string {
  return path.basename(filePath);
}

function verifyManifestEntry(
  verifiedPath: string,
  relativePath: string,
  expectedHash: string
): string | null {
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return "SECURITY: path traversal in manifest entry";
  }
  const fullPath = path.join(verifiedPath, normalized);
  const fileRelativePath = path.relative(verifiedPath, fullPath);
  if (fileRelativePath.startsWith("..") || path.isAbsolute(fileRelativePath)) {
    return "SECURITY: manifest entry escapes backup directory";
  }
  if (!fs.existsSync(fullPath)) return `MISSING: ${safeDisplayName(normalized)}`;
  if (fs.lstatSync(fullPath).isSymbolicLink()) {
    return `SECURITY: symlink detected: ${safeDisplayName(normalized)}`;
  }
  if (sha256File(fullPath) !== expectedHash) {
    return `MISMATCH: ${safeDisplayName(normalized)}`;
  }
  return null;
}

export function verifyBackup(
  backupInput: string,
  options: BackupServiceOptions = {}
): BackupVerificationResult {
  const settings = resolveSettings(options);
  const verifiedPath = resolveBackupPath(settings.backupsRoot, backupInput);
  const manifest = loadBackupManifest(path.join(verifiedPath, "manifest.json"));
  const safeMetadata = toSafeBackupMetadata(verifiedPath, manifest);
  settings.logger.log("Backup verification started");
  settings.logger.log(formatBackupMetadataLog(safeMetadata));

  let ok = 0;
  let errors = 0;
  for (const [relativePath, expectedHash] of Object.entries(manifest.checksums)) {
    const error = verifyManifestEntry(verifiedPath, relativePath, expectedHash);
    if (error) {
      settings.logger.error(error);
      errors += 1;
    } else {
      ok += 1;
    }
  }
  if (errors === 0) settings.logger.log(`✓ Backup verified: ${ok} files OK`);
  else settings.logger.error(`✗ Backup has ${errors} error(s), ${ok} files OK`);
  return { backupName: safeMetadata.backupName, fileCount: safeMetadata.fileCount, ok, errors };
}

export function createVerifiedBackup(
  options: BackupServiceOptions = {},
  dependencies: {
    create?: (options: BackupServiceOptions) => BackupCreationResult;
    verify?: (backupName: string, options: BackupServiceOptions) => BackupVerificationResult;
  } = {}
): VerifiedBackupResult {
  const created = (dependencies.create ?? createBackup)(options);
  const verification = (dependencies.verify ?? verifyBackup)(created.backupName, options);
  if (verification.errors > 0 || verification.ok !== created.fileCount) {
    throw new Error("Backup verification failed");
  }
  return { backupName: created.backupName, verified: true };
}

export function sanitizeBackupError(error: unknown, options: BackupServiceOptions = {}): string {
  if (!(error instanceof Error)) return "Unknown backup error";
  const settings = resolveSettings(options);
  const databaseUrl = settings.env.DATABASE_URL ?? "";
  const rawDatabasePath = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : "";
  let message = error.message;
  if (databaseUrl) message = message.replaceAll(databaseUrl, "<database-url>");
  if (rawDatabasePath && rawDatabasePath !== databaseUrl) {
    message = message.replaceAll(rawDatabasePath, "<database>");
  }
  return message
    .replaceAll(settings.backupsRoot, "<backups>")
    .replaceAll(settings.projectRoot, "<project>")
    .replace(/\b[a-f0-9]{64}\b/gi, "<checksum>");
}
