import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeSqliteSidecars,
  assertSqliteSourceIsQuiescent,
  copyConsistentSqliteSnapshot,
} from "./benchmark-sqlite-snapshot";

function sha(path: string): string {
  return readFileSync(path).toString("hex");
}

function setupDbFixture(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-snapshot-test-"));
  const dbPath = join(dir, "source.db");
  writeFileSync(dbPath, "db-content");
  return { dir, dbPath };
}

describe("benchmark sqlite snapshot safeguards", () => {
  it("allows copy when DB has no active WAL/journal", () => {
    const { dir, dbPath } = setupDbFixture();
    try {
      const result = copyConsistentSqliteSnapshot({
        sourcePath: dbPath,
        tempPrefix: "sqlite-copy-ok-",
        hashFile: sha,
      });
      expect(statSync(result.copyPath).size).toBeGreaterThan(0);
      expect(result.sourceSha).toBe(sha(dbPath));
      rmSync(result.tempDir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not block on empty WAL", () => {
    const { dir, dbPath } = setupDbFixture();
    const wal = `${dbPath}-wal`;
    try {
      writeFileSync(wal, "");
      expect(activeSqliteSidecars(dbPath)).toEqual([]);
      expect(() => assertSqliteSourceIsQuiescent(dbPath)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-empty WAL without SHM and keeps sidecar untouched", () => {
    const { dir, dbPath } = setupDbFixture();
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    try {
      writeFileSync(wal, "pending-wal-data");
      const beforeSize = statSync(wal).size;
      let thrown: Error | undefined;
      try {
        assertSqliteSourceIsQuiescent(dbPath);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).toContain(wal);
      expect(thrown!.message).not.toContain(shm);
      expect(statSync(wal).size).toBe(beforeSize);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-empty WAL with SHM and reports both paths", () => {
    const { dir, dbPath } = setupDbFixture();
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    try {
      writeFileSync(wal, "pending-wal-data");
      writeFileSync(shm, "shm-bytes");
      const walSize = statSync(wal).size;
      const shmSize = statSync(shm).size;
      let thrown: Error | undefined;
      try {
        assertSqliteSourceIsQuiescent(dbPath);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).toContain(wal);
      expect(thrown!.message).toContain(shm);
      expect(statSync(wal).size).toBe(walSize);
      expect(statSync(shm).size).toBe(shmSize);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-empty rollback journal and keeps sidecar untouched", () => {
    const { dir, dbPath } = setupDbFixture();
    const journal = `${dbPath}-journal`;
    try {
      writeFileSync(journal, "pending-journal-data");
      const beforeSize = statSync(journal).size;
      let thrown: Error | undefined;
      try {
        assertSqliteSourceIsQuiescent(dbPath);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).toContain(journal);
      expect(statSync(journal).size).toBe(beforeSize);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not reject when only SHM exists", () => {
    const { dir, dbPath } = setupDbFixture();
    const shm = `${dbPath}-shm`;
    try {
      writeFileSync(shm, "shm-only");
      expect(activeSqliteSidecars(dbPath)).toEqual([]);
      expect(() => assertSqliteSourceIsQuiescent(dbPath)).not.toThrow();
      const result = copyConsistentSqliteSnapshot({
        sourcePath: dbPath,
        tempPrefix: "sqlite-copy-shm-only-",
        hashFile: sha,
      });
      expect(statSync(shm).size).toBeGreaterThan(0);
      rmSync(result.tempDir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects when source hash changes during copy and cleans tempDir", () => {
    const { dir, dbPath } = setupDbFixture();
    const first = sha(dbPath);
    const second = `${first}-changed`;
    const prefix = "sqlite-copy-fail-";
    const beforeDirs = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
    let call = 0;
    try {
      expect(() =>
        copyConsistentSqliteSnapshot({
          sourcePath: dbPath,
          tempPrefix: prefix,
          hashFile: () => {
            call += 1;
            return call === 1 ? first : second;
          },
        })
      ).toThrow(/changed while the benchmark snapshot was being copied/);
      const afterDirs = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
      expect(afterDirs).toBe(beforeDirs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mutate source database bytes", () => {
    const { dir, dbPath } = setupDbFixture();
    const before = sha(dbPath);
    try {
      const result = copyConsistentSqliteSnapshot({
        sourcePath: dbPath,
        tempPrefix: "sqlite-copy-source-",
        hashFile: sha,
      });
      const after = sha(dbPath);
      expect(after).toBe(before);
      rmSync(result.tempDir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
