import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  REPAIR_ERROR_CODES,
  applyTaxonomyMigrationRepair,
  inspectTaxonomyMigrationRepair,
} from "./taxonomy-migration-repair";

const LEGACY_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  id TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  finished_at DATETIME,
  migration_name TEXT NOT NULL,
  logs TEXT,
  rolled_back_at DATETIME,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_steps_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "ClassificationTaxonomyRestructureRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proposalHash" TEXT NOT NULL,
    "mappingHash" TEXT NOT NULL,
    "currentTaxonomyFingerprint" TEXT NOT NULL,
    "targetTaxonomyFingerprint" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "renamedCount" INTEGER NOT NULL DEFAULT 0,
    "movedCount" INTEGER NOT NULL DEFAULT 0,
    "deactivatedCount" INTEGER NOT NULL DEFAULT 0,
    "keywordChangeCount" INTEGER NOT NULL DEFAULT 0,
    "legacyComplaintConsistencyUpdateCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "rollbackOfRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ClassificationTaxonomyRestructureItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT,
    "previousStateJson" JSONB,
    "nextStateJson" JSONB,
    "result" TEXT NOT NULL,
    "skipReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClassificationTaxonomyRestructureItem_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "ClassificationTaxonomyRestructureRun" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
`;

const temps: string[] = [];

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cip-taxonomy-repair-"));
  temps.push(dir);
  return dir;
}

function createLegacyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(LEGACY_DDL);
  db.prepare(
    `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(
    "mig-legacy",
    "old-checksum",
    Date.now(),
    "20260805110000_add_classification_taxonomy_restructure",
    Date.now()
  );
  db.close();
}

