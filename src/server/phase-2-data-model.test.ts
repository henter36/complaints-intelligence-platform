import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, ComplaintPriority, ComplaintStatus, ImportBatchStatus, ImportRowAction, ImportRowValidationStatus, PeriodType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComplaint, softDeleteComplaint, updateComplaintStatus } from "./complaints/complaint-service";
import { arePotentialDuplicateIdentities, buildComplaintFingerprint, resolveComplaintIdentity } from "./complaints/identity-service";
import { calculateRowCounters, confirmImportBatch, createImportBatch, rollbackImportBatch } from "./imports/import-batch-service";

let prisma: PrismaClient;
let tempDir: string;

async function createCategoryAndClassification() {
  const category = await prisma.category.create({
    data: { nameAr: `تصنيف رئيسي ${Date.now()} ${Math.random()}` },
  });
  const classification = await prisma.classification.create({
    data: {
      categoryId: category.id,
      nameAr: "تصنيف فرعي",
      color: "#0d9488",
    },
  });
  return { category, classification };
}

async function createReadyBatch(status: ImportBatchStatus = ImportBatchStatus.READY_FOR_CONFIRMATION) {
  return prisma.importBatch.create({
    data: {
      fileName: `imports/${crypto.randomUUID()}.csv`,
      originalFileName: "synthetic.csv",
      fileHash: crypto.randomUUID(),
      fileSize: 1024,
      mimeType: "text/csv",
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2026-07-31T00:00:00Z"),
      status,
      createdBy: "single-admin",
    },
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-phase-2-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Complaint domain model", () => {
  it("creates complaints, status history, audit log, and enforces externalId uniqueness", async () => {
    const { category, classification } = await createCategoryAndClassification();
    const complaint = await createComplaint(prisma, {
      externalId: "EXT-UNIT-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "شكوى اختبارية",
      description: "وصف صناعي",
      status: ComplaintStatus.OPEN,
      region: "الرياض",
      facility: "منشأة اختبارية",
      department: "إدارة اختبارية",
      categoryId: category.id,
      classificationId: classification.id,
      priority: ComplaintPriority.HIGH,
      severity: ComplaintPriority.MEDIUM,
    }, { actor: "single-admin" });

    await expect(createComplaint(prisma, {
      externalId: "EXT-UNIT-1",
      subject: "شكوى مكررة",
      status: ComplaintStatus.OPEN,
    })).rejects.toThrow();

    const history = await prisma.complaintStatusHistory.findMany({ where: { complaintId: complaint.id } });
    const audit = await prisma.auditLog.findMany({ where: { entityId: complaint.id } });
    expect(history).toHaveLength(1);
    expect(history[0].toStatus).toBe(ComplaintStatus.OPEN);
    expect(audit.some(entry => entry.action === "COMPLAINT_CREATED")).toBe(true);
  });

  it("updates version, writes status history, and supports soft delete", async () => {
    const complaint = await createComplaint(prisma, {
      externalId: "EXT-UNIT-2",
      subject: "شكوى حالة",
      status: ComplaintStatus.OPEN,
    });

    const closed = await updateComplaintStatus(prisma, complaint.id, ComplaintStatus.CLOSED, {
      reason: "تمت المعالجة",
      changedAt: new Date("2026-07-02T00:00:00Z"),
    });
    expect(closed.version).toBe(2);
    expect(closed.closedAt).toBeInstanceOf(Date);

    const deleted = await softDeleteComplaint(prisma, complaint.id);
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.version).toBe(3);

    const history = await prisma.complaintStatusHistory.findMany({ where: { complaintId: complaint.id } });
    expect(history.map(item => item.toStatus)).toContain(ComplaintStatus.CLOSED);
  });

  it("requires a documented reopen reason from CLOSED", async () => {
    const complaint = await createComplaint(prisma, {
      externalId: "EXT-UNIT-3",
      subject: "شكوى إعادة فتح",
      status: ComplaintStatus.CLOSED,
      closedAt: new Date("2026-07-02T00:00:00Z"),
    });

    await expect(updateComplaintStatus(prisma, complaint.id, ComplaintStatus.OPEN)).rejects.toThrow(/documented reason/);
    await expect(updateComplaintStatus(prisma, complaint.id, ComplaintStatus.OPEN, { reason: "إعادة فتح موثقة" })).resolves.toMatchObject({
      status: ComplaintStatus.OPEN,
      closedAt: null,
    });
  });
});

