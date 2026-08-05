/**
 * Idempotent repair for ClassificationTaxonomyRestructure* schema drift on SQLite.
 * Does not run taxonomy apply/rollback or historical backfill.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TAXONOMY_RESTRUCTURE_MIGRATION_NAME =
  "20260805110000_add_classification_taxonomy_restructure";

export const REPAIR_ERROR_CODES = {
  REPAIR_SQLITE_REQUIRED: "REPAIR_SQLITE_REQUIRED",
  REPAIR_BACKUP_REQUIRED: "REPAIR_BACKUP_REQUIRED",
  REPAIR_BACKUP_INVALID: "REPAIR_BACKUP_INVALID",
  REPAIR_UNKNOWN_SCHEMA: "REPAIR_UNKNOWN_SCHEMA",
  REPAIR_CONFIRMATION_REQUIRED: "REPAIR_CONFIRMATION_REQUIRED",
  REPAIR_CONFIRMATION_INVALID: "REPAIR_CONFIRMATION_INVALID",
  REPAIR_MIGRATION_STATE_UNSAFE: "REPAIR_MIGRATION_STATE_UNSAFE",
  REPAIR_DATABASE_REQUIRED: "REPAIR_DATABASE_REQUIRED",
} as const;

export class TaxonomyMigrationRepairError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TaxonomyMigrationRepairError";
  }
}

export type RepairSchemaState =
  | "NO_ACTION_REQUIRED"
  | "LEGACY_MISSING_COLUMNS"
  | "MISSING_TABLES"
  | "UNKNOWN_SCHEMA";

export type RepairInspectReport = {
  mode: "inspect";
  databaseProvider: "sqlite";
  schemaState: RepairSchemaState;
  actionRequired: boolean;
  confirmationToken: string;
  runTable: {
    exists: boolean;
    columns: string[];
    missingColumns: string[];
    rowCount: number;
  };
  itemTable: {
    exists: boolean;
    columns: string[];
    missingColumns: string[];
    rowCount: number;
    hasRunSequenceUnique: boolean;
    duplicateSequenceGroups: number;
    nullSequenceCount: number;
  };
  migration: {
    name: string;
    recorded: boolean;
    finished: boolean;
    rolledBack: boolean;
    checksumMatchesFile: boolean | null;
    recordedChecksumPrefix: string | null;
    fileChecksumPrefix: string | null;
  };
  statusDistribution: Record<string, number>;
  maxSequenceByRunPrefix: Array<{ runIdPrefix: string; maxSequence: number | null }>;
};

export type RepairApplyReport = {
  mode: "apply";
  schemaStateBefore: RepairSchemaState;
  schemaStateAfter: RepairSchemaState;
  changed: boolean;
  runsBefore: number;
  runsAfter: number;
  itemsBefore: number;
  itemsAfter: number;
  sequencesAssigned: number;
  uniqueIndexPresent: boolean;
  migrationChecksumUpdated: boolean;
};

type ColumnInfo = { name: string };

const REQUIRED_RUN_COLUMNS = [
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
] as const;

const REQUIRED_ITEM_COLUMNS = [
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
] as const;

const LEGACY_RUN_BASE_COLUMNS = [
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
  "failureCode",
  "failureMessage",
  "rollbackOfRunId",
  "createdAt",
  "updatedAt",
] as const;

const LEGACY_ITEM_BASE_COLUMNS = [
  "id",
  "runId",
  "entityType",
  "action",
  "entityId",
  "previousStateJson",
  "nextStateJson",
  "result",
  "skipReason",
  "createdAt",
  "updatedAt",
] as const;

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256Hex(readFileSync(path));
}

export function resolveSqliteDatabasePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_SQLITE_REQUIRED,
      "الإصلاح يدعم SQLite فقط"
    );
  }
  const raw = databaseUrl.slice("file:".length);
  if (!raw || raw.includes("://")) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_SQLITE_REQUIRED,
      "DATABASE_URL غير صالح لمسار SQLite"
    );
  }
  return resolve(raw);
}

function openDb(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_DATABASE_REQUIRED,
      "ملف قاعدة البيانات غير موجود"
    );
  }
  return new DatabaseSync(dbPath);
}

function listColumns(db: DatabaseSync, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as ColumnInfo[];
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(table) as { ok: number } | undefined;
  return Boolean(row);
}

function hasUniqueRunSequenceIndex(db: DatabaseSync): boolean {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ClassificationTaxonomyRestructureItem'`
    )
    .all() as Array<{ name: string; sql: string | null }>;
  return rows.some(
    (r) =>
      r.name === "ClassificationTaxonomyRestructureItem_runId_sequence_key" ||
      (r.sql ?? "").includes('"runId", "sequence"') ||
      (r.sql ?? "").includes("runId, sequence")
  );
}

function migrationFilePath(cwd = process.cwd()): string {
  return resolve(
    cwd,
    "prisma/migrations",
    TAXONOMY_RESTRUCTURE_MIGRATION_NAME,
    "migration.sql"
  );
}

function readMigrationRecord(db: DatabaseSync): {
  recorded: boolean;
  finished: boolean;
  rolledBack: boolean;
  checksum: string | null;
} {
  if (!tableExists(db, "_prisma_migrations")) {
    return { recorded: false, finished: false, rolledBack: false, checksum: null };
  }
  const row = db
    .prepare(
      `SELECT finished_at, rolled_back_at, checksum
       FROM _prisma_migrations
       WHERE migration_name = ?
       LIMIT 1`
    )
    .get(TAXONOMY_RESTRUCTURE_MIGRATION_NAME) as
    | { finished_at: number | null; rolled_back_at: number | null; checksum: string }
    | undefined;
  if (!row) {
    return { recorded: false, finished: false, rolledBack: false, checksum: null };
  }
  return {
    recorded: true,
    finished: row.finished_at != null,
    rolledBack: row.rolled_back_at != null,
    checksum: row.checksum ?? null,
  };
}

function classifySchemaState(input: {
  runExists: boolean;
  itemExists: boolean;
  runColumns: string[];
  itemColumns: string[];
  hasUnique: boolean;
}): RepairSchemaState {
  const { runExists, itemExists, runColumns, itemColumns, hasUnique } = input;
  if (!runExists && !itemExists) return "MISSING_TABLES";
  if (!runExists || !itemExists) return "UNKNOWN_SCHEMA";

  const runSet = new Set(runColumns);
  const itemSet = new Set(itemColumns);
  const runComplete = REQUIRED_RUN_COLUMNS.every((c) => runSet.has(c));
  const itemComplete = REQUIRED_ITEM_COLUMNS.every((c) => itemSet.has(c));
  if (runComplete && itemComplete && hasUnique) return "NO_ACTION_REQUIRED";

  const runLegacyOk = LEGACY_RUN_BASE_COLUMNS.every((c) => runSet.has(c));
  const itemLegacyOk = LEGACY_ITEM_BASE_COLUMNS.every((c) => itemSet.has(c));
  const missingOnlyExpected =
    runLegacyOk &&
    itemLegacyOk &&
    [...runSet].every((c) => (REQUIRED_RUN_COLUMNS as readonly string[]).includes(c)) &&
    [...itemSet].every((c) => (REQUIRED_ITEM_COLUMNS as readonly string[]).includes(c));

  if (missingOnlyExpected && (!runComplete || !itemComplete || !hasUnique)) {
    return "LEGACY_MISSING_COLUMNS";
  }
  return "UNKNOWN_SCHEMA";
}

function buildConfirmationToken(payload: {
  dbPath: string;
  schemaState: RepairSchemaState;
  runColumns: string[];
  itemColumns: string[];
  runs: number;
  items: number;
}): string {
  const digest = sha256Hex(
    [
      payload.dbPath,
      payload.schemaState,
      payload.runColumns.join(","),
      payload.itemColumns.join(","),
      String(payload.runs),
      String(payload.items),
    ].join("|")
  );
  return `REPAIR-${digest.slice(0, 12).toUpperCase()}`;
}

export function inspectTaxonomyMigrationRepair(input: {
  databaseUrl: string;
  cwd?: string;
}): RepairInspectReport {
  const dbPath = resolveSqliteDatabasePath(input.databaseUrl);
  const db = openDb(dbPath);
  try {
    const runExists = tableExists(db, "ClassificationTaxonomyRestructureRun");
    const itemExists = tableExists(db, "ClassificationTaxonomyRestructureItem");
    const runColumns = runExists
      ? listColumns(db, "ClassificationTaxonomyRestructureRun").map((c) => c.name)
      : [];
    const itemColumns = itemExists
      ? listColumns(db, "ClassificationTaxonomyRestructureItem").map((c) => c.name)
      : [];
    const hasUnique = itemExists ? hasUniqueRunSequenceIndex(db) : false;
    const schemaState = classifySchemaState({
      runExists,
      itemExists,
      runColumns,
      itemColumns,
      hasUnique,
    });

    const runs = runExists
      ? Number(
          (db.prepare(`SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureRun"`).get() as { c: number })
            .c
        )
      : 0;
    const items = itemExists
      ? Number(
          (db.prepare(`SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureItem"`).get() as { c: number })
            .c
        )
      : 0;

    const statusDistribution: Record<string, number> = {};
    if (runExists) {
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) AS c FROM "ClassificationTaxonomyRestructureRun" GROUP BY status ORDER BY status`
        )
        .all() as Array<{ status: string; c: number }>;
      for (const row of rows) statusDistribution[row.status] = Number(row.c);
    }

    const maxSequenceByRunPrefix: RepairInspectReport["maxSequenceByRunPrefix"] = [];
    if (itemExists && itemColumns.includes("sequence")) {
      const rows = db
        .prepare(
          `SELECT runId, MAX(sequence) AS maxSequence
           FROM "ClassificationTaxonomyRestructureItem"
           GROUP BY runId
           ORDER BY runId`
        )
        .all() as Array<{ runId: string; maxSequence: number | null }>;
      for (const row of rows) {
        maxSequenceByRunPrefix.push({
          runIdPrefix: row.runId.slice(0, 8),
          maxSequence: row.maxSequence,
        });
      }
    }

    let nullSequenceCount = 0;
    let duplicateSequenceGroups = 0;
    if (itemExists && itemColumns.includes("sequence")) {
      nullSequenceCount = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureItem" WHERE sequence IS NULL`
            )
            .get() as { c: number }
        ).c
      );
      duplicateSequenceGroups = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM (
                 SELECT runId, sequence, COUNT(*) AS n
                 FROM "ClassificationTaxonomyRestructureItem"
                 GROUP BY runId, sequence
                 HAVING n > 1
               )`
            )
            .get() as { c: number }
        ).c
      );
    }

    const migration = readMigrationRecord(db);
    const filePath = migrationFilePath(input.cwd);
    const fileChecksum = existsSync(filePath) ? sha256File(filePath) : null;

    const confirmationToken = buildConfirmationToken({
      dbPath,
      schemaState,
      runColumns,
      itemColumns,
      runs,
      items,
    });

    return {
      mode: "inspect",
      databaseProvider: "sqlite",
      schemaState,
      actionRequired: schemaState === "LEGACY_MISSING_COLUMNS",
      confirmationToken,
      runTable: {
        exists: runExists,
        columns: runColumns,
        missingColumns: REQUIRED_RUN_COLUMNS.filter((c) => !runColumns.includes(c)),
        rowCount: runs,
      },
      itemTable: {
        exists: itemExists,
        columns: itemColumns,
        missingColumns: REQUIRED_ITEM_COLUMNS.filter((c) => !itemColumns.includes(c)),
        rowCount: items,
        hasRunSequenceUnique: hasUnique,
        duplicateSequenceGroups,
        nullSequenceCount,
      },
      migration: {
        name: TAXONOMY_RESTRUCTURE_MIGRATION_NAME,
        recorded: migration.recorded,
        finished: migration.finished,
        rolledBack: migration.rolledBack,
        checksumMatchesFile:
          fileChecksum && migration.checksum ? migration.checksum === fileChecksum : null,
        recordedChecksumPrefix: migration.checksum?.slice(0, 12) ?? null,
        fileChecksumPrefix: fileChecksum?.slice(0, 12) ?? null,
      },
      statusDistribution,
      maxSequenceByRunPrefix,
    };
  } finally {
    db.close();
  }
}

function assertBackupValid(backupPath: string, dbPath: string): void {
  if (!backupPath) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_BACKUP_REQUIRED,
      "Apply يتطلب --backup-path لنسخة احتياطية موجودة"
    );
  }
  const absolute = resolve(backupPath);
  if (!existsSync(absolute)) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_BACKUP_REQUIRED,
      "ملف النسخة الاحتياطية غير موجود"
    );
  }
  if (resolve(absolute) === resolve(dbPath)) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_BACKUP_INVALID,
      "مسار النسخة الاحتياطية يطابق قاعدة البيانات الحالية"
    );
  }
  const backupSize = statSync(absolute).size;
  if (backupSize <= 0) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_BACKUP_INVALID,
      "ملف النسخة الاحتياطية فارغ"
    );
  }
}

function addRunColumnsIfMissing(db: DatabaseSync, columns: string[]): void {
  if (!columns.includes("rolledBackCount")) {
    db.exec(
      `ALTER TABLE "ClassificationTaxonomyRestructureRun" ADD COLUMN "rolledBackCount" INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!columns.includes("skippedCount")) {
    db.exec(
      `ALTER TABLE "ClassificationTaxonomyRestructureRun" ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0`
    );
  }
}

function rebuildItemTableWithSequence(db: DatabaseSync): number {
  const before = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureItem"`).get() as { c: number }).c
  );
  db.exec(`
    CREATE TABLE "new_ClassificationTaxonomyRestructureItem" (
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
      CONSTRAINT "ClassificationTaxonomyRestructureItem_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ClassificationTaxonomyRestructureRun" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    );
  `);

  db.exec(`
      INSERT INTO "new_ClassificationTaxonomyRestructureItem" (
        "id", "runId", "sequence", "entityType", "action", "entityId",
        "previousStateJson", "nextStateJson", "result", "skipReason", "createdAt", "updatedAt"
      )
      SELECT
        src."id",
        src."runId",
        (
          SELECT COUNT(*)
          FROM "ClassificationTaxonomyRestructureItem" AS peer
          WHERE peer."runId" = src."runId"
            AND (
              peer."createdAt" < src."createdAt"
              OR (peer."createdAt" = src."createdAt" AND peer."id" <= src."id")
            )
        ) AS "sequence",
        src."entityType",
        src."action",
        src."entityId",
        src."previousStateJson",
        src."nextStateJson",
        src."result",
        src."skipReason",
        src."createdAt",
        src."updatedAt"
      FROM "ClassificationTaxonomyRestructureItem" AS src
  `);

  db.exec(`DROP TABLE "ClassificationTaxonomyRestructureItem"`);
  db.exec(
    `ALTER TABLE "new_ClassificationTaxonomyRestructureItem" RENAME TO "ClassificationTaxonomyRestructureItem"`
  );
  db.exec(
    `CREATE INDEX "ClassificationTaxonomyRestructureItem_runId_idx" ON "ClassificationTaxonomyRestructureItem"("runId")`
  );
  db.exec(
    `CREATE INDEX "ClassificationTaxonomyRestructureItem_entityType_idx" ON "ClassificationTaxonomyRestructureItem"("entityType")`
  );
  db.exec(
    `CREATE INDEX "ClassificationTaxonomyRestructureItem_action_idx" ON "ClassificationTaxonomyRestructureItem"("action")`
  );
  db.exec(
    `CREATE INDEX "ClassificationTaxonomyRestructureItem_result_idx" ON "ClassificationTaxonomyRestructureItem"("result")`
  );
  db.exec(
    `CREATE UNIQUE INDEX "ClassificationTaxonomyRestructureItem_runId_sequence_key" ON "ClassificationTaxonomyRestructureItem"("runId", "sequence")`
  );
  const after = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureItem"`).get() as { c: number }).c
  );
  if (after !== before) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
      "فشل نسخ عناصر Restructure أثناء إعادة البناء"
    );
  }
  return after;
}

function syncMigrationChecksum(db: DatabaseSync, cwd?: string): boolean {
  const filePath = migrationFilePath(cwd);
  if (!existsSync(filePath)) return false;
  const fileChecksum = sha256File(filePath);
  const migration = readMigrationRecord(db);
  if (!migration.recorded) return false;
  if (migration.checksum === fileChecksum) return false;
  db.prepare(`UPDATE _prisma_migrations SET checksum = ? WHERE migration_name = ?`).run(
    fileChecksum,
    TAXONOMY_RESTRUCTURE_MIGRATION_NAME
  );
  return true;
}

export function applyTaxonomyMigrationRepair(input: {
  databaseUrl: string;
  confirm?: string;
  backupPath?: string;
  cwd?: string;
}): RepairApplyReport {
  const inspect = inspectTaxonomyMigrationRepair({
    databaseUrl: input.databaseUrl,
    cwd: input.cwd,
  });
  if (!input.confirm) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_CONFIRMATION_REQUIRED,
      "Apply يتطلب --confirm"
    );
  }
  if (input.confirm !== inspect.confirmationToken) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_CONFIRMATION_INVALID,
      "رمز تأكيد الإصلاح غير صحيح"
    );
  }

  const dbPath = resolveSqliteDatabasePath(input.databaseUrl);
  assertBackupValid(input.backupPath ?? "", dbPath);

  if (inspect.migration.recorded && (!inspect.migration.finished || inspect.migration.rolledBack)) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_MIGRATION_STATE_UNSAFE,
      "حالة migration غير آمنة للإصلاح"
    );
  }

  if (inspect.schemaState === "UNKNOWN_SCHEMA" || inspect.schemaState === "MISSING_TABLES") {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
      "بنية الجداول غير معروفة أو ناقصة بشكل غير متوقع",
      { schemaState: inspect.schemaState }
    );
  }

  const db = openDb(dbPath);
  try {
    const runsBefore = inspect.runTable.rowCount;
    const itemsBefore = inspect.itemTable.rowCount;
    let sequencesAssigned = 0;
    let changed = false;
    let migrationChecksumUpdated = false;

    if (inspect.schemaState === "NO_ACTION_REQUIRED") {
      migrationChecksumUpdated = syncMigrationChecksum(db, input.cwd);
      const after = inspectTaxonomyMigrationRepair({
        databaseUrl: input.databaseUrl,
        cwd: input.cwd,
      });
      return {
        mode: "apply",
        schemaStateBefore: inspect.schemaState,
        schemaStateAfter: after.schemaState,
        changed: migrationChecksumUpdated,
        runsBefore,
        runsAfter: after.runTable.rowCount,
        itemsBefore,
        itemsAfter: after.itemTable.rowCount,
        sequencesAssigned: 0,
        uniqueIndexPresent: after.itemTable.hasRunSequenceUnique,
        migrationChecksumUpdated,
      };
    }

    db.exec("BEGIN");
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      const runColumns = listColumns(db, "ClassificationTaxonomyRestructureRun").map((c) => c.name);
      const itemColumns = listColumns(db, "ClassificationTaxonomyRestructureItem").map((c) => c.name);
      addRunColumnsIfMissing(db, runColumns);
      if (!itemColumns.includes("sequence") || !hasUniqueRunSequenceIndex(db)) {
        sequencesAssigned = rebuildItemTableWithSequence(db);
      }
      migrationChecksumUpdated = syncMigrationChecksum(db, input.cwd);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("COMMIT");
      changed = true;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      throw error;
    }

    const after = inspectTaxonomyMigrationRepair({
      databaseUrl: input.databaseUrl,
      cwd: input.cwd,
    });
    if (after.schemaState !== "NO_ACTION_REQUIRED") {
      throw new TaxonomyMigrationRepairError(
        REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
        "فشل التحقق بعد الإصلاح"
      );
    }
    if (after.runTable.rowCount !== runsBefore || after.itemTable.rowCount !== itemsBefore) {
      throw new TaxonomyMigrationRepairError(
        REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
        "عدد السجلات تغير بعد الإصلاح"
      );
    }

    return {
      mode: "apply",
      schemaStateBefore: inspect.schemaState,
      schemaStateAfter: after.schemaState,
      changed,
      runsBefore,
      runsAfter: after.runTable.rowCount,
      itemsBefore,
      itemsAfter: after.itemTable.rowCount,
      sequencesAssigned,
      uniqueIndexPresent: after.itemTable.hasRunSequenceUnique,
      migrationChecksumUpdated,
    };
  } finally {
    db.close();
  }
}
