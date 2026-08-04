import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComplaintPriority,
  ComplaintStatus,
  ImportBatchStatus,
  ImportChangeType,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  type Prisma,
  PrismaClient,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  confirmReadyImportBatch,
  IMPORT_EXTERNAL_ID_CONFLICT,
  IMPORT_EXTERNAL_ID_TOMBSTONE_CONFLICT,
  ImportConfirmationError,
  resolveImportedSubject,
  rollbackConfirmedImportBatch,
  toImportConfirmationErrorResponse,
} from "./import-confirmation-service";
import { deriveSubject } from "./subject-derive";

// Mock startTextRiskScan to keep integration tests isolated from the analysis service.
// The scan is fire-and-forget, so mocking it has no effect on confirmation assertions.
const startTextRiskScanMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ runId: "scan-mock", status: "COMPLETE", processed: 0, matched: 0 })
);
vi.mock("@/server/analytics/text-risk/text-risk-analysis-service", () => ({
  startTextRiskScan: startTextRiskScanMock,
}));

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
  it("deploys migrations with createdComplaintId column, index, and foreign key", async () => {
    const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>("PRAGMA table_info('ImportBatchRow')");
    const indexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>("PRAGMA index_list('ImportBatchRow')");
    const foreignKeys = await prisma.$queryRawUnsafe<Array<{ from: string; table: string; to: string; on_delete: string }>>(
      "PRAGMA foreign_key_list('ImportBatchRow')"
    );

    expect(columns.some((column) => column.name === "createdComplaintId")).toBe(true);
    expect(indexes.some((index) => index.name === "ImportBatchRow_createdComplaintId_idx")).toBe(true);
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({
        from: "createdComplaintId",
        table: "Complaint",
        to: "id",
        on_delete: "SET NULL",
      })
    );

    const complaint = await createComplaint(`EXT-FK-${crypto.randomUUID()}`);
    const batch = await createReadyBatch();
    await expect(
      addRow({
        batchId: batch.id,
        rowNumber: 99,
        action: ImportRowAction.NEW,
        normalizedData: { externalId: complaint.externalId, subject: complaint.subject },
      }).then((row) =>
        prisma.importBatchRow.update({
          where: { id: row.id },
          data: { createdComplaintId: complaint.id },
        })
      )
    ).resolves.toMatchObject({ createdComplaintId: complaint.id });
  });

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
    const rolledCreated = await prisma.complaint.findUniqueOrThrow({
      where: { id: createdRow.createdComplaintId! },
    });
    expect(rolledCreated).toMatchObject({
      isDeleted: true,
      externalId: null,
    });
    expect(rolledCreated.deletedAt).toBeInstanceOf(Date);
    expect(rolledCreated.version).toBeGreaterThan(1);

    const createSnapshot = await prisma.importChangeSnapshot.findFirstOrThrow({
      where: { complaintId: createdRow.createdComplaintId!, changeType: ImportChangeType.CREATE },
    });
    expect(createSnapshot.afterData).toMatchObject({
      externalId: createdRow.externalId,
    });
    expect(createdRow.normalizedData).toMatchObject({
      externalId: createdRow.externalId,
    });

    await expect(prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toMatchObject({
      subject: "قبل التراجع",
      status: ComplaintStatus.OPEN,
      externalId: existing.externalId,
      isDeleted: false,
    });
    await expect(prisma.auditLog.count({
      where: {
        entityId: createdRow.createdComplaintId!,
        action: "IMPORT_COMPLAINT_CREATION_REVERSED",
      },
    })).resolves.toBe(1);
    await expect(rollbackConfirmedImportBatch(batch.id, { reason: "مرة ثانية", client: prisma })).rejects.toMatchObject({
      code: "IMPORT_BATCH_STATE_CONFLICT",
    });
  });

  it.each([
    ["unknown status", { status: "UNKNOWN_STATUS" }],
    ["unknown priority", { priority: "UNKNOWN_PRIORITY" }],
    ["invalid date", { dueDate: "not-a-date" }],
    ["missing required subject", { subject: undefined }],
    ["non-object snapshot", "not-an-object"],
    ["array snapshot", []],
  ])("rejects rollback when snapshot contains %s", async (_label, patch) => {
    const existing = await createComplaint(`EXT-RB-SNAPSHOT-${crypto.randomUUID()}`);
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
    const snapshot = await prisma.importChangeSnapshot.findFirstOrThrow({ where: { importBatchId: batch.id } });
    const beforeData =
      patch && typeof patch === "object" && !Array.isArray(patch)
        ? { ...(snapshot.beforeData as Record<string, unknown>), ...patch }
        : patch;
    if (beforeData && typeof beforeData === "object" && !Array.isArray(beforeData) && "subject" in beforeData && beforeData.subject === undefined) {
      delete beforeData.subject;
    }

    await prisma.importChangeSnapshot.update({
      where: { id: snapshot.id },
      data: { beforeData: beforeData as Prisma.InputJsonValue },
    });

    await expect(rollbackConfirmedImportBatch(batch.id, {
      reason: "snapshot فاسدة",
      client: prisma,
    })).rejects.toMatchObject({ code: "ROLLBACK_SNAPSHOT_INVALID" });
    await expect(prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toMatchObject({
      subject: "بعد التأكيد",
    });
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.CONFIRMED,
      rolledBackAt: null,
    });
  });

  it("restores null optional dates from rollback snapshots", async () => {
    const existing = await createComplaint(`EXT-RB-NULL-DATE-${crypto.randomUUID()}`);
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
        subject: "مغلق مؤقتًا",
        status: ComplaintStatus.CLOSED,
        closedAt: "2026-07-04T00:00:00.000Z",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    await rollbackConfirmedImportBatch(batch.id, { reason: "استعادة", client: prisma });

    await expect(prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toMatchObject({
      status: ComplaintStatus.OPEN,
      closedAt: null,
    });
  });

  it("fails CREATE rollback when the created complaint no longer matches the import batch", async () => {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-CREATE-CONFLICT-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "تعارض دفعة",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    const row = await prisma.importBatchRow.findFirstOrThrow({ where: { importBatchId: batch.id } });
    await prisma.complaint.update({
      where: { id: row.createdComplaintId! },
      data: { importBatchId: null },
    });

    await expect(rollbackConfirmedImportBatch(batch.id, {
      reason: "تعارض",
      client: prisma,
    })).rejects.toMatchObject({ code: "ROLLBACK_CREATE_CONFLICT" });
    await expect(prisma.importBatchRow.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      rolledBackAt: null,
    });
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.CONFIRMED,
    });
    await expect(prisma.auditLog.count({
      where: { action: "IMPORT_COMPLAINT_CREATION_REVERSED", entityId: row.createdComplaintId },
    })).resolves.toBe(0);
  });

  it("fails CREATE rollback when the created complaint is already soft-deleted", async () => {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-CREATE-DELETED-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "محذوفة مسبقًا",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    const row = await prisma.importBatchRow.findFirstOrThrow({ where: { importBatchId: batch.id } });
    await prisma.complaint.update({
      where: { id: row.createdComplaintId! },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    await expect(rollbackConfirmedImportBatch(batch.id, {
      reason: "محذوفة",
      client: prisma,
    })).rejects.toMatchObject({ code: "ROLLBACK_CREATE_CONFLICT" });
    await expect(prisma.importBatchRow.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      rolledBackAt: null,
    });
  });

  it("keeps rollback atomic when one CREATE reversal fails", async () => {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-ATOMIC-RB-1-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "تراجع أول",
      },
    });
    await addRow({
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-ATOMIC-RB-2-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "تراجع ثاني",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    const rows = await prisma.importBatchRow.findMany({ where: { importBatchId: batch.id }, orderBy: { rowNumber: "asc" } });
    await prisma.complaint.update({
      where: { id: rows[1].createdComplaintId! },
      data: { importBatchId: null },
    });

    await expect(rollbackConfirmedImportBatch(batch.id, {
      reason: "تراجع ذري",
      client: prisma,
    })).rejects.toBeInstanceOf(ImportConfirmationError);
    await expect(prisma.importBatchRow.count({ where: { importBatchId: batch.id, rolledBackAt: { not: null } } })).resolves.toBe(0);
    await expect(prisma.complaint.count({
      where: { id: { in: rows.map((row) => row.createdComplaintId!) }, isDeleted: true },
    })).resolves.toBe(0);
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.CONFIRMED,
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

  it("persists complainantIdentifier and derives subject from description on confirm", async () => {
    const batch = await createReadyBatch();
    const externalId = `COMP/TEST-${crypto.randomUUID()}`;
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId,
        sourceReference: "TEST-REF-001",
        receivedAt: "2026-04-14T00:00:00.000Z",
        complaintDate: "2026-04-14T11:18:21.000Z",
        description: "وصف صناعي لا يحتوي بيانات تشغيلية",
        complainantIdentifier: "1000000000",
        channel: "مصدر تجريبي",
        facility: "منشأة تجريبية",
        region: "منطقة تجريبية",
        department: "إدارة تجريبية",
        resolution: "إجراء متخذ تجريبي",
        status: ComplaintStatus.NEW,
        priority: ComplaintPriority.MEDIUM,
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    const complaint = await prisma.complaint.findFirstOrThrow({ where: { externalId } });
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: complaint.id, action: "IMPORT_COMPLAINT_CREATED" },
    });

    expect(complaint).toMatchObject({
      externalId,
      sourceReference: "TEST-REF-001",
      complainantIdentifier: "1000000000",
      channel: "مصدر تجريبي",
      facility: "منشأة تجريبية",
      region: "منطقة تجريبية",
      department: "إدارة تجريبية",
      resolution: "إجراء متخذ تجريبي",
      description: "وصف صناعي لا يحتوي بيانات تشغيلية",
      subject: "وصف صناعي لا يحتوي بيانات تشغيلية",
    });
    expect(JSON.stringify(audit?.metadata ?? {})).not.toContain("1000000000");
  });
});