describe("Import batch domain model", () => {
  it("creates import batches and calculates row counters", async () => {
    const batch = await createImportBatch(prisma, {
      fileName: "imports/unit.csv",
      originalFileName: "unit.csv",
      fileHash: crypto.randomUUID(),
      fileSize: 200,
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2026-07-31T00:00:00Z"),
    });
    expect(batch.status).toBe(ImportBatchStatus.UPLOADED);

    expect(calculateRowCounters([
      { action: ImportRowAction.NEW, validationStatus: ImportRowValidationStatus.VALID },
      { action: ImportRowAction.UPDATE, validationStatus: ImportRowValidationStatus.WARNING },
      { action: ImportRowAction.DUPLICATE, validationStatus: ImportRowValidationStatus.VALID },
      { action: ImportRowAction.REJECT, validationStatus: ImportRowValidationStatus.INVALID },
    ])).toMatchObject({
      totalRows: 4,
      validRows: 3,
      invalidRows: 1,
      newRows: 1,
      updatedRows: 1,
      duplicateRows: 1,
      rejectedRows: 1,
    });
  });

  it("prevents invalid confirm and rollback transitions", async () => {
    const failed = await createReadyBatch(ImportBatchStatus.FAILED);
    await expect(confirmImportBatch(prisma, failed.id)).rejects.toThrow(/failed/);

    const ready = await createReadyBatch();
    await expect(confirmImportBatch(prisma, ready.id)).resolves.toMatchObject({ status: ImportBatchStatus.CONFIRMED });
    await expect(confirmImportBatch(prisma, ready.id)).rejects.toThrow(/more than once/);

    const uploaded = await createReadyBatch(ImportBatchStatus.UPLOADED);
    await expect(rollbackImportBatch(prisma, uploaded.id)).rejects.toThrow(/Only confirmed/);
    await expect(rollbackImportBatch(prisma, ready.id)).resolves.toMatchObject({ status: ImportBatchStatus.ROLLED_BACK });
  });
});

describe("Import batch rows", () => {
  it("keeps raw data, validation errors, actions, and unique row numbers per batch", async () => {
    const batch = await createReadyBatch();
    await prisma.importBatchRow.create({
      data: {
        importBatchId: batch.id,
        rowNumber: 1,
        rawData: { externalId: "ROW-1", phone: "not-logged" },
        normalizedData: { externalId: "ROW-1" },
        externalId: "ROW-1",
        action: ImportRowAction.REJECT,
        validationStatus: ImportRowValidationStatus.INVALID,
        validationErrors: [{ code: "INVALID_DATE" }],
      },
    });

    await expect(prisma.importBatchRow.create({
      data: {
        importBatchId: batch.id,
        rowNumber: 1,
        rawData: { externalId: "ROW-2" },
        action: ImportRowAction.NEW,
        validationStatus: ImportRowValidationStatus.VALID,
      },
    })).rejects.toThrow();

    const row = await prisma.importBatchRow.findFirstOrThrow({ where: { importBatchId: batch.id, rowNumber: 1 } });
    expect(row.rawData).toEqual({ externalId: "ROW-1", phone: "not-logged" });
    expect(row.validationErrors).toEqual([{ code: "INVALID_DATE" }]);
    expect(row.action).toBe(ImportRowAction.REJECT);
  });
});

describe("Complaint identity service", () => {
  it("matches same externalId and does not merge different externalIds", () => {
    expect(arePotentialDuplicateIdentities({ externalId: " A-1 " }, { externalId: "a-1" })).toBe(true);
    expect(arePotentialDuplicateIdentities({ externalId: "A-1" }, { externalId: "A-2" })).toBe(false);
  });

  it("falls back to sourceReference plus complaintDate", () => {
    const identity = resolveComplaintIdentity({
      sourceReference: " SRC-1 ",
      complaintDate: new Date("2026-07-01T21:00:00Z"),
    });
    expect(identity.strategy).toBe("sourceReferenceDate");
    expect(arePotentialDuplicateIdentities(
      { sourceReference: "SRC-1", complaintDate: "2026-07-01" },
      { sourceReference: " src-1 ", complaintDate: "2026-07-01" }
    )).toBe(true);
  });

  it("uses a stable composite fingerprint without text-only merging", () => {
    const left = {
      complaintDate: "2026-07-01",
      region: "الرياض",
      facility: "مستشفى  تجريبي",
      department: "الطوارئ",
      subject: "تأخر الخدمة",
    };
    const right = { ...left, facility: "مستشفى تجريبي" };
    expect(buildComplaintFingerprint(left)).toBe(buildComplaintFingerprint(right));
    expect(arePotentialDuplicateIdentities(
      { subject: "نفس النص فقط", region: "الرياض" },
      { subject: "نفس النص فقط", region: "مكة" }
    )).toBe(false);
  });
});
