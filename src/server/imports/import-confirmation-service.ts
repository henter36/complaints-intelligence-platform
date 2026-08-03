import {
  ComplaintPriority,
  ComplaintStatus,
  ImportBatchStatus,
  ImportChangeType,
  ImportRowAction,
  type Complaint,
  type ImportBatchRow,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { assertClosedAtMatchesStatus } from "@/server/complaints/status";
import { calculateRowCounters } from "./import-batch-service";
import { deriveSubject } from "./subject-derive";
import { startTextRiskScan } from "@/server/analytics/text-risk/text-risk-analysis-service";
import { normalizeComplainantIdentifier } from "@/server/complaints/repeated-complaint-identifier";

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
  "complainantName",
  "complainantIdentifier",
  "complainantPhone",
  "region",
  "facility",
  "department",
  "categoryId",
  "classificationId",
  "priority",
  "severity",
  "channel",
  "resolution",
  "actionTaken",
  "actionDescription",
  "sourceOrigin",
  "sourceClosedBy",
  "wingCode",
  "sourceUpdatedAt",
  "sourceModifiedAt",
  "sourceUpdatedBy",
  "sourceStatus",
  "sourceDetail",
  "sourceActionStatus",
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
  sourceDetail?: string | null;
  sourceActionStatus?: string | null;
  sourceStatus?: string | null;
  complainantName?: string | null;
  complainantIdentifier?: string | null;
  complainantPhone?: string | null;
  region?: string | null;
  facility?: string | null;
  department?: string | null;
  category?: string | null;
  classification?: string | null;
  priority?: ComplaintPriority | null;
  channel?: string | null;
  resolution?: string | null;
  actionTaken?: string | null;
  actionDescription?: string | null;
  sourceOrigin?: string | null;
  sourceClosedBy?: string | null;
  wingCode?: string | null;
  sourceUpdatedAt?: Date | null;
  sourceModifiedAt?: Date | null;
  sourceUpdatedBy?: string | null;
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
type ImportConfirmationTransaction = Prisma.TransactionClient;
type RollbackSnapshot = Prisma.ImportChangeSnapshotGetPayload<{
  include: { importBatchRow: true };
}>;
type RollbackCounters = {
  revertedCreates: number;
  revertedUpdates: number;
};

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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function snapshotInvalid(field: string, message: string): ImportConfirmationError {
  return new ImportConfirmationError(
    "ROLLBACK_SNAPSHOT_INVALID",
    message,
    409,
    { field }
  );
}

function restoreOptionalTextField(data: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(data, key)) return undefined;

  const value = parseText(data[key]);
  if (value === undefined) {
    throw snapshotInvalid(key, `قيمة ${key} في لقطة التراجع غير صالحة`);
  }

  return value;
}

