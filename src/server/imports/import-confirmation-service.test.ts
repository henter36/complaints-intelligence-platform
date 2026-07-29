import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComplaintPriority,
  ComplaintStatus,
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  type Prisma,
  PrismaClient,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  confirmReadyImportBatch,
  ImportConfirmationError,
  rollbackConfirmedImportBatch,
} from "./import-confirmation-service";

let prisma: PrismaClient;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-phase-5-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function createReadyBatch() {
  return prisma.importBatch.create({
    data: {
      fileName: `imports/${crypto.randomUUID()}.xlsx`,
      originalFileName: "phase5.xlsx",
      fileHash: crypto.randomUUID(),
      fileSize: 2048,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2026-07-31T00:00:00Z"),
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      totalRows: 0,
      createdBy: "single-admin",
    },
  });
}

async function addRow(input: {
  batchId: string;
  rowNumber: number;
  action: ImportRowAction;
  normalizedData?: Record<string, unknown> | null;
  matchedComplaintId?: string | null;
  matchedComplaintVersion?: number | null;
  validationStatus?: ImportRowValidationStatus;
}) {
  return prisma.importBatchRow.create({
    data: {
      importBatchId: input.batchId,
      rowNumber: input.rowNumber,
      rawData: { rowNumber: input.rowNumber },
      normalizedData: input.normalizedData as Prisma.InputJsonValue | undefined,
      externalId: typeof input.normalizedData?.externalId === "string" ? input.normalizedData.externalId : null,
      action: input.action,
      validationStatus: input.validationStatus ?? ImportRowValidationStatus.VALID,
      matchedComplaintId: input.matchedComplaintId ?? null,
      matchedComplaintVersion: input.matchedComplaintVersion ?? null,
    },
  });
}

async function createComplaint(externalId: string, subject = "قديم") {
  return prisma.complaint.create({
    data: {
      externalId,
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      receivedAt: new Date("2026-07-01T00:00:00Z"),
      subject,
      status: ComplaintStatus.OPEN,
      priority: ComplaintPriority.MEDIUM,
    },
  });
}

