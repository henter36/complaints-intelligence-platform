import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FileHashReader = (path: string) => string;

export function activeSqliteSidecars(databasePath: string): string[] {
  const sidecars = [`${databasePath}-wal`, `${databasePath}-journal`];
  return sidecars.filter((path) => existsSync(path) && statSync(path).size > 0);
}

export function assertSqliteSourceIsQuiescent(databasePath: string): void {
  const active = activeSqliteSidecars(databasePath);
  if (active.length === 0) return;
  const hasShm = existsSync(`${databasePath}-shm`);
  const details = hasShm ? ` Active files: ${[...active, `${databasePath}-shm`].join(", ")}` : "";
  throw new Error(
    `SQLite source has an active WAL or rollback journal. Stop writers and retry so the benchmark can create a consistent snapshot.${details}`
  );
}

export function copyConsistentSqliteSnapshot(options: {
  sourcePath: string;
  tempPrefix: string;
  hashFile: FileHashReader;
}): { copyPath: string; sourceSha: string; tempDir: string } {
  const sourceShaBeforeCopy = options.hashFile(options.sourcePath);
  assertSqliteSourceIsQuiescent(options.sourcePath);

  const tempDir = mkdtempSync(join(tmpdir(), options.tempPrefix));
  const copyPath = join(tempDir, "bench.db");

  try {
    copyFileSync(options.sourcePath, copyPath);
    assertSqliteSourceIsQuiescent(options.sourcePath);

    const sourceShaAfterCopy = options.hashFile(options.sourcePath);
    if (sourceShaAfterCopy !== sourceShaBeforeCopy) {
      throw new Error("SQLite source changed while the benchmark snapshot was being copied.");
    }

    return { copyPath, sourceSha: sourceShaBeforeCopy, tempDir };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