function seedLegacyData(path: string): void {
  const db = new DatabaseSync(path);
  const sameTs = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO "ClassificationTaxonomyRestructureRun"
      (id, operation, status, proposalHash, mappingHash, currentTaxonomyFingerprint, targetTaxonomyFingerprint, manifestHash, actor, updatedAt)
     VALUES (?, 'APPLY', 'APPLIED', 'p', 'm', 'c', 't', 'h', 'test', ?)`
  ).run("run_a", sameTs);
  db.prepare(
    `INSERT INTO "ClassificationTaxonomyRestructureRun"
      (id, operation, status, proposalHash, mappingHash, currentTaxonomyFingerprint, targetTaxonomyFingerprint, manifestHash, actor, updatedAt)
     VALUES (?, 'APPLY', 'FAILED', 'p', 'm', 'c', 't', 'h', 'test', ?)`
  ).run("run_b", sameTs);

  const insertItem = db.prepare(
    `INSERT INTO "ClassificationTaxonomyRestructureItem"
      (id, runId, entityType, action, entityId, previousStateJson, nextStateJson, result, createdAt, updatedAt)
     VALUES (?, ?, 'Category', 'RENAME', 'ent', '{"name":"old"}', '{"name":"new"}', 'APPLIED', ?, ?)`
  );
  insertItem.run("item_a2", "run_a", sameTs, sameTs);
  insertItem.run("item_a1", "run_a", sameTs, sameTs);
  insertItem.run("item_b1", "run_b", sameTs, sameTs);
  db.close();
}

describe("taxonomy migration repair", () => {
  it("scenario 1: clean migrate deploy needs no repair action", () => {
    const dir = tempDir();
    const dbPath = join(dir, "clean.db");
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: "pipe",
    });
    const inspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(inspect.schemaState).toBe("NO_ACTION_REQUIRED");
    expect(inspect.actionRequired).toBe(false);
    const backup = join(dir, "backup.db");
    copyFileSync(dbPath, backup);
    const applied = applyTaxonomyMigrationRepair({
      databaseUrl: `file:${dbPath}`,
      confirm: inspect.confirmationToken,
      backupPath: backup,
    });
    expect(applied.schemaStateAfter).toBe("NO_ACTION_REQUIRED");
    expect(applied.sequencesAssigned).toBe(0);
  }, 60_000);

  it("scenario 2/3: repairs legacy schema with deterministic sequences and stays idempotent", () => {
    const dir = tempDir();
    const dbPath = join(dir, "legacy.db");
    createLegacyDb(dbPath);
    seedLegacyData(dbPath);

    const before = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(before.schemaState).toBe("LEGACY_MISSING_COLUMNS");
    expect(before.runTable.rowCount).toBe(2);
    expect(before.itemTable.rowCount).toBe(3);
    expect(before.runTable.missingColumns).toEqual(
      expect.arrayContaining(["rolledBackCount", "skippedCount"])
    );
    expect(before.itemTable.missingColumns).toContain("sequence");

    const backup = join(dir, "backup.db");
    copyFileSync(dbPath, backup);
    const applied = applyTaxonomyMigrationRepair({
      databaseUrl: `file:${dbPath}`,
      confirm: before.confirmationToken,
      backupPath: backup,
    });
    expect(applied.changed).toBe(true);
    expect(applied.runsAfter).toBe(2);
    expect(applied.itemsAfter).toBe(3);
    expect(applied.uniqueIndexPresent).toBe(true);
    expect(applied.schemaStateAfter).toBe("NO_ACTION_REQUIRED");

    const db = new DatabaseSync(dbPath);
    const seqs = db
      .prepare(
        `SELECT id, sequence FROM "ClassificationTaxonomyRestructureItem" WHERE runId = 'run_a' ORDER BY sequence`
      )
      .all() as Array<{ id: string; sequence: number }>;
    expect(seqs.map((s) => s.sequence)).toEqual([1, 2]);
    // equal createdAt ⇒ id ascending: item_a1 then item_a2
    expect(seqs.map((s) => s.id)).toEqual(["item_a1", "item_a2"]);
    const run = db
      .prepare(
        `SELECT rolledBackCount, skippedCount FROM "ClassificationTaxonomyRestructureRun" WHERE id = 'run_a'`
      )
      .get() as { rolledBackCount: number; skippedCount: number };
    expect(run.rolledBackCount).toBe(0);
    expect(run.skippedCount).toBe(0);
    const json = db
      .prepare(
        `SELECT previousStateJson, nextStateJson FROM "ClassificationTaxonomyRestructureItem" WHERE id = 'item_a1'`
      )
      .get() as { previousStateJson: string; nextStateJson: string };
    expect(json.previousStateJson).toContain("old");
    expect(json.nextStateJson).toContain("new");
    db.close();

    const secondInspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(secondInspect.schemaState).toBe("NO_ACTION_REQUIRED");
    const second = applyTaxonomyMigrationRepair({
      databaseUrl: `file:${dbPath}`,
      confirm: secondInspect.confirmationToken,
      backupPath: backup,
    });
    expect(second.sequencesAssigned).toBe(0);
    expect(second.schemaStateAfter).toBe("NO_ACTION_REQUIRED");
  });

  it("scenario 4: rejects unknown schema without mutating", () => {
    const dir = tempDir();
    const dbPath = join(dir, "unknown.db");
    createLegacyDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec(`ALTER TABLE "ClassificationTaxonomyRestructureRun" DROP COLUMN "actor"`);
    db.close();

    const inspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(inspect.schemaState).toBe("UNKNOWN_SCHEMA");
    const backup = join(dir, "backup.db");
    copyFileSync(dbPath, backup);
    expect(() =>
      applyTaxonomyMigrationRepair({
        databaseUrl: `file:${dbPath}`,
        confirm: inspect.confirmationToken,
        backupPath: backup,
      })
    ).toThrowError(expect.objectContaining({ code: REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA }));

    const after = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(after.schemaState).toBe("UNKNOWN_SCHEMA");
    expect(after.runTable.columns).not.toContain("actor");
  });

  it("requires backup path and valid confirmation", () => {
    const dir = tempDir();
    const dbPath = join(dir, "legacy.db");
    createLegacyDb(dbPath);
    const inspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(() =>
      applyTaxonomyMigrationRepair({
        databaseUrl: `file:${dbPath}`,
        confirm: inspect.confirmationToken,
      })
    ).toThrowError(expect.objectContaining({ code: REPAIR_ERROR_CODES.REPAIR_BACKUP_REQUIRED }));
    expect(() =>
      applyTaxonomyMigrationRepair({
        databaseUrl: `file:${dbPath}`,
        confirm: "REPAIR-DEADBEEF0000",
        backupPath: join(dir, "missing.db"),
      })
    ).toThrowError(expect.objectContaining({ code: REPAIR_ERROR_CODES.REPAIR_CONFIRMATION_INVALID }));
  });
});
