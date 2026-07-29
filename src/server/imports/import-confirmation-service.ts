import {
  ComplaintPriority,
  ComplaintStatus,
  ImportBatchStatus,
  ImportChangeType,
  ImportRowAction,
  ImportRowValidationStatus,
  type Complaint,
  type ImportBatchRow,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { assertClosedAtMatchesStatus } from "@/server/complaints/status";
import { calculateRowCounters } from "./import-batch-service";

const CONFIRMABLE_ACTIONS = new Set<ImportRowAction>([
  ImportRowAction.NEW,
  ImportRowAction.UPDATE,
  ImportRowAction.NO_CHANGE,
  ImportRowAction.DUPLICATE,
]);

const SNAPSHOT_FIELDS = [
  "externalId",
  "sourceReference",
  "complaintDate",
  "receivedAt",
  "dueDate",
  "closedAt",
  "status",
  "subject",
  "description",
  "region",
  "facility",
  "department",
  "categoryId",
  "classificationId",
  "priority",
  "severity",
  "channel",
  "resolution",
] as const;

type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

type ConfirmationRow = ImportBatchRow & {
  importBatch: never;
};

type NormalizedConfirmationRow = {
  externalId?: string | null;
  sourceReference?: string | null;
  complaintDate?: Date | null;
  receivedAt?: Date | null;
  dueDate?: Date | null;
  closedAt?: Date | null;
  status?: ComplaintStatus | null;
  subject?: string | null;
  description?: string | null;
  region?: string | null;
  facility?: string | null;
  department?: string | null;
  category?: string | null;
  classification?: string | null;
  priority?: ComplaintPriority | null;
  channel?: string | null;
  resolution?: string | null;
};

export type ImportConfirmationResult = {
  batchId: string;
  status: "CONFIRMED";
  confirmedAt: string;
  created: number;
  updated: number;
  unchanged: number;
  duplicates: number;
};

export type ImportRollbackResult = {
  batchId: string;
  status: "ROLLED_BACK";
  rolledBackAt: string;
  revertedCreates: number;
  revertedUpdates: number;
};

type ImportConfirmationClient = Pick<typeof db, "$transaction">;

export class ImportConfirmationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Prisma.InputJsonValue
  ) {
    super(message);
    this.name = "ImportConfirmationError";
  }
}

export function toImportConfirmationErrorResponse(error: unknown):
  | { status: number; body: { error: { code: string; message: string; details?: Prisma.InputJsonValue } } }
  | null {
  if (!(error instanceof ImportConfirmationError)) {
    return null;
  }

  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
  };
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item instanceof Date) return item.toISOString();
    return item;
  })) as Prisma.InputJsonValue;
}

function parseDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== "string") return undefined;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseStatus(value: unknown): ComplaintStatus | undefined {
  return typeof value === "string" && Object.hasOwn(ComplaintStatus, value)
    ? ComplaintStatus[value as keyof typeof ComplaintStatus]
    : undefined;
}

function parsePriority(value: unknown): ComplaintPriority | undefined {
  return typeof value === "string" && Object.hasOwn(ComplaintPriority, value)
    ? ComplaintPriority[value as keyof typeof ComplaintPriority]
    : undefined;
}

function parseText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseNormalizedRow(row: ConfirmationRow): NormalizedConfirmationRow {
  if (!row.normalizedData || typeof row.normalizedData !== "object" || Array.isArray(row.normalizedData)) {
    throw new ImportConfirmationError(
      "IMPORT_ROW_NORMALIZED_DATA_MISSING",
      `الصف ${row.rowNumber} لا يحتوي بيانات منظفة قابلة للتطبيق`,
      422,
      { rowNumber: row.rowNumber }
    );
  }

  const data = row.normalizedData as Record<string, unknown>;

  return {
    externalId: parseText(data.externalId),
    sourceReference: parseText(data.sourceReference),
    complaintDate: parseDate(data.complaintDate),
    receivedAt: parseDate(data.receivedAt),
    dueDate: parseDate(data.dueDate),
    closedAt: parseDate(data.closedAt),
    status: parseStatus(data.status),
    subject: parseText(data.subject),
    description: parseText(data.description),
    region: parseText(data.region),
    facility: parseText(data.facility),
    department: parseText(data.department),
    category: parseText(data.category),
    classification: parseText(data.classification),
    priority: parsePriority(data.priority),
    channel: parseText(data.channel),
    resolution: parseText(data.resolution),
  };
}

