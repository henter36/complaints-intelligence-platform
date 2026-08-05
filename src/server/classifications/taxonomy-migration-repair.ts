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
  REPAIR_FOREIGN_KEY_VIOLATION: "REPAIR_FOREIGN_KEY_VIOLATION",
  REPAIR_FOREIGN_KEYS_STATE: "REPAIR_FOREIGN_KEYS_STATE",
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

export type SqliteIndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

export type SqliteIndexInfoRow = {
  seqno: number;
  cid: number;
  name: string | null;
};

type ColumnInfo = { name: string };

type TableInspection = {
  exists: boolean;
  columns: string[];
  missingColumns: string[];
  rowCount: number;
};

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

const RUN_SEQUENCE_UNIQUE_COLUMNS = ["runId", "sequence"] as const;

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256Hex(readFileSync(path));
}

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_]\w*$/.test(identifier)) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
      "اسم SQLite غير صالح"
    );
  }
  return `"${identifier}"`;
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
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColumnInfo[];
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(table) as { ok: number } | undefined;
  return Boolean(row);
}

export function listTableIndexes(db: DatabaseSync, tableName: string): SqliteIndexListRow[] {
  return db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all() as SqliteIndexListRow[];
}

export function listIndexColumns(db: DatabaseSync, indexName: string): string[] {
  const rows = db
    .prepare(`PRAGMA index_info(${quoteIdent(indexName)})`)
    .all() as SqliteIndexInfoRow[];
  return [...rows]
    .sort((a, b) => a.seqno - b.seqno)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

export function isExactUniqueIndex(
  db: DatabaseSync,
  index: SqliteIndexListRow,
  expectedColumns: readonly string[]
): boolean {
  if (index.unique !== 1 || index.partial !== 0) return false;
  const columns = listIndexColumns(db, index.name);
  if (columns.length !== expectedColumns.length) return false;
  return expectedColumns.every((column, idx) => columns[idx] === column);
}

export function hasUniqueRunSequenceIndex(db: DatabaseSync): boolean {
  return listTableIndexes(db, "ClassificationTaxonomyRestructureItem").some((index) =>
    isExactUniqueIndex(db, index, RUN_SEQUENCE_UNIQUE_COLUMNS)
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

export function classifySchemaState(input: {
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

function countTableRows(db: DatabaseSync, tableName: string, exists: boolean): number {
  if (!exists) return 0;
  return Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(tableName)}`).get() as { c: number }).c
  );
}

function inspectTable(
  db: DatabaseSync,
  tableName: string,
  requiredColumns: readonly string[]
): TableInspection {
  const exists = tableExists(db, tableName);
  const columns = exists ? listColumns(db, tableName).map((c) => c.name) : [];
  return {
    exists,
    columns,
    missingColumns: requiredColumns.filter((c) => !columns.includes(c)),
    rowCount: countTableRows(db, tableName, exists),
  };
}

function readStatusDistribution(
  db: DatabaseSync,
  runTableExists: boolean
): Record<string, number> {
  if (!runTableExists) return {};
  const statusDistribution: Record<string, number> = {};
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM "ClassificationTaxonomyRestructureRun" GROUP BY status ORDER BY status`
    )
    .all() as Array<{ status: string; c: number }>;
  for (const row of rows) statusDistribution[row.status] = Number(row.c);
  return statusDistribution;
}

function readSequenceDiagnostics(
  db: DatabaseSync,
  itemTable: TableInspection
): {
  maxSequenceByRunPrefix: Array<{ runIdPrefix: string; maxSequence: number | null }>;
  nullSequenceCount: number;
  duplicateSequenceGroups: number;
} {
  if (!itemTable.exists || !itemTable.columns.includes("sequence")) {
    return { maxSequenceByRunPrefix: [], nullSequenceCount: 0, duplicateSequenceGroups: 0 };
  }

  const maxSequenceByRunPrefix = (
    db
      .prepare(
        `SELECT runId, MAX(sequence) AS maxSequence
         FROM "ClassificationTaxonomyRestructureItem"
         GROUP BY runId
         ORDER BY runId`
      )
      .all() as Array<{ runId: string; maxSequence: number | null }>
  ).map((row) => ({
    runIdPrefix: row.runId.slice(0, 8),
    maxSequence: row.maxSequence,
  }));

  const nullSequenceCount = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM "ClassificationTaxonomyRestructureItem" WHERE sequence IS NULL`
        )
        .get() as { c: number }
    ).c
  );
  const duplicateSequenceGroups = Number(
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

  return { maxSequenceByRunPrefix, nullSequenceCount, duplicateSequenceGroups };
}

function inspectMigrationRecord(
  db: DatabaseSync,
  cwd?: string
): RepairInspectReport["migration"] {
  const migration = readMigrationRecord(db);
  const filePath = migrationFilePath(cwd);
  const fileChecksum = existsSync(filePath) ? sha256File(filePath) : null;
  return {
    name: TAXONOMY_RESTRUCTURE_MIGRATION_NAME,
    recorded: migration.recorded,
    finished: migration.finished,
    rolledBack: migration.rolledBack,
    checksumMatchesFile:
      fileChecksum && migration.checksum ? migration.checksum === fileChecksum : null,
    recordedChecksumPrefix: migration.checksum?.slice(0, 12) ?? null,
    fileChecksumPrefix: fileChecksum?.slice(0, 12) ?? null,
  };
}

function buildRepairInspectReport(
  db: DatabaseSync,
  dbPath: string,
  cwd?: string
): RepairInspectReport {
  const runTable = inspectTable(db, "ClassificationTaxonomyRestructureRun", REQUIRED_RUN_COLUMNS);
  const itemTable = inspectTable(
    db,
    "ClassificationTaxonomyRestructureItem",
    REQUIRED_ITEM_COLUMNS
  );
  const hasUnique = itemTable.exists ? hasUniqueRunSequenceIndex(db) : false;
  const schemaState = classifySchemaState({
    runExists: runTable.exists,
    itemExists: itemTable.exists,
    runColumns: runTable.columns,
    itemColumns: itemTable.columns,
    hasUnique,
  });
  const sequenceDiagnostics = readSequenceDiagnostics(db, itemTable);

  return {
    mode: "inspect",
    databaseProvider: "sqlite",
    schemaState,
    actionRequired: schemaState === "LEGACY_MISSING_COLUMNS",
    confirmationToken: buildConfirmationToken({
      dbPath,
      schemaState,
      runColumns: runTable.columns,
      itemColumns: itemTable.columns,
      runs: runTable.rowCount,
      items: itemTable.rowCount,
    }),
    runTable,
    itemTable: {
      ...itemTable,
      hasRunSequenceUnique: hasUnique,
      duplicateSequenceGroups: sequenceDiagnostics.duplicateSequenceGroups,
      nullSequenceCount: sequenceDiagnostics.nullSequenceCount,
    },
    migration: inspectMigrationRecord(db, cwd),
    statusDistribution: readStatusDistribution(db, runTable.exists),
    maxSequenceByRunPrefix: sequenceDiagnostics.maxSequenceByRunPrefix,
  };
}

export function inspectTaxonomyMigrationRepair(input: {
  databaseUrl: string;
  cwd?: string;
}): RepairInspectReport {
  const dbPath = resolveSqliteDatabasePath(input.databaseUrl);
  const db = openDb(dbPath);
  try {
    return buildRepairInspectReport(db, dbPath, input.cwd);
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
  if (statSync(absolute).size <= 0) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_BACKUP_INVALID,
      "ملف النسخة الاحتياطية فارغ"
    );
  }
}

function readForeignKeysEnabled(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  return Number(row.foreign_keys) === 1;
}

function setForeignKeysEnabled(db: DatabaseSync, enabled: boolean): void {
  db.exec(`PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`);
}

function assertForeignKeysState(db: DatabaseSync, expected: boolean): void {
  if (readForeignKeysEnabled(db) !== expected) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_FOREIGN_KEYS_STATE,
      "تعذر ضبط حالة foreign_keys"
    );
  }
}

function assertNoForeignKeyViolations(db: DatabaseSync): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_FOREIGN_KEY_VIOLATION,
      "فشل فحص المفاتيح الأجنبية بعد الإصلاح",
      { violationCount: violations.length }
    );
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // ignore when no active transaction
  }
}

function dropTempItemTableIfPresent(db: DatabaseSync): void {
  if (tableExists(db, "new_ClassificationTaxonomyRestructureItem")) {
    db.exec(`DROP TABLE "new_ClassificationTaxonomyRestructureItem"`);
  }
}

function runRepairTransaction<T>(db: DatabaseSync, operation: () => T): T {
  const wasEnabled = readForeignKeysEnabled(db);
  setForeignKeysEnabled(db, false);
  assertForeignKeysState(db, false);

  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const result = operation();
    assertNoForeignKeyViolations(db);
    db.exec("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) rollbackQuietly(db);
    dropTempItemTableIfPresent(db);
    throw error;
  } finally {
    setForeignKeysEnabled(db, wasEnabled);
    assertForeignKeysState(db, wasEnabled);
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
  const before = countTableRows(db, "ClassificationTaxonomyRestructureItem", true);
  dropTempItemTableIfPresent(db);
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
  const after = countTableRows(db, "ClassificationTaxonomyRestructureItem", true);
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

function validateRepairApplyRequest(input: {
  inspect: RepairInspectReport;
  confirm?: string;
  backupPath?: string;
  dbPath: string;
}): void {
  if (!input.confirm) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_CONFIRMATION_REQUIRED,
      "Apply يتطلب --confirm"
    );
  }
  if (input.confirm !== input.inspect.confirmationToken) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_CONFIRMATION_INVALID,
      "رمز تأكيد الإصلاح غير صحيح"
    );
  }
  assertBackupValid(input.backupPath ?? "", input.dbPath);
  if (
    input.inspect.migration.recorded &&
    (!input.inspect.migration.finished || input.inspect.migration.rolledBack)
  ) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_MIGRATION_STATE_UNSAFE,
      "حالة migration غير آمنة للإصلاح"
    );
  }
  if (
    input.inspect.schemaState === "UNKNOWN_SCHEMA" ||
    input.inspect.schemaState === "MISSING_TABLES"
  ) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
      "بنية الجداول غير معروفة أو ناقصة بشكل غير متوقع",
      { schemaState: input.inspect.schemaState }
    );
  }
}

function buildRepairApplyReport(input: {
  schemaStateBefore: RepairSchemaState;
  after: RepairInspectReport;
  changed: boolean;
  runsBefore: number;
  itemsBefore: number;
  sequencesAssigned: number;
  migrationChecksumUpdated: boolean;
}): RepairApplyReport {
  return {
    mode: "apply",
    schemaStateBefore: input.schemaStateBefore,
    schemaStateAfter: input.after.schemaState,
    changed: input.changed,
    runsBefore: input.runsBefore,
    runsAfter: input.after.runTable.rowCount,
    itemsBefore: input.itemsBefore,
    itemsAfter: input.after.itemTable.rowCount,
    sequencesAssigned: input.sequencesAssigned,
    uniqueIndexPresent: input.after.itemTable.hasRunSequenceUnique,
    migrationChecksumUpdated: input.migrationChecksumUpdated,
  };
}

function verifyRepairOutcome(input: {
  databaseUrl: string;
  cwd?: string;
  runsBefore: number;
  itemsBefore: number;
}): RepairInspectReport {
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
  if (
    after.runTable.rowCount !== input.runsBefore ||
    after.itemTable.rowCount !== input.itemsBefore
  ) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
      "عدد السجلات تغير بعد الإصلاح"
    );
  }
  if (!after.itemTable.hasRunSequenceUnique) {
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
      "القيد الفريد runId+sequence غير موجود بعد الإصلاح"
    );
  }
  return after;
}

function handleNoActionRequired(input: {
  db: DatabaseSync;
  inspect: RepairInspectReport;
  databaseUrl: string;
  cwd?: string;
}): RepairApplyReport {
  const migrationChecksumUpdated = syncMigrationChecksum(input.db, input.cwd);
  const after = inspectTaxonomyMigrationRepair({
    databaseUrl: input.databaseUrl,
    cwd: input.cwd,
  });
  return buildRepairApplyReport({
    schemaStateBefore: input.inspect.schemaState,
    after,
    changed: migrationChecksumUpdated,
    runsBefore: input.inspect.runTable.rowCount,
    itemsBefore: input.inspect.itemTable.rowCount,
    sequencesAssigned: 0,
    migrationChecksumUpdated,
  });
}

function performLegacySchemaRepair(
  db: DatabaseSync,
  cwd?: string
): { sequencesAssigned: number; migrationChecksumUpdated: boolean } {
  let sequencesAssigned = 0;
  const migrationChecksumUpdated = runRepairTransaction(db, () => {
    const runColumns = listColumns(db, "ClassificationTaxonomyRestructureRun").map((c) => c.name);
    const itemColumns = listColumns(db, "ClassificationTaxonomyRestructureItem").map((c) => c.name);
    addRunColumnsIfMissing(db, runColumns);
    if (!itemColumns.includes("sequence") || !hasUniqueRunSequenceIndex(db)) {
      sequencesAssigned = rebuildItemTableWithSequence(db);
    }
    return syncMigrationChecksum(db, cwd);
  });
  return { sequencesAssigned, migrationChecksumUpdated };
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
  const dbPath = resolveSqliteDatabasePath(input.databaseUrl);
  validateRepairApplyRequest({
    inspect,
    confirm: input.confirm,
    backupPath: input.backupPath,
    dbPath,
  });

  const db = openDb(dbPath);
  try {
    if (inspect.schemaState === "NO_ACTION_REQUIRED") {
      return handleNoActionRequired({
        db,
        inspect,
        databaseUrl: input.databaseUrl,
        cwd: input.cwd,
      });
    }

    const { sequencesAssigned, migrationChecksumUpdated } = performLegacySchemaRepair(
      db,
      input.cwd
    );
    const after = verifyRepairOutcome({
      databaseUrl: input.databaseUrl,
      cwd: input.cwd,
      runsBefore: inspect.runTable.rowCount,
      itemsBefore: inspect.itemTable.rowCount,
    });
    return buildRepairApplyReport({
      schemaStateBefore: inspect.schemaState,
      after,
      changed: true,
      runsBefore: inspect.runTable.rowCount,
      itemsBefore: inspect.itemTable.rowCount,
      sequencesAssigned,
      migrationChecksumUpdated,
    });
  } finally {
    db.close();
  }
}

export const __repairTestUtils = {
  readForeignKeysEnabled,
  setForeignKeysEnabled,
  assertForeignKeysState,
  runRepairTransaction,
  quoteIdent,
};
