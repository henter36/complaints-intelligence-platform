import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComplaintStatus,
  FacilityStatus,
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  PrismaClient,
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  backfillFacilityRegistry,
  syncFacilitiesFromImportBatch,
} from "./facility-registry-service";
import { updateFacilityOperationalStatus } from "./facility-management-service";
import { normalizeFacilityName } from "./facility-name";

let prisma: PrismaClient;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-facility-registry-"));
  const databaseUrl = `file:${join(tempDir, "test.db")}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}, 30_000);

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.importBatchRow.deleteMany();
  await prisma.complaint.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.facility.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function complaint(facility: string | null, region: string | null) {
  return prisma.complaint.create({
    data: {
      subject: crypto.randomUUID(),
      status: ComplaintStatus.OPEN,
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      complaintDate: new Date("2026-07-01T00:00:00.000Z"),
      facility,
      region,
    },
  });
}

async function importBatchRow(facility: string, region: string) {
  const batch = await prisma.importBatch.create({
    data: {
      fileName: `${crypto.randomUUID()}.xlsx`,
      originalFileName: "facilities.xlsx",
      fileHash: crypto.randomUUID(),
      fileSize: 100,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-31T00:00:00.000Z"),
      status: ImportBatchStatus.CONFIRMED,
      createdBy: "admin",
    },
  });
  await prisma.importBatchRow.create({
    data: {
      importBatchId: batch.id,
      rowNumber: 1,
      rawData: { facility },
      normalizedData: { facility, region },
      action: ImportRowAction.NEW,
      validationStatus: ImportRowValidationStatus.VALID,
    },
  });
  return batch;
}

describe("Facility Registry", () => {
  it("backfills valid normalized names once, defaults ACTIVE, and keeps a trusted region", async () => {
    await complaint(null, "منطقة الرياض");
    await complaint("   ", "منطقة الرياض");
    await complaint("غير محدد", "منطقة الرياض");
    await complaint("سجن الرياض ", "الرياض");
    await complaint("سجن الرياض", "منطقة الرياض");

    const result = await backfillFacilityRegistry(prisma);
    const facilities = await prisma.facility.findMany();
    expect(result.discovered).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(facilities).toHaveLength(1);
    expect(facilities[0]).toMatchObject({
      name: "سجن الرياض",
      normalizedName: normalizeFacilityName("سجن الرياض"),
      region: "منطقة الرياض",
      status: FacilityStatus.ACTIVE,
      closedAt: null,
    });

    await backfillFacilityRegistry(prisma);
    expect(await prisma.facility.count()).toBe(1);
  });

  it("does not guess a region when historical values conflict and emits a warning", async () => {
    await complaint("سجن متعدد المناطق", "الرياض");
    await complaint("سجن متعدد المناطق", "منطقة مكة المكرمة");
    const result = await backfillFacilityRegistry(prisma);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "FACILITY_REGION_CONFLICT" }),
    ]);
    expect((await prisma.facility.findFirstOrThrow()).region).toBeNull();
  });

  it("enforces unique display/canonical names and Prisma default ACTIVE", async () => {
    await prisma.facility.create({
      data: { name: "سجن فريد", normalizedName: "سجن فريد" },
    });
    const stored = await prisma.facility.findUniqueOrThrow({ where: { name: "سجن فريد" } });
    expect(stored.status).toBe(FacilityStatus.ACTIVE);
    await expect(prisma.facility.create({
      data: { name: "سجن فريد", normalizedName: "مفتاح آخر" },
    })).rejects.toThrow();
  });

  it("syncs imports idempotently and never reopens CLOSED facilities", async () => {
    const batch = await importBatchRow("  سجن استيراد  ", "الرياض");
    await syncFacilitiesFromImportBatch(batch.id, prisma);
    await syncFacilitiesFromImportBatch(batch.id, prisma);
    const created = await prisma.facility.findFirstOrThrow();
    expect(created).toMatchObject({
      name: "سجن استيراد",
      status: FacilityStatus.ACTIVE,
      region: "منطقة الرياض",
    });
    expect(await prisma.facility.count()).toBe(1);

    await prisma.facility.update({
      where: { id: created.id },
      data: { status: FacilityStatus.CLOSED, closedAt: new Date("2026-08-01T00:00:00Z") },
    });
    await syncFacilitiesFromImportBatch(batch.id, prisma);
    expect(await prisma.facility.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      status: FacilityStatus.CLOSED,
      closedAt: new Date("2026-08-01T00:00:00Z"),
    });
  });

  it("changes status without deleting or rewriting complaint history", async () => {
    const facility = await prisma.facility.create({
      data: { name: "سجن محفوظ", normalizedName: "سجن محفوظ" },
    });
    const row = await complaint("سجن محفوظ", "الرياض");
    const before = await prisma.complaint.findUniqueOrThrow({ where: { id: row.id } });

    const closed = await updateFacilityOperationalStatus(
      facility.id,
      { status: "CLOSED", closedAt: "2026-08-01" },
      "admin",
      prisma
    );
    expect(closed.status).toBe(FacilityStatus.CLOSED);
    expect(await prisma.complaint.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);

    const reopened = await updateFacilityOperationalStatus(
      facility.id,
      { status: "ACTIVE", closedAt: "2026-08-01" },
      "admin",
      prisma
    );
    expect(reopened).toMatchObject({ status: FacilityStatus.ACTIVE, closedAt: null });
    expect(await prisma.complaint.count()).toBe(1);
  });
});