function snapshotComplaint(complaint: Complaint): Record<SnapshotField, unknown> {
  return Object.fromEntries(
    SNAPSHOT_FIELDS.map((field) => [field, complaint[field]])
  ) as Record<SnapshotField, unknown>;
}

function assertBatchRowsAreConfirmable(rows: ConfirmationRow[]): void {
  const counters = calculateRowCounters(rows);

  if (counters.invalidRows > 0 || counters.rejectedRows > 0) {
    throw new ImportConfirmationError(
      "IMPORT_BATCH_HAS_REJECTED_ROWS",
      "لا يمكن تأكيد دفعة تحتوي صفوفًا مرفوضة أو غير صالحة",
      422,
      { invalidRows: counters.invalidRows, rejectedRows: counters.rejectedRows }
    );
  }

  const unsupportedRow = rows.find((row) => !CONFIRMABLE_ACTIONS.has(row.action));
  if (unsupportedRow) {
    throw new ImportConfirmationError(
      "IMPORT_ROW_ACTION_NOT_CONFIRMABLE",
      "تحتوي الدفعة على إجراء صف غير قابل للتأكيد",
      422,
      { rowNumber: unsupportedRow.rowNumber, action: unsupportedRow.action }
    );
  }

  const updateTargets = new Set<string>();
  for (const row of rows) {
    if (row.action !== ImportRowAction.UPDATE) continue;
    if (!row.matchedComplaintId || row.matchedComplaintVersion == null) {
      throw new ImportConfirmationError(
        "IMPORT_PREVIEW_STALE",
        "معاينة الدفعة قديمة ويجب إعادة المعالجة قبل التأكيد",
        409,
        { rowNumber: row.rowNumber }
      );
    }

    if (updateTargets.has(row.matchedComplaintId)) {
      throw new ImportConfirmationError(
        "IMPORT_UPDATE_TARGET_CONFLICT",
        "يوجد أكثر من صف يحاول تحديث الشكوى نفسها",
        422,
        { complaintId: row.matchedComplaintId }
      );
    }

    updateTargets.add(row.matchedComplaintId);
  }
}

async function resolveTaxonomy(
  tx: Prisma.TransactionClient,
  row: NormalizedConfirmationRow
): Promise<{ categoryId?: string | null; classificationId?: string | null }> {
  const category = row.category
    ? await tx.category.findFirst({ where: { nameAr: row.category, isActive: true, isDeleted: false } })
    : null;
  if (row.category && !category) {
    throw new ImportConfirmationError("IMPORT_TAXONOMY_STALE", "الفئة في المعاينة لم تعد متاحة", 409);
  }

  const classification = row.classification
    ? await tx.classification.findFirst({
        where: {
          nameAr: row.classification,
          isActive: true,
          isDeleted: false,
          category: { isActive: true, isDeleted: false },
        },
        include: { category: true },
      })
    : null;
  if (row.classification && !classification) {
    throw new ImportConfirmationError("IMPORT_TAXONOMY_STALE", "التصنيف في المعاينة لم يعد متاحًا", 409);
  }
  if (category && classification && classification.categoryId !== category.id) {
    throw new ImportConfirmationError("IMPORT_TAXONOMY_STALE", "التصنيف لم يعد يتبع الفئة المحددة", 409);
  }

  return {
    categoryId: category?.id,
    classificationId: classification?.id,
  };
}

