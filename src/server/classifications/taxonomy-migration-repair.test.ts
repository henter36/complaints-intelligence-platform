import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  REPAIR_ERROR_CODES,
  __repairTestUtils,
  applyTaxonomyMigrationRepair,
  classifySchemaState,
  hasUniqueRunSequenceIndex,
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

const COMPLETE_ITEM_DDL_WITH_TABLE_UNIQUE = `
CREATE TABLE "ClassificationTaxonomyRestructureItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT,
    "previousStateJson" JSONB,
    "nextStateJson" JSONB,
    "result" TEXT NOT NULL,
    "skipReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    UNIQUE("runId", "sequence"),
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

function createCompleteRunTable(db: DatabaseSync): void {
  db.exec(`
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
      "rolledBackCount" INTEGER NOT NULL DEFAULT 0,
      "skippedCount" INTEGER NOT NULL DEFAULT 0,
      "failureCode" TEXT,
      "failureMessage" TEXT,
      "rollbackOfRunId" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );
  `);
}

function createItemBase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE "ClassificationTaxonomyRestructureItem" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "sequence" INTEGER NOT NULL,
      "entityType" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "entityId" TEXT,
      "previousStateJson" JSONB,
      "nextStateJson" JSONB,
      "result" TEXT NOT NULL,
      "skipReason" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );
  `);
}

