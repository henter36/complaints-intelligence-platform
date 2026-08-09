// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  normalizeFacilityDisplayName,
  normalizeFacilityName,
} from "../../../src/server/facilities/facility-name";

const MIGRATION_SQL = readFileSync(path.join(import.meta.dirname, "migration.sql"), "utf8");

function freshDb(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE "Complaint" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "facility" TEXT,
      "region" TEXT
    );
    CREATE TABLE "ImportBatch" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "status" TEXT NOT NULL
    );
  `);
  return database;
}

describe("migration: add_facility_registry", () => {
  it("backfills Complaint and Facility with runtime-equivalent canonical keys", () => {
    const database = freshDb();
    const values = [
      "سجن\nالرياض",
      "سجن\r\nالرياض",
      "  سجن   الرياض  ",
      "سجن\u00a0الرياض",
      "سجن\u2003الرياض",
      "سجن\u202fالرياض",
      "سجن\u3000الرياض",
      "سِجْن الرياض",
      "سجن إيواء",
      "سجن أيواء",
      "سجن آيواء",
      "سجـن الرياض",
      "غير محدد",
      "  ",
    ];
    const insert = database.prepare(
      `INSERT INTO "Complaint" ("id", "facility", "region") VALUES (?, ?, 'منطقة الرياض')`
    );
    values.forEach((value, index) => insert.run(`complaint-${index}`, value));
    database.exec(`INSERT INTO "ImportBatch" ("id", "status") VALUES ('confirmed', 'CONFIRMED')`);

    database.exec(MIGRATION_SQL);

    const rows = database.prepare(
      `SELECT "id", "facility", "facilityNormalizedName" FROM "Complaint" ORDER BY "id"`
    ).all() as Array<{ id: string; facility: string; facilityNormalizedName: string | null }>;
    expect(rows).toHaveLength(values.length);
    for (const row of rows) {
      expect(row.facilityNormalizedName).toBe(normalizeFacilityName(row.facility));
    }

    const facilities = database.prepare(
      `SELECT "name", "normalizedName" FROM "Facility" ORDER BY "normalizedName"`
    ).all() as Array<{ name: string; normalizedName: string }>;
    expect(facilities).toHaveLength(new Set(values.flatMap((value) => {
      const key = normalizeFacilityName(value);
      return key ? [key] : [];
    })).size);
    for (const facility of facilities) {
      expect(facility.name).toBe(normalizeFacilityDisplayName(facility.name));
      expect(facility.normalizedName).toBe(normalizeFacilityName(facility.name));
    }

    expect(database.prepare(
      `SELECT "facilitySyncStatus" AS "status" FROM "ImportBatch" WHERE "id" = 'confirmed'`
    ).get()).toEqual({ status: "COMPLETED" });
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });
});