async function applyNewRow(
  tx: Prisma.TransactionClient,
  batchId: string,
  row: ConfirmationRow,
  actor: string,
  appliedAt: Date
): Promise<void> {
  const normalized = parseNormalizedRow(row);
  const taxonomy = await resolveTaxonomy(tx, normalized);
  const status = normalized.status ?? ComplaintStatus.NEW;
  const closedAt = normalized.closedAt ?? null;
  assertClosedAtMatchesStatus(status, closedAt);

  const complaint = await tx.complaint.create({
    data: {
      externalId: normalized.externalId ?? null,
      sourceReference: normalized.sourceReference ?? null,
      complaintDate: normalized.complaintDate ?? normalized.receivedAt ?? null,
      receivedAt: normalized.receivedAt ?? normalized.complaintDate ?? appliedAt,
      dueDate: normalized.dueDate ?? null,
      closedAt,
      status,
      subject: normalized.subject ?? normalized.description ?? "بدون موضوع",
      description: normalized.description ?? null,
      region: normalized.region ?? null,
      facility: normalized.facility ?? null,
      department: normalized.department ?? null,
      categoryId: taxonomy.categoryId ?? null,
      classificationId: taxonomy.classificationId ?? null,
      priority: normalized.priority ?? ComplaintPriority.MEDIUM,
      severity: normalized.priority ?? ComplaintPriority.MEDIUM,
      channel: normalized.channel ?? null,
      resolution: normalized.resolution ?? null,
      importBatchId: batchId,
    },
  });

  await tx.complaintStatusHistory.create({
    data: {
      complaintId: complaint.id,
      fromStatus: null,
      toStatus: complaint.status,
      changedAt: appliedAt,
      changedBy: actor,
      reason: "Created from confirmed import",
      importBatchId: batchId,
    },
  });
  await tx.importBatchRow.update({
    where: { id: row.id },
    data: { createdComplaintId: complaint.id, appliedAt },
  });
  await tx.importChangeSnapshot.create({
    data: {
      importBatchId: batchId,
      importBatchRowId: row.id,
      complaintId: complaint.id,
      changeType: ImportChangeType.CREATE,
      beforeData: undefined,
      afterData: toJsonValue(snapshotComplaint(complaint)),
      versionBefore: null,
      versionAfter: complaint.version,
    },
  });
  await writeAuditLog(tx, {
    action: "IMPORT_COMPLAINT_CREATED",
    entityType: "Complaint",
    entityId: complaint.id,
    actor,
    metadata: { batchId, rowId: row.id, action: row.action },
  });
}

function buildUpdateData(
  current: Complaint,
  normalized: NormalizedConfirmationRow,
  taxonomy: { categoryId?: string | null; classificationId?: string | null }
): Prisma.ComplaintUncheckedUpdateManyInput {
  const data: Prisma.ComplaintUncheckedUpdateManyInput = {
    version: { increment: 1 },
  };

  if (normalized.sourceReference !== undefined) data.sourceReference = normalized.sourceReference;
  if (normalized.complaintDate !== undefined) data.complaintDate = normalized.complaintDate;
  if (normalized.receivedAt !== undefined) data.receivedAt = normalized.receivedAt ?? current.receivedAt;
  if (normalized.dueDate !== undefined) data.dueDate = normalized.dueDate;
  if (normalized.closedAt !== undefined) data.closedAt = normalized.closedAt;
  if (normalized.status !== undefined) data.status = normalized.status ?? current.status;
  if (normalized.subject !== undefined && normalized.subject) data.subject = normalized.subject;
  if (normalized.description !== undefined) data.description = normalized.description;
  if (normalized.region !== undefined) data.region = normalized.region;
  if (normalized.facility !== undefined) data.facility = normalized.facility;
  if (normalized.department !== undefined) data.department = normalized.department;
  if (taxonomy.categoryId !== undefined) data.categoryId = taxonomy.categoryId;
  if (taxonomy.classificationId !== undefined) data.classificationId = taxonomy.classificationId;
  if (normalized.priority !== undefined) {
    data.priority = normalized.priority ?? current.priority;
    data.severity = normalized.priority ?? current.severity;
  }
  if (normalized.channel !== undefined) data.channel = normalized.channel;
  if (normalized.resolution !== undefined) data.resolution = normalized.resolution;

  assertClosedAtMatchesStatus((data.status as ComplaintStatus | undefined) ?? current.status, (data.closedAt as Date | null | undefined) ?? current.closedAt);
  return data;
}