describe("unique(runId, sequence) detection via PRAGMA metadata", () => {
  it("rejects a non-unique index on runId+sequence", () => {
    const dir = tempDir();
    const dbPath = join(dir, "nonunique.db");
    const db = new DatabaseSync(dbPath);
    createCompleteRunTable(db);
    createItemBase(db);
    db.exec(
      `CREATE INDEX "ClassificationTaxonomyRestructureItem_runId_sequence_key"
       ON "ClassificationTaxonomyRestructureItem"("runId", "sequence")`
    );
    expect(hasUniqueRunSequenceIndex(db)).toBe(false);
    db.close();

    const inspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(inspect.schemaState).toBe("LEGACY_MISSING_COLUMNS");
    expect(inspect.itemTable.hasRunSequenceUnique).toBe(false);
  });

  it("accepts an explicit unique index on runId+sequence", () => {
    const dir = tempDir();
    const dbPath = join(dir, "unique.db");
    const db = new DatabaseSync(dbPath);
    createCompleteRunTable(db);
    createItemBase(db);
    db.exec(
      `CREATE UNIQUE INDEX "ClassificationTaxonomyRestructureItem_runId_sequence_key"
       ON "ClassificationTaxonomyRestructureItem"("runId", "sequence")`
    );
    expect(hasUniqueRunSequenceIndex(db)).toBe(true);
    db.close();
  });

  it("detects UNIQUE(runId, sequence) declared inside CREATE TABLE", () => {
    const dir = tempDir();
    const dbPath = join(dir, "table-unique.db");
    const db = new DatabaseSync(dbPath);
    createCompleteRunTable(db);
    db.exec(COMPLETE_ITEM_DDL_WITH_TABLE_UNIQUE);
    const auto = db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='ClassificationTaxonomyRestructureItem'`
      )
      .all() as Array<{ name: string; sql: string | null }>;
    expect(auto.some((row) => row.sql == null)).toBe(true);
    expect(hasUniqueRunSequenceIndex(db)).toBe(true);
    db.close();
  });

  it("rejects unique indexes with wrong column order or extra columns", () => {
    const dir = tempDir();
    const dbPath = join(dir, "wrong-order.db");
    const db = new DatabaseSync(dbPath);
    createCompleteRunTable(db);
    createItemBase(db);
    db.exec(
      `CREATE UNIQUE INDEX "uq_sequence_run"
       ON "ClassificationTaxonomyRestructureItem"("sequence", "runId")`
    );
    expect(hasUniqueRunSequenceIndex(db)).toBe(false);
    db.exec(`DROP INDEX "uq_sequence_run"`);
    db.exec(
      `CREATE UNIQUE INDEX "uq_extra"
       ON "ClassificationTaxonomyRestructureItem"("runId", "sequence", "action")`
    );
    expect(hasUniqueRunSequenceIndex(db)).toBe(false);
    db.close();
  });

  it("rejects partial unique indexes and non-unique expected names", () => {
    const dir = tempDir();
    const dbPath = join(dir, "partial.db");
    const db = new DatabaseSync(dbPath);
    createCompleteRunTable(db);
    createItemBase(db);
    db.exec(
      `CREATE UNIQUE INDEX "uq_partial"
       ON "ClassificationTaxonomyRestructureItem"("runId", "sequence")
       WHERE result = 'APPLIED'`
    );
    expect(hasUniqueRunSequenceIndex(db)).toBe(false);
    db.exec(`DROP INDEX "uq_partial"`);
    db.exec(
      `CREATE INDEX "ClassificationTaxonomyRestructureItem_runId_sequence_key"
       ON "ClassificationTaxonomyRestructureItem"("runId", "sequence")`
    );
    expect(hasUniqueRunSequenceIndex(db)).toBe(false);
    db.close();
  });

  it("classifies complete columns without unique constraint as LEGACY_MISSING_COLUMNS", () => {
    expect(
      classifySchemaState({
        runExists: true,
        itemExists: true,
        runColumns: [
          ...REQUIRED_RUN_COLUMNS_FOR_TEST,
        ],
        itemColumns: [...REQUIRED_ITEM_COLUMNS_FOR_TEST],
        hasUnique: false,
      })
    ).toBe("LEGACY_MISSING_COLUMNS");
  });
});

const REQUIRED_RUN_COLUMNS_FOR_TEST = [
  "id",
  "operation",
  "status",
  "proposalHash",
  "mappingHash",
  "currentTaxonomyFingerprint",
  "targetTaxonomyFingerprint",
  "manifestHash",
  "actor",
  "startedAt",
  "completedAt",
  "createdCount",
  "renamedCount",
  "movedCount",
  "deactivatedCount",
  "keywordChangeCount",
  "legacyComplaintConsistencyUpdateCount",
  "rolledBackCount",
  "skippedCount",
  "failureCode",
  "failureMessage",
  "rollbackOfRunId",
  "createdAt",
  "updatedAt",
];

const REQUIRED_ITEM_COLUMNS_FOR_TEST = [
  "id",
  "runId",
  "sequence",
  "entityType",
  "action",
  "entityId",
  "previousStateJson",
  "nextStateJson",
  "result",
  "skipReason",
  "createdAt",
  "updatedAt",
];

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
    expect(inspect.itemTable.hasRunSequenceUnique).toBe(true);
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

  it("repairs legacy schema, assigns deterministic sequences, and stays idempotent", () => {
    const dir = tempDir();
    const dbPath = join(dir, "legacy.db");
    createLegacyDb(dbPath);
    seedLegacyData(dbPath);

    const before = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(before.schemaState).toBe("LEGACY_MISSING_COLUMNS");
    expect(before.runTable.rowCount).toBe(2);
    expect(before.itemTable.rowCount).toBe(3);

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

    const db = new DatabaseSync(dbPath);
    expect(hasUniqueRunSequenceIndex(db)).toBe(true);
    const seqs = db
      .prepare(
        `SELECT id, sequence FROM "ClassificationTaxonomyRestructureItem" WHERE runId = 'run_a' ORDER BY sequence`
      )
      .all() as Array<{ id: string; sequence: number }>;
    expect(seqs.map((s) => s.sequence)).toEqual([1, 2]);
    expect(seqs.map((s) => s.id)).toEqual(["item_a1", "item_a2"]);
    const json = db
      .prepare(
        `SELECT previousStateJson, nextStateJson FROM "ClassificationTaxonomyRestructureItem" WHERE id = 'item_a1'`
      )
      .get() as { previousStateJson: string; nextStateJson: string };
    expect(json.previousStateJson).toContain("old");
    expect(json.nextStateJson).toContain("new");
    expect(
      (
        db
          .prepare(
            `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='new_ClassificationTaxonomyRestructureItem'`
          )
          .get() as { ok: number } | undefined
      )?.ok
    ).toBeUndefined();
    db.close();

    const secondInspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(secondInspect.schemaState).toBe("NO_ACTION_REQUIRED");
    const second = applyTaxonomyMigrationRepair({
      databaseUrl: `file:${dbPath}`,
      confirm: secondInspect.confirmationToken,
      backupPath: backup,
    });
    expect(second.sequencesAssigned).toBe(0);
    expect(second.changed).toBe(false);
  });

  it("converts a non-unique runId+sequence index into a real unique constraint", () => {
    const dir = tempDir();
    const dbPath = join(dir, "fake-unique-name.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
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
    `);
    createCompleteRunTable(db);
    createItemBase(db);
    db.exec(
      `CREATE INDEX "ClassificationTaxonomyRestructureItem_runId_sequence_key"
       ON "ClassificationTaxonomyRestructureItem"("runId", "sequence")`
    );
    db.prepare(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(
      "mig",
      "old",
      Date.now(),
      "20260805110000_add_classification_taxonomy_restructure",
      Date.now()
    );
    db.close();

    const inspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    expect(inspect.schemaState).toBe("LEGACY_MISSING_COLUMNS");
    const backup = join(dir, "backup.db");
    copyFileSync(dbPath, backup);
    const applied = applyTaxonomyMigrationRepair({
      databaseUrl: `file:${dbPath}`,
      confirm: inspect.confirmationToken,
      backupPath: backup,
    });
    expect(applied.schemaStateAfter).toBe("NO_ACTION_REQUIRED");
    expect(applied.uniqueIndexPresent).toBe(true);
    const afterDb = new DatabaseSync(dbPath);
    expect(hasUniqueRunSequenceIndex(afterDb)).toBe(true);
    afterDb.close();
  });

  it("rejects unknown schema without mutating", () => {
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

describe("foreign_keys handling outside transactions", () => {
  it("disables foreign_keys before BEGIN and restores prior ON state after success", () => {
    const dir = tempDir();
    const dbPath = join(dir, "fk-on.db");
    createLegacyDb(dbPath);
    seedLegacyData(dbPath);
    const probe = new DatabaseSync(dbPath);
    __repairTestUtils.setForeignKeysEnabled(probe, true);
    expect(__repairTestUtils.readForeignKeysEnabled(probe)).toBe(true);
    probe.close();

    const inspect = inspectTaxonomyMigrationRepair({ databaseUrl: `file:${dbPath}` });
    const backup = join(dir, "backup.db");
    copyFileSync(dbPath, backup);
    applyTaxonomyMigrationRepair({
      databaseUrl: `file:${dbPath}`,
      confirm: inspect.confirmationToken,
      backupPath: backup,
    });

    const after = new DatabaseSync(dbPath);
    expect(__repairTestUtils.readForeignKeysEnabled(after)).toBe(true);
    after.close();
  });

  it("keeps foreign_keys OFF when that was the original state", () => {
    const dir = tempDir();
    const dbPath = join(dir, "fk-off.db");
    createLegacyDb(dbPath);
    seedLegacyData(dbPath);
    const db = new DatabaseSync(dbPath);
    __repairTestUtils.setForeignKeysEnabled(db, false);
    expect(__repairTestUtils.readForeignKeysEnabled(db)).toBe(false);
    __repairTestUtils.runRepairTransaction(db, () => {
      // no structural mutation required for this state contract
    });
    expect(__repairTestUtils.readForeignKeysEnabled(db)).toBe(false);
    db.close();
  });

  it("rolls back failed rebuilds and restores foreign_keys without leftover temp tables", () => {
    const dir = tempDir();
    const dbPath = join(dir, "fk-fail.db");
    createLegacyDb(dbPath);
    seedLegacyData(dbPath);
    const db = new DatabaseSync(dbPath);
    __repairTestUtils.setForeignKeysEnabled(db, true);
    expect(() =>
      __repairTestUtils.runRepairTransaction(db, () => {
        db.exec(`CREATE TABLE "new_ClassificationTaxonomyRestructureItem" ("id" TEXT PRIMARY KEY)`);
        throw new Error("forced-failure");
      })
    ).toThrow("forced-failure");
    expect(__repairTestUtils.readForeignKeysEnabled(db)).toBe(true);
    expect(
      (
        db
          .prepare(
            `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='new_ClassificationTaxonomyRestructureItem'`
          )
          .get() as { ok: number } | undefined
      )?.ok
    ).toBeUndefined();
    expect(
      Number(
        (db.prepare(`SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureItem"`).get() as { c: number })
          .c
      )
    ).toBe(3);
    db.close();
  });

  it("blocks COMMIT when foreign_key_check reports violations", () => {
    const dir = tempDir();
    const dbPath = join(dir, "fk-violation.db");
    createLegacyDb(dbPath);
    const db = new DatabaseSync(dbPath);
    __repairTestUtils.setForeignKeysEnabled(db, true);
    expect(() =>
      __repairTestUtils.runRepairTransaction(db, () => {
        db.exec(
          `INSERT INTO "ClassificationTaxonomyRestructureItem"
            (id, runId, entityType, action, result, createdAt, updatedAt)
           VALUES ('orphan', 'missing_run', 'Category', 'RENAME', 'APPLIED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        );
      })
    ).toThrowError(
      expect.objectContaining({ code: REPAIR_ERROR_CODES.REPAIR_FOREIGN_KEY_VIOLATION })
    );
    expect(__repairTestUtils.readForeignKeysEnabled(db)).toBe(true);
    expect(
      Number(
        (db.prepare(`SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureItem"`).get() as { c: number })
          .c
      )
    ).toBe(0);
    const checksum = (
      db
        .prepare(
          `SELECT checksum FROM _prisma_migrations WHERE migration_name = '20260805110000_add_classification_taxonomy_restructure'`
        )
        .get() as { checksum: string }
    ).checksum;
    expect(checksum).toBe("old-checksum");
    db.close();
  });
});