describe("transactional import confirmation", () => {
  it("confirms NEW, UPDATE, NO_CHANGE, and DUPLICATE rows atomically", async () => {
    const existing = await createComplaint(`EXT-UPD-${crypto.randomUUID()}`);
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-NEW-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        receivedAt: "2026-07-02T00:00:00.000Z",
        subject: "شكوى جديدة",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.HIGH,
      },
    });
    await addRow({
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.UPDATE,
      matchedComplaintId: existing.id,
      matchedComplaintVersion: existing.version,
      normalizedData: {
        externalId: existing.externalId,
        complaintDate: existing.complaintDate?.toISOString(),
        receivedAt: existing.receivedAt.toISOString(),
        subject: "بعد التحديث",
        status: ComplaintStatus.IN_PROGRESS,
        priority: ComplaintPriority.CRITICAL,
      },
    });
    await addRow({
      batchId: batch.id,
      rowNumber: 3,
      action: ImportRowAction.NO_CHANGE,
      matchedComplaintId: existing.id,
      matchedComplaintVersion: existing.version,
      normalizedData: {
        externalId: existing.externalId,
        complaintDate: existing.complaintDate?.toISOString(),
        subject: existing.subject,
      },
    });
    await addRow({
      batchId: batch.id,
      rowNumber: 4,
      action: ImportRowAction.DUPLICATE,
      validationStatus: ImportRowValidationStatus.INVALID,
    });

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { totalRows: 4, validRows: 3, invalidRows: 1, duplicateRows: 1, newRows: 1, updatedRows: 1, noChangeRows: 1 },
    });

    await expect(confirmReadyImportBatch(batch.id, { client: prisma })).rejects.toMatchObject({
      code: "IMPORT_BATCH_HAS_REJECTED_ROWS",
    });

    await prisma.importBatchRow.updateMany({
      where: { importBatchId: batch.id, action: ImportRowAction.DUPLICATE },
      data: { validationStatus: ImportRowValidationStatus.VALID },
    });
    const result = await confirmReadyImportBatch(batch.id, { client: prisma, actor: "single-admin" });

    expect(result).toMatchObject({ status: "CONFIRMED", created: 1, updated: 1, unchanged: 1, duplicates: 1 });
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.CONFIRMED,
      appliedCreatedRows: 1,
      appliedUpdatedRows: 1,
    });

    const updated = await prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.subject).toBe("بعد التحديث");
    expect(updated.status).toBe(ComplaintStatus.IN_PROGRESS);
    expect(updated.version).toBe(existing.version + 1);

    await expect(prisma.importChangeSnapshot.count({ where: { importBatchId: batch.id } })).resolves.toBe(2);
    await expect(prisma.complaintStatusHistory.count({ where: { importBatchId: batch.id } })).resolves.toBe(2);
    await expect(prisma.auditLog.count({ where: { entityId: batch.id, action: "IMPORT_CONFIRMATION_COMPLETED" } })).resolves.toBe(1);
  });

  it("rolls back created and updated complaints and prevents a second rollback", async () => {
    const existing = await createComplaint(`EXT-RB-${crypto.randomUUID()}`, "قبل التراجع");
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-RB-NEW-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "منشأة ثم متراجعة",
      },
    });
    await addRow({
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.UPDATE,
      matchedComplaintId: existing.id,
      matchedComplaintVersion: existing.version,
      normalizedData: {
        externalId: existing.externalId,
        complaintDate: existing.complaintDate?.toISOString(),
        subject: "تحديث قبل التراجع",
        status: ComplaintStatus.CLOSED,
        closedAt: "2026-07-03T00:00:00.000Z",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    const createdRow = await prisma.importBatchRow.findFirstOrThrow({
      where: { importBatchId: batch.id, action: ImportRowAction.NEW },
    });
    expect(createdRow.createdComplaintId).not.toBeNull();

    const rollback = await rollbackConfirmedImportBatch(batch.id, {
      reason: "اختبار التراجع",
      client: prisma,
    });

    expect(rollback).toMatchObject({ status: "ROLLED_BACK", revertedCreates: 1, revertedUpdates: 1 });
    await expect(prisma.complaint.findUniqueOrThrow({ where: { id: createdRow.createdComplaintId! } })).resolves.toMatchObject({
      isDeleted: true,
    });
    await expect(prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toMatchObject({
      subject: "قبل التراجع",
      status: ComplaintStatus.OPEN,
    });
    await expect(rollbackConfirmedImportBatch(batch.id, { reason: "مرة ثانية", client: prisma })).rejects.toMatchObject({
      code: "IMPORT_BATCH_STATE_CONFLICT",
    });
  });

  it("keeps confirmation atomic when an update preview is stale", async () => {
    const existing = await createComplaint(`EXT-STALE-${crypto.randomUUID()}`);
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-ATOMIC-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "يجب ألا تنشأ",
      },
    });
    await addRow({
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.UPDATE,
      matchedComplaintId: existing.id,
      matchedComplaintVersion: existing.version,
      normalizedData: {
        externalId: existing.externalId,
        complaintDate: existing.complaintDate?.toISOString(),
        subject: "تحديث قديم",
      },
    });
    await prisma.complaint.update({ where: { id: existing.id }, data: { version: { increment: 1 } } });

    await expect(confirmReadyImportBatch(batch.id, { client: prisma })).rejects.toBeInstanceOf(ImportConfirmationError);

    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
    });
    await expect(prisma.complaint.count({ where: { importBatchId: batch.id } })).resolves.toBe(0);
    await expect(prisma.importChangeSnapshot.count({ where: { importBatchId: batch.id } })).resolves.toBe(0);
  });

  it("allows only one concurrent confirmation request to succeed", async () => {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-CONCURRENT-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "تزامن",
      },
    });

    const results = await Promise.allSettled([
      confirmReadyImportBatch(batch.id, { client: prisma }),
      confirmReadyImportBatch(batch.id, { client: prisma }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.complaint.count({ where: { importBatchId: batch.id } })).resolves.toBe(1);
  });

  it("blocks rollback when a complaint changed after confirmation", async () => {
    const existing = await createComplaint(`EXT-RB-CONFLICT-${crypto.randomUUID()}`);
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.UPDATE,
      matchedComplaintId: existing.id,
      matchedComplaintVersion: existing.version,
      normalizedData: {
        externalId: existing.externalId,
        complaintDate: existing.complaintDate?.toISOString(),
        subject: "بعد التأكيد",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    await prisma.complaint.update({ where: { id: existing.id }, data: { subject: "تعديل لاحق", version: { increment: 1 } } });

    await expect(rollbackConfirmedImportBatch(batch.id, {
      reason: "سيتعارض",
      client: prisma,
    })).rejects.toMatchObject({ code: "ROLLBACK_CONFLICT" });
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.CONFIRMED,
    });
  });
});