async function applyUpdateRow(
  tx: Prisma.TransactionClient,
  batchId: string,
  row: ConfirmationRow,
  actor: string,
  appliedAt: Date
): Promise<void> {
  if (!row.matchedComplaintId || row.matchedComplaintVersion == null) {
    throw new ImportConfirmationError("IMPORT_PREVIEW_STALE", "معاينة الدفعة قديمة ويجب إعادة المعالجة قبل التأكيد", 409);
  }

  const current = await tx.complaint.findUnique({ where: { id: row.matchedComplaintId } });
  if (!current || current.isDeleted || current.version !== row.matchedComplaintVersion) {
    throw new ImportConfirmationError("IMPORT_PREVIEW_STALE", "تغيرت الشكاوى بعد المعاينة ويجب إعادة معالجة الدفعة", 409);
  }

  const normalized = parseNormalizedRow(row);
  const taxonomy = await resolveTaxonomy(tx, normalized);
  const beforeData = snapshotComplaint(current);
  const updateData = buildUpdateData(current, normalized, taxonomy);
  const result = await tx.complaint.updateMany({
    where: { id: current.id, version: row.matchedComplaintVersion, isDeleted: false },
    data: updateData,
  });
  if (result.count !== 1) {
    throw new ImportConfirmationError("IMPORT_PREVIEW_STALE", "تغيرت الشكاوى بعد المعاينة ويجب إعادة معالجة الدفعة", 409);
  }

  const updated = await tx.complaint.findUniqueOrThrow({ where: { id: current.id } });
  if (current.status !== updated.status) {
    await tx.complaintStatusHistory.create({
      data: {
        complaintId: current.id,
        fromStatus: current.status,
        toStatus: updated.status,
        changedAt: appliedAt,
        changedBy: actor,
        reason: "Updated from confirmed import",
        importBatchId: batchId,
      },
    });
  }

  await tx.importBatchRow.update({ where: { id: row.id }, data: { appliedAt } });
  await tx.importChangeSnapshot.create({
    data: {
      importBatchId: batchId,
      importBatchRowId: row.id,
      complaintId: current.id,
      changeType: ImportChangeType.UPDATE,
      beforeData: toJsonValue(beforeData),
      afterData: toJsonValue(snapshotComplaint(updated)),
      versionBefore: current.version,
      versionAfter: updated.version,
    },
  });
  await writeAuditLog(tx, {
    action: "IMPORT_COMPLAINT_UPDATED",
    entityType: "Complaint",
    entityId: current.id,
    actor,
    metadata: { batchId, rowId: row.id, action: row.action },
  });
}