function restoreRequiredTextField(data: Record<string, unknown>, key: string): string {
  if (!hasOwn(data, key)) {
    throw snapshotInvalid(key, `الحقل ${key} مفقود من لقطة التراجع`);
  }

  const value = parseText(data[key]);
  if (typeof value !== "string") {
    throw snapshotInvalid(key, `قيمة ${key} في لقطة التراجع غير صالحة`);
  }

  return value;
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
    sourceDetail: parseText(data.sourceDetail),
    sourceActionStatus: parseText(data.sourceActionStatus),
    sourceStatus: parseText(data.sourceStatus),
    complainantName: parseText(data.complainantName),
    complainantIdentifier: parseText(data.complainantIdentifier),
    complainantPhone: parseText(data.complainantPhone),
    region: parseText(data.region),
    facility: parseText(data.facility),
    department: parseText(data.department),
    category: parseText(data.category),
    classification: parseText(data.classification),
    priority: parsePriority(data.priority),
    channel: parseText(data.channel),
    resolution: parseText(data.resolution),
    actionTaken: parseText(data.actionTaken),
    actionDescription: parseText(data.actionDescription),
    sourceOrigin: parseText(data.sourceOrigin),
    sourceClosedBy: parseText(data.sourceClosedBy),
    wingCode: parseText(data.wingCode),
    sourceUpdatedAt: parseDate(data.sourceUpdatedAt),
    sourceModifiedAt: parseDate(data.sourceModifiedAt),
    sourceUpdatedBy: parseText(data.sourceUpdatedBy),
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
): Promise<string | null> {
  const normalized = parseNormalizedRow(row);
  const taxonomy = await resolveTaxonomy(tx, normalized);
  const status = normalized.status ?? ComplaintStatus.NEW;
  const closedAt = normalized.closedAt ?? null;
  assertClosedAtMatchesStatus(status, closedAt, { requireClosedAtForClosedStatuses: false });

  const complainantIdentifier = normalizeComplainantIdentifier(normalized.complainantIdentifier) ?? null;

  const complaint = await tx.complaint.create({
    data: {
      externalId: normalized.externalId ?? null,
      sourceReference: normalized.sourceReference ?? null,
      complaintDate: normalized.complaintDate ?? normalized.receivedAt ?? null,
      receivedAt: normalized.receivedAt ?? normalized.complaintDate ?? appliedAt,
      dueDate: normalized.dueDate ?? null,
      closedAt,
      status,
      subject:
        normalized.subject?.trim() ||
        normalized.sourceDetail?.trim() ||
        (normalized.description ? deriveSubject(normalized.description) : "بدون موضوع"),
      description: normalized.description ?? null,
      complainantName: normalized.complainantName ?? null,
      complainantIdentifier,
      complainantPhone: normalized.complainantPhone ?? null,
      region: normalized.region ?? null,
      facility: normalized.facility ?? null,
      department: normalized.department ?? null,
      categoryId: taxonomy.categoryId ?? null,
      classificationId: taxonomy.classificationId ?? null,
      priority: normalized.priority ?? ComplaintPriority.MEDIUM,
      severity: normalized.priority ?? ComplaintPriority.MEDIUM,
      channel: normalized.channel ?? null,
      resolution: normalized.resolution ?? null,
      actionTaken: normalized.actionTaken ?? null,
      actionDescription: normalized.actionDescription ?? null,
      sourceOrigin: normalized.sourceOrigin ?? null,
      sourceClosedBy: normalized.sourceClosedBy ?? null,
      wingCode: normalized.wingCode ?? null,
      sourceUpdatedAt: normalized.sourceUpdatedAt ?? null,
      sourceModifiedAt: normalized.sourceModifiedAt ?? null,
      sourceUpdatedBy: normalized.sourceUpdatedBy ?? null,
      sourceStatus: normalized.sourceStatus ?? null,
      sourceDetail: normalized.sourceDetail ?? null,
      sourceActionStatus: normalized.sourceActionStatus ?? null,
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
  return complainantIdentifier;
}

function assignIfDefined<T extends keyof Prisma.ComplaintUncheckedUpdateManyInput>(
  data: Prisma.ComplaintUncheckedUpdateManyInput,
  field: T,
  value: Prisma.ComplaintUncheckedUpdateManyInput[T] | undefined
): void {
  if (value !== undefined) {
    data[field] = value;
  }
}

function assignImportUpdateFields(
  data: Prisma.ComplaintUncheckedUpdateManyInput,
  current: Complaint,
  normalized: NormalizedConfirmationRow,
  taxonomy: { categoryId?: string | null; classificationId?: string | null }
): void {
  assignIfDefined(data, "sourceReference", normalized.sourceReference);
  assignIfDefined(data, "complaintDate", normalized.complaintDate);
  assignIfDefined(data, "receivedAt", normalized.receivedAt === null ? current.receivedAt : normalized.receivedAt);
  assignIfDefined(data, "dueDate", normalized.dueDate);
  assignIfDefined(data, "closedAt", normalized.closedAt);
  assignIfDefined(data, "status", normalized.status === null ? current.status : normalized.status);
  assignIfDefined(
    data,
    "subject",
    normalized.subject?.trim() ||
      normalized.sourceDetail?.trim() ||
      (normalized.description ? deriveSubject(normalized.description) : undefined)
  );
  assignIfDefined(data, "description", normalized.description);
  assignIfDefined(data, "complainantName", normalized.complainantName);
  assignIfDefined(
    data,
    "complainantIdentifier",
    normalized.complainantIdentifier !== undefined
      ? (normalizeComplainantIdentifier(normalized.complainantIdentifier) ?? null)
      : undefined
  );
  assignIfDefined(data, "complainantPhone", normalized.complainantPhone);
  assignIfDefined(data, "region", normalized.region);
  assignIfDefined(data, "facility", normalized.facility);
  assignIfDefined(data, "department", normalized.department);
  assignIfDefined(data, "categoryId", taxonomy.categoryId);
  assignIfDefined(data, "classificationId", taxonomy.classificationId);
  assignIfDefined(data, "priority", normalized.priority === null ? current.priority : normalized.priority);
  assignIfDefined(data, "severity", normalized.priority === null ? current.severity : normalized.priority);
  assignIfDefined(data, "channel", normalized.channel);
  assignIfDefined(data, "resolution", normalized.resolution);
  assignIfDefined(data, "actionTaken", normalized.actionTaken);
  assignIfDefined(data, "actionDescription", normalized.actionDescription);
  assignIfDefined(data, "sourceOrigin", normalized.sourceOrigin);
  assignIfDefined(data, "sourceClosedBy", normalized.sourceClosedBy);
  assignIfDefined(data, "wingCode", normalized.wingCode);
  assignIfDefined(data, "sourceUpdatedAt", normalized.sourceUpdatedAt);
  assignIfDefined(data, "sourceModifiedAt", normalized.sourceModifiedAt);
  assignIfDefined(data, "sourceUpdatedBy", normalized.sourceUpdatedBy);
  assignIfDefined(data, "sourceStatus", normalized.sourceStatus);
  assignIfDefined(data, "sourceDetail", normalized.sourceDetail);
  assignIfDefined(data, "sourceActionStatus", normalized.sourceActionStatus);
}

function buildUpdateData(
  current: Complaint,
  normalized: NormalizedConfirmationRow,
  taxonomy: { categoryId?: string | null; classificationId?: string | null }
): Prisma.ComplaintUncheckedUpdateManyInput {
  const data: Prisma.ComplaintUncheckedUpdateManyInput = {
    version: { increment: 1 },
  };

  assignImportUpdateFields(data, current, normalized, taxonomy);

  assertClosedAtMatchesStatus(
    (data.status as ComplaintStatus | undefined) ?? current.status,
    (data.closedAt as Date | null | undefined) ?? current.closedAt,
    { requireClosedAtForClosedStatuses: false }
  );
  return data;
}

async function applyUpdateRow(
  tx: Prisma.TransactionClient,
  batchId: string,
  row: ConfirmationRow,
  actor: string,
  appliedAt: Date
): Promise<{ beforeIdentifier: string | null; afterIdentifier: string | null }> {
  if (!row.matchedComplaintId || row.matchedComplaintVersion == null) {
    throw new ImportConfirmationError("IMPORT_PREVIEW_STALE", "معاينة الدفعة قديمة ويجب إعادة المعالجة قبل التأكيد", 409);
  }

  const current = await tx.complaint.findUnique({ where: { id: row.matchedComplaintId } });
  if (!current || current.isDeleted || current.version !== row.matchedComplaintVersion) {
    throw new ImportConfirmationError("IMPORT_PREVIEW_STALE", "تغيرت الشكاوى بعد المعاينة ويجب إعادة معالجة الدفعة", 409);
  }

  const normalized = parseNormalizedRow(row);
  const afterIdentifier = normalized.complainantIdentifier !== undefined
    ? (normalizeComplainantIdentifier(normalized.complainantIdentifier) ?? null)
    : current.complainantIdentifier;
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
  return { beforeIdentifier: current.complainantIdentifier, afterIdentifier };
}

async function recalculateIsRepeatedForIdentifiers(
  tx: Prisma.TransactionClient,
  identifiers: Iterable<string | null | undefined>
): Promise<void> {
  const normalized = new Set<string>();
  for (const id of identifiers) {
    const n = normalizeComplainantIdentifier(id);
    if (n) normalized.add(n);
  }
  if (normalized.size === 0) return;

  for (const identifier of normalized) {
    const count = await tx.complaint.count({
      where: { isDeleted: false, complainantIdentifier: identifier },
    });
    const shouldBeRepeated = count > 1;
    await tx.complaint.updateMany({
      where: {
        isDeleted: false,
        complainantIdentifier: identifier,
        isRepeated: { not: shouldBeRepeated },
      },
      data: { isRepeated: shouldBeRepeated },
    });
  }
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

    const touchedIdentifiers = new Set<string | null>();
    for (const row of rows) {
      if (row.action === ImportRowAction.NEW) {
        const id = await applyNewRow(tx, batchId, row, actor, confirmedAt);
        touchedIdentifiers.add(id);
      }
      if (row.action === ImportRowAction.UPDATE) {
        const { beforeIdentifier, afterIdentifier } = await applyUpdateRow(tx, batchId, row, actor, confirmedAt);
        touchedIdentifiers.add(beforeIdentifier);
        touchedIdentifiers.add(afterIdentifier);
      }
    }

    await recalculateIsRepeatedForIdentifiers(tx, touchedIdentifiers);

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
  }, { maxWait: 30_000, timeout: 600_000 }).then((result) => {
    // Trigger text-risk scan after the transaction commits.
    // Failure here must not propagate — the import is already confirmed.
    startTextRiskScan({ importBatchId: batchId, actor }).catch((scanError: unknown) => {
      const errorCode = scanError instanceof Error
        ? scanError.message.slice(0, 200)
        : "UNKNOWN";
      writeAuditLog(db, {
        action: "TEXT_RISK_SCAN_START_FAILED",
        entityType: "ImportBatch",
        entityId: batchId,
        actor,
        metadata: { importBatchId: batchId, errorCode },
      }).catch((logError: unknown) => {
        const logCode = logError instanceof Error ? logError.message.slice(0, 100) : "UNKNOWN";
        console.error(`[TEXT_RISK] scan start failed for batch ${batchId}: ${logCode}`);
      });
    });
    return result;
  });
}

function restoreOptionalDateField(data: Record<string, unknown>, key: string): Date | null | undefined {
  if (!hasOwn(data, key)) return undefined;

  const value = parseDate(data[key]);
  if (value === undefined) {
    throw snapshotInvalid(key, `قيمة ${key} في لقطة التراجع غير صالحة`);
  }

  return value;
}

function restoreRequiredDateField(data: Record<string, unknown>, key: string): Date {
  if (!hasOwn(data, key)) {
    throw snapshotInvalid(key, `الحقل ${key} مفقود من لقطة التراجع`);
  }

  const value = parseDate(data[key]);
  if (!(value instanceof Date)) {
    throw snapshotInvalid(key, `قيمة ${key} في لقطة التراجع غير صالحة`);
  }

  return value;
}

function restoreRequiredStatusField(data: Record<string, unknown>, key: string): ComplaintStatus {
  if (!hasOwn(data, key)) {
    throw snapshotInvalid(key, `الحقل ${key} مفقود من لقطة التراجع`);
  }

  const status = parseStatus(data[key]);
  if (!status) {
    throw snapshotInvalid(key, `قيمة ${key} في لقطة التراجع غير صالحة`);
  }

  return status;
}

function restoreRequiredPriorityField(data: Record<string, unknown>, key: string): ComplaintPriority {
  if (!hasOwn(data, key)) {
    throw snapshotInvalid(key, `الحقل ${key} مفقود من لقطة التراجع`);
  }

  const priority = parsePriority(data[key]);
  if (!priority) {
    throw snapshotInvalid(key, `قيمة ${key} في لقطة التراجع غير صالحة`);
  }

  return priority;
}

function restoreSnapshotData(beforeData: Prisma.JsonValue | null): Prisma.ComplaintUncheckedUpdateManyInput {
  if (!beforeData || typeof beforeData !== "object" || Array.isArray(beforeData)) {
    throw new ImportConfirmationError("ROLLBACK_SNAPSHOT_INVALID", "لقطة التراجع غير صالحة", 409);
  }

  const data = beforeData as Record<string, unknown>;
  return {
    sourceReference: restoreOptionalTextField(data, "sourceReference"),
    complaintDate: restoreOptionalDateField(data, "complaintDate"),
    receivedAt: restoreRequiredDateField(data, "receivedAt"),
    dueDate: restoreOptionalDateField(data, "dueDate"),
    closedAt: restoreOptionalDateField(data, "closedAt"),
    status: restoreRequiredStatusField(data, "status"),
    subject: restoreRequiredTextField(data, "subject"),
    description: restoreOptionalTextField(data, "description"),
    complainantName: restoreOptionalTextField(data, "complainantName"),
    complainantIdentifier: restoreOptionalTextField(data, "complainantIdentifier"),
    complainantPhone: restoreOptionalTextField(data, "complainantPhone"),
    region: restoreOptionalTextField(data, "region"),
    facility: restoreOptionalTextField(data, "facility"),
    department: restoreOptionalTextField(data, "department"),
    categoryId: restoreOptionalTextField(data, "categoryId"),
    classificationId: restoreOptionalTextField(data, "classificationId"),
    priority: restoreRequiredPriorityField(data, "priority"),
    severity: restoreRequiredPriorityField(data, "severity"),
    channel: restoreOptionalTextField(data, "channel"),
    resolution: restoreOptionalTextField(data, "resolution"),
    version: { increment: 1 },
  };
}

async function transitionBatchToRollingBack(
  tx: ImportConfirmationTransaction,
  batchId: string
): Promise<void> {
  const transition = await tx.importBatch.updateMany({
    where: { id: batchId, status: ImportBatchStatus.CONFIRMED },
    data: { status: ImportBatchStatus.ROLLING_BACK, rollbackFailureCode: null },
  });
  if (transition.count === 1) return;

  const existing = await tx.importBatch.findUnique({ where: { id: batchId }, select: { id: true } });
  throw existing
    ? new ImportConfirmationError("IMPORT_BATCH_STATE_CONFLICT", "لا يمكن التراجع عن الدفعة في حالتها الحالية", 409)
    : new ImportConfirmationError("IMPORT_BATCH_NOT_FOUND", "دفعة الاستيراد غير موجودة", 404);
}

async function writeRollbackStartedAudit(
  tx: ImportConfirmationTransaction,
  batchId: string,
  actor: string,
  reason: string
): Promise<void> {
  await writeAuditLog(tx, {
    action: "IMPORT_ROLLBACK_STARTED",
    entityType: "ImportBatch",
    entityId: batchId,
    actor,
    metadata: { reason },
  });
}

function loadRollbackSnapshots(
  tx: ImportConfirmationTransaction,
  batchId: string
): Promise<RollbackSnapshot[]> {
  return tx.importChangeSnapshot.findMany({
    where: { importBatchId: batchId },
    include: { importBatchRow: true },
    orderBy: { createdAt: "desc" },
  });
}

async function loadCurrentRollbackComplaint(
  tx: ImportConfirmationTransaction,
  snapshot: RollbackSnapshot
): Promise<Complaint> {
  const current = await tx.complaint.findUnique({ where: { id: snapshot.complaintId } });
  if (!current || current.version !== snapshot.versionAfter) {
    throw new ImportConfirmationError("ROLLBACK_CONFLICT", "توجد شكاوى تغيرت بعد التأكيد ولا يمكن التراجع جزئيًا", 409);
  }

  return current;
}

async function reverseCreatedComplaint(
  tx: ImportConfirmationTransaction,
  input: {
    snapshot: RollbackSnapshot;
    current: Complaint;
    batchId: string;
    rolledBackAt: Date;
    actor: string;
  }
): Promise<string | null> {
  const { snapshot, current, batchId, rolledBackAt, actor } = input;
  const result = await tx.complaint.updateMany({
    where: { id: current.id, version: snapshot.versionAfter, importBatchId: batchId, isDeleted: false },
    data: { isDeleted: true, deletedAt: rolledBackAt, version: { increment: 1 } },
  });
  if (result.count !== 1) {
    throw new ImportConfirmationError(
      "ROLLBACK_CREATE_CONFLICT",
      "تعذر التراجع عن الشكوى المنشأة بسبب تغيرها أو عدم تطابق دفعة الاستيراد",
      409,
      {
        complaintId: current.id,
        rowId: snapshot.importBatchRowId,
        expectedVersion: snapshot.versionAfter,
      }
    );
  }

  await tx.importBatchRow.update({ where: { id: snapshot.importBatchRowId }, data: { rolledBackAt } });
  await writeAuditLog(tx, {
    action: "IMPORT_COMPLAINT_CREATION_REVERSED",
    entityType: "Complaint",
    entityId: current.id,
    actor,
    metadata: { batchId, rowId: snapshot.importBatchRowId },
  });
  return current.complainantIdentifier;
}

async function writeReverseStatusHistory(
  tx: ImportConfirmationTransaction,
  input: {
    current: Complaint;
    restoredStatus: ComplaintStatus;
    batchId: string;
    rolledBackAt: Date;
    actor: string;
    reason: string;
  }
): Promise<void> {
  const { current, restoredStatus, batchId, rolledBackAt, actor, reason } = input;
  if (current.status === restoredStatus) return;

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

async function reverseUpdatedComplaint(
  tx: ImportConfirmationTransaction,
  input: {
    snapshot: RollbackSnapshot;
    current: Complaint;
    batchId: string;
    rolledBackAt: Date;
    actor: string;
    reason: string;
  }
): Promise<(string | null)[]> {
  const { snapshot, current, batchId, rolledBackAt, actor, reason } = input;
  const restoreData = restoreSnapshotData(snapshot.beforeData);
  const result = await tx.complaint.updateMany({
    where: { id: current.id, version: snapshot.versionAfter, isDeleted: false },
    data: restoreData,
  });
  if (result.count !== 1) {
    throw new ImportConfirmationError("ROLLBACK_CONFLICT", "تعذر استعادة إحدى الشكاوى بسبب تعارض لاحق", 409);
  }

  const restoredStatus = (restoreData.status as ComplaintStatus | undefined) ?? current.status;
  await writeReverseStatusHistory(tx, { current, restoredStatus, batchId, rolledBackAt, actor, reason });
  await tx.importBatchRow.update({ where: { id: snapshot.importBatchRowId }, data: { rolledBackAt } });
  await writeAuditLog(tx, {
    action: "IMPORT_COMPLAINT_UPDATE_REVERSED",
    entityType: "Complaint",
    entityId: current.id,
    actor,
    metadata: { batchId, rowId: snapshot.importBatchRowId },
  });
  const restoredIdentifier = (restoreData.complainantIdentifier as string | null | undefined) ?? current.complainantIdentifier;
  return [current.complainantIdentifier, restoredIdentifier];
}

async function reverseRollbackSnapshot(
  tx: ImportConfirmationTransaction,
  input: {
    snapshot: RollbackSnapshot;
    batchId: string;
    rolledBackAt: Date;
    actor: string;
    reason: string;
  }
): Promise<{ changeType: ImportChangeType; touchedIdentifiers: (string | null)[] }> {
  const { snapshot, batchId, rolledBackAt, actor, reason } = input;
  const current = await loadCurrentRollbackComplaint(tx, snapshot);

  if (snapshot.changeType === ImportChangeType.CREATE) {
    const identifier = await reverseCreatedComplaint(tx, { snapshot, current, batchId, rolledBackAt, actor });
    return { changeType: ImportChangeType.CREATE, touchedIdentifiers: [identifier] };
  }

  const identifiers = await reverseUpdatedComplaint(tx, { snapshot, current, batchId, rolledBackAt, actor, reason });
  return { changeType: ImportChangeType.UPDATE, touchedIdentifiers: identifiers };
}

function addRollbackCounter(counters: RollbackCounters, changeType: ImportChangeType): void {
  if (changeType === ImportChangeType.CREATE) {
    counters.revertedCreates += 1;
    return;
  }

  counters.revertedUpdates += 1;
}

async function finalizeRollbackBatch(
  tx: ImportConfirmationTransaction,
  input: {
    batchId: string;
    rolledBackAt: Date;
    reason: string;
    actor: string;
    counters: RollbackCounters;
  }
): Promise<void> {
  const { batchId, rolledBackAt, reason, actor, counters } = input;
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
    metadata: counters,
  });
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
    await transitionBatchToRollingBack(tx, batchId);
    await writeRollbackStartedAudit(tx, batchId, actor, reason);

    const snapshots = await loadRollbackSnapshots(tx, batchId);
    const counters: RollbackCounters = { revertedCreates: 0, revertedUpdates: 0 };
    const touchedIdentifiers = new Set<string | null>();
    for (const snapshot of snapshots) {
      const { changeType, touchedIdentifiers: ids } = await reverseRollbackSnapshot(tx, { snapshot, batchId, rolledBackAt, actor, reason });
      for (const id of ids) touchedIdentifiers.add(id);
      addRollbackCounter(counters, changeType);
    }

    await recalculateIsRepeatedForIdentifiers(tx, touchedIdentifiers);
    await finalizeRollbackBatch(tx, { batchId, rolledBackAt, reason, actor, counters });

    return {
      batchId,
      status: ImportBatchStatus.ROLLED_BACK,
      rolledBackAt: rolledBackAt.toISOString(),
      revertedCreates: counters.revertedCreates,
      revertedUpdates: counters.revertedUpdates,
    };
  }, { maxWait: 10_000, timeout: 60_000 });
}