describe("isRepeated recalculation — scoped to touched identifiers", () => {
  it("sets isRepeated=true for both complaints when a second one with the same identifier is confirmed", async () => {
    const existing = await prisma.complaint.create({
      data: {
        externalId: `EXT-RPT-A-${crypto.randomUUID()}`,
        complaintDate: new Date("2026-07-01T00:00:00Z"),
        receivedAt: new Date("2026-07-01T00:00:00Z"),
        subject: "الأولى",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        complainantIdentifier: "1234567890",
        isRepeated: false,
      },
    });
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-RPT-B-${crypto.randomUUID()}`,
        receivedAt: "2026-07-02T00:00:00.000Z",
        subject: "الثانية",
        complainantIdentifier: "1234567890",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });

    const first = await prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } });
    expect(first.isRepeated).toBe(true);
    const second = await prisma.complaint.findFirst({
      where: { importBatchId: batch.id, isDeleted: false },
    });
    expect(second?.isRepeated).toBe(true);
  });

  it("reverts isRepeated to false when the second complaint is rolled back", async () => {
    const existing = await prisma.complaint.create({
      data: {
        externalId: `EXT-RPT-ROLLBACK-${crypto.randomUUID()}`,
        complaintDate: new Date("2026-07-01T00:00:00Z"),
        receivedAt: new Date("2026-07-01T00:00:00Z"),
        subject: "مراجعة",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        complainantIdentifier: "9876543210",
        isRepeated: false,
      },
    });
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-RPT-ROLLBACK-B-${crypto.randomUUID()}`,
        receivedAt: "2026-07-02T00:00:00.000Z",
        subject: "مكررة",
        complainantIdentifier: "9876543210",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    await rollbackConfirmedImportBatch(batch.id, { reason: "تراجع التكرار", client: prisma });

    const first = await prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } });
    expect(first.isRepeated).toBe(false);
  });

  it("preserves leading zeros in complainant identifier", async () => {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-LEADING-ZERO-${crypto.randomUUID()}`,
        receivedAt: "2026-07-01T00:00:00.000Z",
        subject: "أصفار بادئة",
        complainantIdentifier: "0012345678",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });

    const complaint = await prisma.complaint.findFirst({
      where: { importBatchId: batch.id, isDeleted: false },
    });
    expect(complaint?.complainantIdentifier).toBe("0012345678");
  });

  it("normalizes Arabic-Indic digits in complainant identifier on save", async () => {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-ARABIC-DIGITS-${crypto.randomUUID()}`,
        receivedAt: "2026-07-01T00:00:00.000Z",
        subject: "أرقام عربية",
        complainantIdentifier: "١٢٣٤٥٦٧٨٩٠",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });

    const complaint = await prisma.complaint.findFirst({
      where: { importBatchId: batch.id, isDeleted: false },
    });
    expect(complaint?.complainantIdentifier).toBe("1234567890");
  });

  it("empty complainant identifier does not affect isRepeated calculation", async () => {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-NO-ID-${crypto.randomUUID()}`,
        receivedAt: "2026-07-01T00:00:00.000Z",
        subject: "بلا هوية",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });

    const complaint = await prisma.complaint.findFirst({
      where: { importBatchId: batch.id, isDeleted: false },
    });
    expect(complaint?.isRepeated).toBe(false);
  });
});

describe("scan trigger on import confirmation", () => {
  it("confirmation resolves correctly even when startTextRiskScan rejects", async () => {
    // The scan is fire-and-forget: its rejection must not propagate to the caller.
    startTextRiskScanMock.mockRejectedValueOnce(new Error("scan unavailable"));

    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-SCAN-FAIL-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "شكوى اختبار الفحص",
      },
    });
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { totalRows: 1, newRows: 1 },
    });

    const result = await confirmReadyImportBatch(batch.id, { client: prisma });
    expect(result).toMatchObject({ status: "CONFIRMED", created: 1 });

    // Flush the micro-task queue so the .catch chain runs; any unhandled rejection
    // would be caught by Vitest and fail this test.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("startTextRiskScan is called with the confirmed batch id", async () => {
    startTextRiskScanMock.mockClear();

    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: `EXT-SCAN-ID-${crypto.randomUUID()}`,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "شكوى اختبار معرّف الدفعة",
      },
    });
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { totalRows: 1, newRows: 1 },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    await Promise.resolve();

    expect(startTextRiskScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ importBatchId: batch.id })
    );
  });
});

describe("reimport after rollback and externalId conflicts (Issue #42)", () => {
  async function confirmNewWithExternalId(externalId: string, subject = "شكوى") {
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId,
        complaintDate: "2026-07-02T00:00:00.000Z",
        receivedAt: "2026-07-02T00:00:00.000Z",
        subject,
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
      },
    });
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { totalRows: 1, validRows: 1, newRows: 1 },
    });
    await confirmReadyImportBatch(batch.id, { client: prisma, actor: "single-admin" });
    return batch;
  }

  it("releases externalId on CREATE rollback and allows confirm→rollback→reimport→confirm twice", async () => {
    const externalId = `EXT-REIMPORT-${crypto.randomUUID()}`;

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const batch = await confirmNewWithExternalId(externalId, `دورة ${cycle + 1}`);
      const created = await prisma.complaint.findFirstOrThrow({
        where: { externalId, isDeleted: false },
      });

      await rollbackConfirmedImportBatch(batch.id, {
        reason: `تراجع دورة ${cycle + 1}`,
        client: prisma,
      });

      const tombstone = await prisma.complaint.findUniqueOrThrow({ where: { id: created.id } });
      expect(tombstone).toMatchObject({
        isDeleted: true,
        externalId: null,
      });
      expect(tombstone.deletedAt).toBeInstanceOf(Date);

      const snapshot = await prisma.importChangeSnapshot.findFirstOrThrow({
        where: { complaintId: created.id, changeType: ImportChangeType.CREATE },
      });
      expect(snapshot.afterData).toMatchObject({ externalId });

      const reimportBatch = await confirmNewWithExternalId(externalId, `إعادة ${cycle + 1}`);
      const active = await prisma.complaint.findMany({
        where: { externalId, isDeleted: false },
      });
      expect(active).toHaveLength(1);
      expect(active[0]!.id).not.toBe(created.id);

      await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: reimportBatch.id } })).resolves.toMatchObject({
        status: ImportBatchStatus.CONFIRMED,
        appliedCreatedRows: 1,
      });

      await rollbackConfirmedImportBatch(reimportBatch.id, {
        reason: `تنظيف دورة ${cycle + 1}`,
        client: prisma,
      });
    }
  });

  it("preserves externalId when rolling back an UPDATE", async () => {
    const externalId = `EXT-UPD-RB-${crypto.randomUUID()}`;
    const existing = await createComplaint(externalId, "قبل التحديث");
    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.UPDATE,
      matchedComplaintId: existing.id,
      matchedComplaintVersion: existing.version,
      normalizedData: {
        externalId,
        complaintDate: existing.complaintDate?.toISOString(),
        receivedAt: existing.receivedAt.toISOString(),
        subject: "بعد التحديث",
        status: ComplaintStatus.IN_PROGRESS,
        priority: ComplaintPriority.HIGH,
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma });
    await rollbackConfirmedImportBatch(batch.id, { reason: "استعادة تحديث", client: prisma });

    await expect(prisma.complaint.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toMatchObject({
      externalId,
      subject: "قبل التحديث",
      isDeleted: false,
      status: ComplaintStatus.OPEN,
    });
  });

  it("releases eligible legacy tombstones inside confirmation and creates the new complaint", async () => {
    const externalId = `EXT-LEGACY-${crypto.randomUUID()}`;
    const originBatch = await createReadyBatch();
    await prisma.importBatch.update({
      where: { id: originBatch.id },
      data: { status: ImportBatchStatus.ROLLED_BACK, rolledBackAt: new Date() },
    });

    const tombstone = await prisma.complaint.create({
      data: {
        externalId,
        complaintDate: new Date("2026-06-01T00:00:00Z"),
        receivedAt: new Date("2026-06-01T00:00:00Z"),
        subject: "tombstone legacy",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        isDeleted: true,
        deletedAt: new Date("2026-06-02T00:00:00Z"),
        importBatchId: originBatch.id,
        version: 2,
      },
    });
    const originRow = await addRow({
      batchId: originBatch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: { externalId, subject: "tombstone legacy" },
    });
    await prisma.importChangeSnapshot.create({
      data: {
        importBatchId: originBatch.id,
        importBatchRowId: originRow.id,
        complaintId: tombstone.id,
        changeType: ImportChangeType.CREATE,
        afterData: {
          externalId,
          subject: "tombstone legacy",
          status: ComplaintStatus.OPEN,
          priority: ComplaintPriority.MEDIUM,
          severity: ComplaintPriority.MEDIUM,
          receivedAt: "2026-06-01T00:00:00.000Z",
        },
        versionAfter: 1,
      },
    });

    await confirmNewWithExternalId(externalId, "جديد بعد legacy");

    await expect(prisma.complaint.findUniqueOrThrow({ where: { id: tombstone.id } })).resolves.toMatchObject({
      isDeleted: true,
      externalId: null,
    });
    await expect(prisma.complaint.findFirstOrThrow({
      where: { externalId, isDeleted: false },
    })).resolves.toMatchObject({
      subject: "جديد بعد legacy",
    });
  });

  it("rejects confirmation when an active complaint already owns the externalId", async () => {
    const externalId = `EXT-ACTIVE-${crypto.randomUUID()}`;
    await createComplaint(externalId, "قائمة");

    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "محاولة تكرار نشط",
      },
    });

    const error = await confirmReadyImportBatch(batch.id, { client: prisma }).catch((err) => err);
    expect(error).toBeInstanceOf(ImportConfirmationError);
    expect(error).toMatchObject({
      code: IMPORT_EXTERNAL_ID_CONFLICT,
      status: 409,
    });
    const response = toImportConfirmationErrorResponse(error);
    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: IMPORT_EXTERNAL_ID_CONFLICT } },
    });

    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      appliedCreatedRows: 0,
    });
    await expect(prisma.complaint.count({ where: { externalId, isDeleted: false } })).resolves.toBe(1);
  });

  it("rejects ineligible deleted tombstones without a CREATE snapshot", async () => {
    const externalId = `EXT-INELIGIBLE-${crypto.randomUUID()}`;
    await prisma.complaint.create({
      data: {
        externalId,
        complaintDate: new Date("2026-06-01T00:00:00Z"),
        receivedAt: new Date("2026-06-01T00:00:00Z"),
        subject: "حذف يدوي",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        isDeleted: true,
        deletedAt: new Date(),
      },
    });

    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "محاولة",
      },
    });

    await expect(confirmReadyImportBatch(batch.id, { client: prisma })).rejects.toMatchObject({
      code: IMPORT_EXTERNAL_ID_TOMBSTONE_CONFLICT,
      status: 409,
    });
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      appliedCreatedRows: 0,
    });
    await expect(prisma.complaint.findFirst({ where: { externalId } })).resolves.toMatchObject({
      externalId,
      isDeleted: true,
    });
  });

  it("keeps confirmation atomic when a later NEW row conflicts with an active externalId", async () => {
    const okId = `EXT-ATOMIC-OK-${crypto.randomUUID()}`;
    const conflictId = `EXT-ATOMIC-BAD-${crypto.randomUUID()}`;
    await createComplaint(conflictId, "نشطة");

    const batch = await createReadyBatch();
    await addRow({
      batchId: batch.id,
      rowNumber: 1,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: okId,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "صالح",
      },
    });
    await addRow({
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.NEW,
      normalizedData: {
        externalId: conflictId,
        complaintDate: "2026-07-02T00:00:00.000Z",
        subject: "متعارض",
      },
    });

    await expect(confirmReadyImportBatch(batch.id, { client: prisma })).rejects.toMatchObject({
      code: IMPORT_EXTERNAL_ID_CONFLICT,
    });

    await expect(prisma.complaint.count({ where: { externalId: okId } })).resolves.toBe(0);
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      appliedCreatedRows: 0,
    });
  });
});

describe("resolveImportedSubject", () => {
  it("trims and prefers an explicit subject", () => {
    expect(
      resolveImportedSubject({
        subject: "  موضوع صريح  ",
        sourceDetail: "تفصيل",
        description: "وصف",
      })
    ).toBe("موضوع صريح");
  });

  it("uses sourceDetail when subject is blank whitespace", () => {
    expect(
      resolveImportedSubject({
        subject: "   ",
        sourceDetail: "  تفصيل مصدري  ",
        description: "وصف",
      })
    ).toBe("تفصيل مصدري");
  });

  it("derives from description when subject and sourceDetail are absent", () => {
    expect(
      resolveImportedSubject({
        subject: undefined,
        sourceDetail: undefined,
        description: "وصف الشكوى",
      })
    ).toBe(deriveSubject("وصف الشكوى"));
  });

  it("falls back to the default label when no subject sources exist", () => {
    expect(
      resolveImportedSubject({
        subject: undefined,
        sourceDetail: undefined,
        description: undefined,
      })
    ).toBe("بدون موضوع");
  });

  it("does not use sourceDetail or description when an explicit subject is present", () => {
    expect(
      resolveImportedSubject({
        subject: "الأولوية للموضوع",
        sourceDetail: "لا يجب استخدامه",
        description: "ولا هذا",
      })
    ).toBe("الأولوية للموضوع");
  });
});