export async function confirmReadyImportBatch(
  batchId: string,
  options: { actor?: string; client?: ImportConfirmationClient } = {}
): Promise<ImportConfirmationResult> {
  const actor = options.actor ?? AUDIT_ACTOR_SINGLE_ADMIN;
  const confirmedAt = new Date();
  const client = options.client ?? db;

  return client.$transaction(async (tx) => {
    const transition = await tx.importBatch.updateMany({
      where: { id: batchId, status: ImportBatchStatus.READY_FOR_CONFIRMATION },
      data: { status: ImportBatchStatus.CONFIRMING, confirmationFailureCode: null },
    });
    if (transition.count !== 1) {
      const existing = await tx.importBatch.findUnique({ where: { id: batchId }, select: { id: true } });
      throw existing
        ? new ImportConfirmationError("IMPORT_BATCH_STATE_CONFLICT", "لا يمكن تأكيد الدفعة في حالتها الحالية", 409)
        : new ImportConfirmationError("IMPORT_BATCH_NOT_FOUND", "دفعة الاستيراد غير موجودة", 404);
    }

    await writeAuditLog(tx, {
      action: "IMPORT_CONFIRMATION_STARTED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor,
    });

    const rows = await tx.importBatchRow.findMany({
      where: { importBatchId: batchId },
      orderBy: { rowNumber: "asc" },
    }) as ConfirmationRow[];
    assertBatchRowsAreConfirmable(rows);

    for (const row of rows) {
      if (row.action === ImportRowAction.NEW) {
        await applyNewRow(tx, batchId, row, actor, confirmedAt);
      }
      if (row.action === ImportRowAction.UPDATE) {
        await applyUpdateRow(tx, batchId, row, actor, confirmedAt);
      }
    }

    const counters = calculateRowCounters(rows);
    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status: ImportBatchStatus.CONFIRMED,
        confirmedAt,
        appliedCreatedRows: counters.newRows,
        appliedUpdatedRows: counters.updatedRows,
      },
    });
    await writeAuditLog(tx, {
      action: "IMPORT_CONFIRMATION_COMPLETED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor,
      metadata: { created: counters.newRows, updated: counters.updatedRows },
    });

    return {
      batchId,
      status: ImportBatchStatus.CONFIRMED,
      confirmedAt: confirmedAt.toISOString(),
      created: counters.newRows,
      updated: counters.updatedRows,
      unchanged: counters.noChangeRows,
      duplicates: counters.duplicateRows,
    };
  }, { maxWait: 10_000, timeout: 60_000 });
}

function restoreDate(value: unknown): Date | null | undefined {
  return parseDate(value);
}

function restoreSnapshotData(beforeData: Prisma.JsonValue | null): Prisma.ComplaintUncheckedUpdateManyInput {
  if (!beforeData || typeof beforeData !== "object" || Array.isArray(beforeData)) {
    throw new ImportConfirmationError("ROLLBACK_SNAPSHOT_INVALID", "لقطة التراجع غير صالحة", 409);
  }

  const data = beforeData as Record<string, unknown>;
  return {
    sourceReference: parseText(data.sourceReference),
    complaintDate: restoreDate(data.complaintDate),
    receivedAt: restoreDate(data.receivedAt) ?? undefined,
    dueDate: restoreDate(data.dueDate),
    closedAt: restoreDate(data.closedAt),
    status: parseStatus(data.status),
    subject: parseText(data.subject) ?? undefined,
    description: parseText(data.description),
    region: parseText(data.region),
    facility: parseText(data.facility),
    department: parseText(data.department),
    categoryId: parseText(data.categoryId),
    classificationId: parseText(data.classificationId),
    priority: parsePriority(data.priority),
    severity: parsePriority(data.severity),
    channel: parseText(data.channel),
    resolution: parseText(data.resolution),
    version: { increment: 1 },
  };
}

