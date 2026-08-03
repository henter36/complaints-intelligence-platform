// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

const MIGRATION_SQL = readFileSync(
  path.join(import.meta.dirname, "migration.sql"),
  "utf8"
);

// Minimal CREATE TABLE statements that match the columns the migration touches.
// Foreign-key constraints are omitted so the test runs without a full schema.
const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "TextRiskScanRun" (
  "id"                  TEXT    NOT NULL PRIMARY KEY,
  "status"              TEXT    NOT NULL DEFAULT 'PENDING',
  "ruleVersion"         TEXT    NOT NULL,
  "importBatchId"       TEXT,
  "totalComplaints"     INTEGER NOT NULL DEFAULT 0,
  "processedComplaints" INTEGER NOT NULL DEFAULT 0,
  "matchedSignals"      INTEGER NOT NULL DEFAULT 0,
  "lastComplaintId"     TEXT,
  "startedAt"           DATETIME,
  "completedAt"         DATETIME,
  "failedAt"            DATETIME,
  "errorCode"           TEXT,
  "errorMessage"        TEXT,
  "createdAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "TextRiskSignal" (
  "id"                     TEXT    NOT NULL PRIMARY KEY,
  "complaintId"            TEXT    NOT NULL,
  "signalType"             TEXT    NOT NULL,
  "ruleId"                 TEXT    NOT NULL,
  "ruleVersion"            TEXT    NOT NULL,
  "title"                  TEXT    NOT NULL,
  "description"            TEXT    NOT NULL,
  "severity"               TEXT    NOT NULL,
  "confidenceScore"        REAL    NOT NULL DEFAULT 0,
  "certainty"              TEXT    NOT NULL DEFAULT 'SUSPECTED',
  "evidenceSpans"          TEXT    NOT NULL DEFAULT '[]',
  "normalizedEvidenceHash" TEXT    NOT NULL DEFAULT '',
  "sourceTextHash"         TEXT    NOT NULL DEFAULT '',
  "detectedBy"             TEXT    NOT NULL DEFAULT 'RULE',
  "reviewStatus"           TEXT    NOT NULL DEFAULT 'PENDING_REVIEW',
  "region"                 TEXT,
  "facility"               TEXT,
  "department"             TEXT,
  "createdAt"              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(CREATE_TABLES_SQL);
  return db;
}

function applyMigration(db: DatabaseSync): void {
  db.exec(MIGRATION_SQL);
}

function insertSignal(
  db: DatabaseSync,
  id: string,
  severity: string
): void {
  db.prepare(
    `INSERT INTO "TextRiskSignal"
      ("id", "complaintId", "signalType", "ruleId", "ruleVersion", "title",
       "description", "severity", "confidenceScore", "normalizedEvidenceHash",
       "sourceTextHash", "evidenceSpans")
     VALUES (?, 'cmp-1', 'POISONING', 'rule-1', 'v1', 'title',
             'desc', ?, 0.9, 'hash', 'src', '[]')`
  ).run(id, severity);
}

function getRank(db: DatabaseSync, id: string): number {
  const row = db.prepare(
    `SELECT "severityRank" FROM "TextRiskSignal" WHERE "id" = ?`
  ).get(id) as { severityRank: number };
  return row.severityRank;
}

describe("migration: add_text_risk_scan_lock_and_severity_rank", () => {
  describe("severityRank backfill", () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = freshDb();
      insertSignal(db, "crit", "CRITICAL");
      insertSignal(db, "high", "HIGH");
      insertSignal(db, "med", "MEDIUM");
      insertSignal(db, "low", "LOW");
      applyMigration(db);
    });

    it("sets CRITICAL → 4", () => {
      expect(getRank(db, "crit")).toBe(4);
    });

    it("sets HIGH → 3", () => {
      expect(getRank(db, "high")).toBe(3);
    });

    it("sets MEDIUM → 2", () => {
      expect(getRank(db, "med")).toBe(2);
    });

    it("sets LOW (ELSE branch) → 1", () => {
      expect(getRank(db, "low")).toBe(1);
    });
  });

  it("does not overwrite a row that already has a non-zero severityRank", () => {
    const db = freshDb();
    // Apply migration first, then directly set a non-zero rank to simulate
    // a row that was already ranked before this migration ran again.
    insertSignal(db, "pre-ranked", "LOW");
    applyMigration(db);
    // Manually update to simulate a pre-existing non-zero rank
    db.exec(`UPDATE "TextRiskSignal" SET "severityRank" = 3 WHERE "id" = 'pre-ranked'`);

    // Re-run only the UPDATE portion of the migration; WHERE severityRank = 0 must skip it
    db.exec(`
      UPDATE "TextRiskSignal" SET "severityRank" = CASE
        WHEN "severity" = 'CRITICAL' THEN 4
        WHEN "severity" = 'HIGH'     THEN 3
        WHEN "severity" = 'MEDIUM'   THEN 2
        ELSE 1
      END
      WHERE "severityRank" = 0
    `);

    expect(getRank(db, "pre-ranked")).toBe(3);
  });

  it("runs successfully on an empty TextRiskSignal table", () => {
    const db = freshDb();
    expect(() => applyMigration(db)).not.toThrow();

    const count = (db.prepare(
      `SELECT COUNT(*) as c FROM "TextRiskSignal"`
    ).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("runs successfully on a table with existing data", () => {
    const db = freshDb();
    insertSignal(db, "s1", "CRITICAL");
    insertSignal(db, "s2", "HIGH");
    insertSignal(db, "s3", "LOW");

    expect(() => applyMigration(db)).not.toThrow();

    expect(getRank(db, "s1")).toBe(4);
    expect(getRank(db, "s2")).toBe(3);
    expect(getRank(db, "s3")).toBe(1);
  });

  it("creates the unique index on activeLockKey in TextRiskScanRun", () => {
    const db = freshDb();
    applyMigration(db);

    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='TextRiskScanRun_activeLockKey_key'`
    ).get();
    expect(idx).toBeDefined();
  });

  it("creates the composite index on severityRank+createdAt in TextRiskSignal", () => {
    const db = freshDb();
    applyMigration(db);

    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='TextRiskSignal_severityRank_createdAt_idx'`
    ).get();
    expect(idx).toBeDefined();
  });

  it("activeLockKey unique index rejects duplicate non-null values", () => {
    const db = freshDb();
    applyMigration(db);

    db.exec(`
      INSERT INTO "TextRiskScanRun"
        ("id", "ruleVersion", "activeLockKey", "updatedAt")
      VALUES ('run-1', 'v1', 'TEXT_RISK_ACTIVE:v1', CURRENT_TIMESTAMP)
    `);

    expect(() =>
      db.exec(`
        INSERT INTO "TextRiskScanRun"
          ("id", "ruleVersion", "activeLockKey", "updatedAt")
        VALUES ('run-2', 'v1', 'TEXT_RISK_ACTIVE:v1', CURRENT_TIMESTAMP)
      `)
    ).toThrow();
  });

  it("activeLockKey allows multiple NULL values (not unique-constrained)", () => {
    const db = freshDb();
    applyMigration(db);

    expect(() => {
      db.exec(`
        INSERT INTO "TextRiskScanRun"
          ("id", "ruleVersion", "activeLockKey", "updatedAt")
        VALUES ('run-1', 'v1', NULL, CURRENT_TIMESTAMP)
      `);
      db.exec(`
        INSERT INTO "TextRiskScanRun"
          ("id", "ruleVersion", "activeLockKey", "updatedAt")
        VALUES ('run-2', 'v1', NULL, CURRENT_TIMESTAMP)
      `);
    }).not.toThrow();
  });
});
