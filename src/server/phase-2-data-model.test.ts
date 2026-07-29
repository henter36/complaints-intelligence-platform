import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, ComplaintPriority, ComplaintStatus, ImportBatchStatus, ImportRowAction, ImportRowValidationStatus, PeriodType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ComplaintConcurrencyError,
  ComplaintValidationError,
  createComplaint,
  getComplaintServiceErrorStatus,
  softDeleteComplaint,
  updateComplaintStatus,
} from "./complaints/complaint-service";
import {
  arePotentialDuplicateIdentities,
  buildComplaintFingerprint,
  ComplaintIdentityValidationError,
  resolveComplaintIdentity,
} from "./complaints/identity-service";
import {
  assertComplaintStatusTransition,
  isReopenTransition,
} from "./complaints/status";
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
      expectedVersion: complaint.version,
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

    await expect(updateComplaintStatus(prisma, complaint.id, ComplaintStatus.OPEN, {
      expectedVersion: complaint.version,
    })).rejects.toThrow(/documented reason/);
    await expect(updateComplaintStatus(prisma, complaint.id, ComplaintStatus.OPEN, {
      expectedVersion: complaint.version,
      reason: "إعادة فتح موثقة",
    })).resolves.toMatchObject({
      status: ComplaintStatus.OPEN,
      closedAt: null,
    });
  });

  it("normalizes closedAt from Date and ISO string and rejects invalid date strings", async () => {
    await expect(createComplaint(prisma, {
      externalId: "EXT-CLOSED-DATE",
      subject: "إغلاق بتاريخ Date",
      status: ComplaintStatus.CLOSED,
      closedAt: new Date("2026-07-03T08:00:00Z"),
    })).resolves.toMatchObject({
      status: ComplaintStatus.CLOSED,
      closedAt: new Date("2026-07-03T08:00:00Z"),
    });

    await expect(createComplaint(prisma, {
      externalId: "EXT-CLOSED-STRING",
      subject: "إغلاق بتاريخ نصي",
      status: ComplaintStatus.CLOSED,
      closedAt: "2026-07-04T08:00:00.000Z",
    })).resolves.toMatchObject({
      status: ComplaintStatus.CLOSED,
      closedAt: new Date("2026-07-04T08:00:00.000Z"),
    });

    await expect(createComplaint(prisma, {
      externalId: "EXT-CLOSED-INVALID",
      subject: "إغلاق بتاريخ غير صالح",
      status: ComplaintStatus.CLOSED,
      closedAt: "not-a-date",
    })).rejects.toBeInstanceOf(ComplaintValidationError);

    await expect(createComplaint(prisma, {
      externalId: "EXT-OPEN-CLOSED-AT",
      subject: "مفتوحة بتاريخ إغلاق",
      status: ComplaintStatus.OPEN,
      closedAt: "2026-07-04T08:00:00.000Z",
    })).rejects.toThrow(/closedAt cannot be set/);
  });

  it("enforces optimistic concurrency and skips history and audit on conflicts", async () => {
    const complaint = await createComplaint(prisma, {
      externalId: "EXT-CONCURRENCY-1",
      subject: "شكوى تزامن",
      status: ComplaintStatus.OPEN,
    });

    const updated = await updateComplaintStatus(prisma, complaint.id, ComplaintStatus.IN_PROGRESS, {
      expectedVersion: complaint.version,
      reason: "بدء المعالجة",
    });
    expect(updated.version).toBe(complaint.version + 1);

    const historyAfterSuccess = await prisma.complaintStatusHistory.count({ where: { complaintId: complaint.id } });
    const auditAfterSuccess = await prisma.auditLog.count({
      where: { entityId: complaint.id, action: "COMPLAINT_STATUS_CHANGED" },
    });
    expect(historyAfterSuccess).toBe(2);
    expect(auditAfterSuccess).toBe(1);

    await expect(updateComplaintStatus(prisma, complaint.id, ComplaintStatus.AWAITING_RESPONSE, {
      expectedVersion: complaint.version,
      reason: "نسخة قديمة",
    })).rejects.toBeInstanceOf(ComplaintConcurrencyError);
    expect(getComplaintServiceErrorStatus(new ComplaintConcurrencyError())).toBe(409);

    const unchanged = await prisma.complaint.findUniqueOrThrow({ where: { id: complaint.id } });
    expect(unchanged.status).toBe(ComplaintStatus.IN_PROGRESS);
    expect(unchanged.version).toBe(updated.version);
    await expect(prisma.complaintStatusHistory.count({ where: { complaintId: complaint.id } })).resolves.toBe(historyAfterSuccess);
    await expect(prisma.auditLog.count({
      where: { entityId: complaint.id, action: "COMPLAINT_STATUS_CHANGED" },
    })).resolves.toBe(auditAfterSuccess);
  });

  it("allows only one concurrent transition for the same expected version", async () => {
    const complaint = await createComplaint(prisma, {
      externalId: "EXT-CONCURRENCY-2",
      subject: "شكوى تزامن متزامن",
      status: ComplaintStatus.OPEN,
    });

    const results = await Promise.allSettled([
      updateComplaintStatus(prisma, complaint.id, ComplaintStatus.IN_PROGRESS, {
        expectedVersion: complaint.version,
        reason: "العملية الأولى",
      }),
      updateComplaintStatus(prisma, complaint.id, ComplaintStatus.AWAITING_RESPONSE, {
        expectedVersion: complaint.version,
        reason: "العملية الثانية",
      }),
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.complaintStatusHistory.count({ where: { complaintId: complaint.id } })).resolves.toBe(2);
    await expect(prisma.auditLog.count({
      where: { entityId: complaint.id, action: "COMPLAINT_STATUS_CHANGED" },
    })).resolves.toBe(1);
  });

  it("treats CANCELLED to an open status as a reopen transition", () => {
    expect(isReopenTransition(ComplaintStatus.CLOSED, ComplaintStatus.OPEN)).toBe(true);
    expect(isReopenTransition(ComplaintStatus.CANCELLED, ComplaintStatus.OPEN)).toBe(true);
    expect(isReopenTransition(ComplaintStatus.CLOSED, ComplaintStatus.CANCELLED)).toBe(false);
    expect(isReopenTransition(ComplaintStatus.CANCELLED, ComplaintStatus.CLOSED)).toBe(false);
    expect(isReopenTransition(ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS)).toBe(false);
    expect(() => assertComplaintStatusTransition(
      ComplaintStatus.CANCELLED,
      ComplaintStatus.OPEN
    )).toThrow(/documented reason/);
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
    expect(identity).toMatchObject({ complaintDate: "2026-07-01" });
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

  it("uses UTC calendar dates and rejects invalid identity dates", () => {
    const identity = resolveComplaintIdentity({
      sourceReference: "TZ-1",
      complaintDate: "2026-07-01T21:00:00Z",
    });

    expect(identity).toMatchObject({
      strategy: "sourceReferenceDate",
      value: "tz-1|2026-07-01",
      complaintDate: "2026-07-01",
    });
    expect(() => buildComplaintFingerprint({
      complaintDate: "not-a-date",
      subject: "شكوى غير صالحة",
    })).toThrow(ComplaintIdentityValidationError);
    expect(() => resolveComplaintIdentity({
      sourceReference: "TZ-2",
      complaintDate: "not-a-date",
    })).toThrow(ComplaintIdentityValidationError);
  });
});

describe("Seed data", () => {
  it("creates one deterministic synthetic report template when rerun", async () => {
    const { seed } = await import("../../prisma/seed");
    await seed(prisma);
    await seed(prisma);

    await expect(prisma.reportTemplate.count()).resolves.toBe(1);
    await expect(prisma.reportTemplate.findFirstOrThrow()).resolves.toMatchObject({
      name: "ملخص الشكاوى الشهري التجريبي",
      type: "monthly-summary",
      createdBy: "single-admin",
    });
  });
});