export async function rollbackConfirmedImportBatch(
  batchId: string,
  input: { reason: string; actor?: string; client?: ImportConfirmationClient }
): Promise<ImportRollbackResult> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ImportConfirmationError("ROLLBACK_REASON_REQUIRED", "سبب التراجع مطلوب", 422);
  }

  const actor = input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN;
  const rolledBackAt = new Date();
  const client = input.client ?? db;

  return client.$transaction(async (tx) => {
    const transition = await tx.importBatch.updateMany({
      where: { id: batchId, status: ImportBatchStatus.CONFIRMED },
      data: { status: ImportBatchStatus.ROLLING_BACK, rollbackFailureCode: null },
    });
    if (transition.count !== 1) {
      const existing = await tx.importBatch.findUnique({ where: { id: batchId }, select: { id: true } });
      throw existing
        ? new ImportConfirmationError("IMPORT_BATCH_STATE_CONFLICT", "لا يمكن التراجع عن الدفعة في حالتها الحالية", 409)
        : new ImportConfirmationError("IMPORT_BATCH_NOT_FOUND", "دفعة الاستيراد غير موجودة", 404);
    }

    await writeAuditLog(tx, {
      action: "IMPORT_ROLLBACK_STARTED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor,
      metadata: { reason },
    });

    const snapshots = await tx.importChangeSnapshot.findMany({
      where: { importBatchId: batchId },
      include: { importBatchRow: true },
      orderBy: { createdAt: "desc" },
    });
    let revertedCreates = 0;
    let revertedUpdates = 0;

    for (const snapshot of snapshots) {
      const current = await tx.complaint.findUnique({ where: { id: snapshot.complaintId } });
      if (!current || current.version !== snapshot.versionAfter) {
        throw new ImportConfirmationError("ROLLBACK_CONFLICT", "توجد شكاوى تغيرت بعد التأكيد ولا يمكن التراجع جزئيًا", 409);
      }

      if (snapshot.changeType === ImportChangeType.CREATE) {
        await tx.complaint.updateMany({
          where: { id: current.id, version: snapshot.versionAfter, importBatchId: batchId },
          data: { isDeleted: true, deletedAt: rolledBackAt, version: { increment: 1 } },
        });
        await tx.importBatchRow.update({ where: { id: snapshot.importBatchRowId }, data: { rolledBackAt } });
        await writeAuditLog(tx, {
          action: "IMPORT_COMPLAINT_CREATION_REVERSED",
          entityType: "Complaint",
          entityId: current.id,
          actor,
          metadata: { batchId, rowId: snapshot.importBatchRowId },
        });
        revertedCreates += 1;
      } else {
        const restoreData = restoreSnapshotData(snapshot.beforeData);
        const result = await tx.complaint.updateMany({
          where: { id: current.id, version: snapshot.versionAfter, isDeleted: false },
          data: restoreData,
        });
        if (result.count !== 1) {
          throw new ImportConfirmationError("ROLLBACK_CONFLICT", "تعذر استعادة إحدى الشكاوى بسبب تعارض لاحق", 409);
        }

        const restoredStatus = (restoreData.status as ComplaintStatus | undefined) ?? current.status;
        if (current.status !== restoredStatus) {
          await tx.complaintStatusHistory.create({
            data: {
              complaintId: current.id,
              fromStatus: current.status,
              toStatus: restoredStatus,
              changedAt: rolledBackAt,
              changedBy: actor,
              reason,
              importBatchId: batchId,
            },
          });
        }
        await tx.importBatchRow.update({ where: { id: snapshot.importBatchRowId }, data: { rolledBackAt } });
        await writeAuditLog(tx, {
          action: "IMPORT_COMPLAINT_UPDATE_REVERSED",
          entityType: "Complaint",
          entityId: current.id,
          actor,
          metadata: { batchId, rowId: snapshot.importBatchRowId },
        });
        revertedUpdates += 1;
      }
    }

    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status: ImportBatchStatus.ROLLED_BACK,
        rolledBackAt,
        rollbackReason: reason,
      },
    });
    await writeAuditLog(tx, {
      action: "IMPORT_ROLLBACK_COMPLETED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor,
      metadata: { revertedCreates, revertedUpdates },
    });

    return {
      batchId,
      status: ImportBatchStatus.ROLLED_BACK,
      rolledBackAt: rolledBackAt.toISOString(),
      revertedCreates,
      revertedUpdates,
    };
  }, { maxWait: 10_000, timeout: 60_000 });
}
