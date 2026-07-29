import {
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  type Complaint,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { resolveComplaintIdentity, type ComplaintIdentityMatch } from "@/server/complaints/identity-service";
import {
  assertSupportedExcelUpload,
  deleteStoredImportFile,
  readStoredImportFile,
  storeImportFile,
} from "./file-storage";
import { ImportValidationError } from "./import-errors";
import { calculateRowCounters } from "./import-batch-service";
import {
  matchComplaintColumns,
  validateColumnMapping,
  type ColumnMapping,
} from "./complaint-column-schema";
import { normalizeImportRow, type NormalizedComplaintRow, type RawImportRow, type RowMessage } from "./normalization";
import { validateNormalizedComplaintRow } from "./row-validation";
import { parseXlsxWorkbook } from "./xlsx-parser";

const WRITE_CHUNK_SIZE = 500;
const REPROCESSABLE_STATUSES = new Set<ImportBatchStatus>([
  ImportBatchStatus.UPLOADED,
  ImportBatchStatus.VALIDATED,
  ImportBatchStatus.READY_FOR_CONFIRMATION,
  ImportBatchStatus.FAILED,
]);

type UploadInput = {
  file: File;
  periodType?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  actor?: string;
};

type ProcessedImportRow = {
  rowNumber: number;
  rawData: Prisma.InputJsonValue;
  normalizedData: Prisma.InputJsonValue | null;
  externalId: string | null;
  action: ImportRowAction;
  validationStatus: ImportRowValidationStatus;
  validationErrors: Prisma.InputJsonValue | null;
  validationWarnings: Prisma.InputJsonValue | null;
  matchedComplaintId: string | null;
};

export type ImportUploadResult = {
  batchId: string;
  fileName: string;
  status: ImportBatchStatus;
  selectedSheet: string | null;
  totalRecords: number;
  validRecords: number;
  newRecords: number;
  updatedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
  incompleteRecords: number;
  warningRecords: number;
  noChangeRecords: number;
  columnMapping: ColumnMapping;
  errors: Array<{ row: number; errors: RowMessage[]; warnings: RowMessage[] }>;
  preview: Array<Record<string, unknown>>;
  canApprove: false;
};

function parsePeriodType(value?: string | null): PeriodType {
  const normalized = (value ?? "monthly").toUpperCase();
  if (normalized in PeriodType) return PeriodType[normalized as keyof typeof PeriodType];
  throw new ImportValidationError("INVALID_IMPORT_PERIOD", "نوع الفترة غير مدعوم", 400);
}

function parseDate(value: string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ImportValidationError("INVALID_IMPORT_PERIOD", "تاريخ الفترة غير صالح", 400);
  }
  return date;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item instanceof Date) return item.toISOString();
    return item;
  })) as Prisma.InputJsonValue;
}

function toDateKey(date?: Date | null): string {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

function identityKey(identity: ComplaintIdentityMatch): string {
  return `${identity.strategy}:${identity.value}`;
}

function complaintIdentityKey(complaint: Pick<Complaint, "externalId" | "sourceReference" | "complaintDate" | "region" | "facility" | "department" | "subject">): string {
  return identityKey(resolveComplaintIdentity({
    externalId: complaint.externalId,
    sourceReference: complaint.sourceReference,
    complaintDate: complaint.complaintDate,
    region: complaint.region,
    facility: complaint.facility,
    department: complaint.department,
    subject: complaint.subject,
  }));
}

function normalizedIdentityKey(row: NormalizedComplaintRow): string {
  return identityKey(resolveComplaintIdentity({
    externalId: row.externalId,
    sourceReference: row.sourceReference,
    complaintDate: row.complaintDate ?? row.receivedAt,
    region: row.region,
    facility: row.facility,
    department: row.department,
    subject: row.subject,
  }));
}

function hasMeaningfulChange(row: NormalizedComplaintRow, complaint: Complaint): boolean {
  const comparisons: Array<[unknown, unknown]> = [
    [row.subject, complaint.subject],
    [row.description, complaint.description],
    [row.status, complaint.status],
    [row.priority, complaint.priority],
    [row.region, complaint.region],
    [row.facility, complaint.facility],
    [row.department, complaint.department],
    [row.channel, complaint.channel],
    [row.resolution, complaint.resolution],
    [toDateKey(row.complaintDate), toDateKey(complaint.complaintDate)],
    [toDateKey(row.receivedAt), toDateKey(complaint.receivedAt)],
    [toDateKey(row.dueDate), toDateKey(complaint.dueDate)],
    [toDateKey(row.closedAt), toDateKey(complaint.closedAt)],
  ];

  return comparisons.some(([left, right]) => left !== undefined && left !== right);
}

async function findExistingComplaints(rows: NormalizedComplaintRow[]): Promise<Map<string, Complaint>> {
  const externalIds = rows.map((row) => row.externalId).filter((value): value is string => Boolean(value));
  const sourceReferences = rows.map((row) => row.sourceReference).filter((value): value is string => Boolean(value));

  if (externalIds.length === 0 && sourceReferences.length === 0) {
    return new Map();
  }

  const complaints = await db.complaint.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(externalIds.length ? [{ externalId: { in: externalIds } }] : []),
        ...(sourceReferences.length ? [{ sourceReference: { in: sourceReferences } }] : []),
      ],
    },
  });

  const result = new Map<string, Complaint>();
  for (const complaint of complaints) {
    result.set(complaintIdentityKey(complaint), complaint);
  }

  return result;
}

function classifyRows(input: {
  rawRows: RawImportRow[];
  normalizedRows: Array<{ row: NormalizedComplaintRow; errors: RowMessage[]; warnings: RowMessage[] }>;
  existingByIdentity: Map<string, Complaint>;
}): ProcessedImportRow[] {
  const seenImportIdentities = new Map<string, number>();
  const seenMatchedComplaints = new Map<string, number>();

  return input.rawRows.map((rawRow, index) => {
    const normalizedResult = input.normalizedRows[index];
    const errors = [...normalizedResult.errors];
    const warnings = [...normalizedResult.warnings];
    const normalized = normalizedResult.row;
    let action: ImportRowAction = ImportRowAction.REJECT;
    let matchedComplaintId: string | null = null;
    let identity: string | null = null;

    if (errors.length === 0) {
      identity = normalizedIdentityKey(normalized);
      const firstRow = seenImportIdentities.get(identity);
      if (firstRow) {
        action = ImportRowAction.DUPLICATE;
        errors.push({
          field: "externalId",
          code: "DUPLICATE_ROW_IN_FILE",
          message: `الصف يكرر صفًا سابقًا في الملف: ${firstRow}`,
        });
      } else {
        seenImportIdentities.set(identity, rawRow.rowNumber);
        const existing = input.existingByIdentity.get(identity);
        if (existing) {
          const firstMatchedRow = seenMatchedComplaints.get(existing.id);
          if (firstMatchedRow) {
            action = ImportRowAction.DUPLICATE;
            errors.push({
              field: "externalId",
              code: "DUPLICATE_TARGET_COMPLAINT",
              message: `يوجد صف آخر يستهدف الشكوى نفسها: ${firstMatchedRow}`,
            });
          } else {
            seenMatchedComplaints.set(existing.id, rawRow.rowNumber);
            matchedComplaintId = existing.id;
            action = hasMeaningfulChange(normalized, existing)
              ? ImportRowAction.UPDATE
              : ImportRowAction.NO_CHANGE;
          }
        } else {
          action = ImportRowAction.NEW;
        }
      }
    }

    if (errors.length > 0 && action !== ImportRowAction.DUPLICATE) {
      action = ImportRowAction.REJECT;
    }

    const validationStatus = errors.length > 0
      ? ImportRowValidationStatus.INVALID
      : warnings.length > 0
        ? ImportRowValidationStatus.WARNING
        : ImportRowValidationStatus.VALID;

    return {
      rowNumber: rawRow.rowNumber,
      rawData: toJsonValue(rawRow.values),
      normalizedData: errors.length > 0 ? null : toJsonValue(normalized),
      externalId: normalized.externalId ?? null,
      action,
      validationStatus,
      validationErrors: errors.length ? toJsonValue(errors) : null,
      validationWarnings: warnings.length ? toJsonValue(warnings) : null,
      matchedComplaintId,
    };
  });
}

export async function processUploadedImportFile(input: UploadInput): Promise<ImportUploadResult> {
  assertSupportedExcelUpload({
    originalFileName: input.file.name,
    mimeType: input.file.type,
    size: input.file.size,
  });

  const buffer = Buffer.from(await input.file.arrayBuffer());
  const storedFile = await storeImportFile(buffer, input.file.name);
  const actor = input.actor ?? AUDIT_ACTOR_SINGLE_ADMIN;
  let batchId: string | null = null;

  try {
    const duplicateBatch = await db.importBatch.findFirst({
      where: {
        fileHash: storedFile.fileHash,
        status: { in: [ImportBatchStatus.CONFIRMED, ImportBatchStatus.READY_FOR_CONFIRMATION] },
      },
      select: { id: true },
    });

    if (duplicateBatch) {
      throw new ImportValidationError("DUPLICATE_IMPORT_FILE", "سبق رفع هذا الملف", 409, {
        existingBatchId: duplicateBatch.id,
      });
    }

    const now = new Date();
    const batch = await db.importBatch.create({
      data: {
        fileName: storedFile.fileName,
        originalFileName: input.file.name,
        fileHash: storedFile.fileHash,
        fileSize: storedFile.fileSize,
        mimeType: input.file.type || null,
        periodType: parsePeriodType(input.periodType),
        periodStart: parseDate(input.periodStart, now),
        periodEnd: parseDate(input.periodEnd, now),
        status: ImportBatchStatus.UPLOADED,
        createdBy: actor,
        storageKey: storedFile.storageKey,
      },
    });
    batchId = batch.id;

    await writeAuditLog(db, {
      action: "IMPORT_FILE_UPLOADED",
      entityType: "ImportBatch",
      entityId: batch.id,
      actor,
      metadata: { fileHash: storedFile.fileHash, originalFileName: input.file.name },
    });

    await db.importBatch.update({
      where: { id: batch.id },
      data: { status: ImportBatchStatus.PARSING, processingStartedAt: new Date() },
    });
    await writeAuditLog(db, {
      action: "IMPORT_PARSING_STARTED",
      entityType: "ImportBatch",
      entityId: batch.id,
      actor,
    });

    const workbook = await parseXlsxWorkbook(buffer);
    const columnMapping = matchComplaintColumns(workbook.headers);
    validateColumnMapping(columnMapping);

    const taxonomy = {
      categories: await db.category.findMany({ where: { isActive: true, isDeleted: false } }),
      classifications: await db.classification.findMany({
        where: { isActive: true, isDeleted: false, category: { isActive: true, isDeleted: false } },
        include: { category: true },
      }),
    };

    const normalizedRows = workbook.rows.map((row) => {
      const normalized = normalizeImportRow(row, columnMapping);
      return {
        row: normalized.normalized,
        warnings: normalized.warnings,
        errors: [
          ...normalized.errors,
          ...validateNormalizedComplaintRow(normalized.normalized, taxonomy),
        ],
      };
    });

    const existingByIdentity = await findExistingComplaints(
      normalizedRows.filter((row) => row.errors.length === 0).map((row) => row.row)
    );
    const processedRows = classifyRows({
      rawRows: workbook.rows,
      normalizedRows,
      existingByIdentity,
    });
    const counters = calculateRowCounters(processedRows);

    await db.$transaction(async (tx) => {
      await tx.importBatchRow.deleteMany({ where: { importBatchId: batch.id } });
      for (let index = 0; index < processedRows.length; index += WRITE_CHUNK_SIZE) {
        const chunk = processedRows.slice(index, index + WRITE_CHUNK_SIZE);
        await tx.importBatchRow.createMany({
          data: chunk.map((row) => ({
            importBatchId: batch.id,
            rowNumber: row.rowNumber,
            rawData: row.rawData,
            normalizedData: row.normalizedData ?? undefined,
            externalId: row.externalId,
            action: row.action,
            validationStatus: row.validationStatus,
            validationErrors: row.validationErrors ?? undefined,
            validationWarnings: row.validationWarnings ?? undefined,
            matchedComplaintId: row.matchedComplaintId,
          })),
        });
      }
      await tx.importBatch.update({
        where: { id: batch.id },
        data: {
          ...counters,
          status: ImportBatchStatus.VALIDATED,
          validatedAt: new Date(),
          selectedSheet: workbook.selectedSheet,
          columnMapping: toJsonValue(columnMapping),
        },
      });
      await tx.importBatch.update({
        where: { id: batch.id },
        data: {
          status: ImportBatchStatus.READY_FOR_CONFIRMATION,
          processingCompletedAt: new Date(),
        },
      });
      await writeAuditLog(tx, {
        action: "IMPORT_VALIDATION_COMPLETED",
        entityType: "ImportBatch",
        entityId: batch.id,
        actor,
        metadata: toJsonValue(counters),
      });
      await writeAuditLog(tx, {
        action: "IMPORT_READY_FOR_CONFIRMATION",
        entityType: "ImportBatch",
        entityId: batch.id,
        actor,
      });
    });

    return {
      batchId: batch.id,
      fileName: input.file.name,
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      selectedSheet: workbook.selectedSheet,
      totalRecords: counters.totalRows,
      validRecords: counters.validRows,
      newRecords: counters.newRows,
      updatedRecords: counters.updatedRows,
      duplicateRecords: counters.duplicateRows,
      rejectedRecords: counters.rejectedRows,
      incompleteRecords: counters.invalidRows,
      warningRecords: counters.warningRows,
      noChangeRecords: counters.noChangeRows,
      columnMapping,
      errors: processedRows
        .filter((row) => row.validationErrors || row.validationWarnings)
        .slice(0, 100)
        .map((row) => ({
          row: row.rowNumber,
          errors: (row.validationErrors as unknown as RowMessage[]) ?? [],
          warnings: (row.validationWarnings as unknown as RowMessage[]) ?? [],
        })),
      preview: processedRows.slice(0, 50).map((row) => {
        const normalized = row.normalizedData as Record<string, unknown> | null;
        return {
        row: row.rowNumber,
        action: row.action,
        validationStatus: row.validationStatus,
        complaintNumber: row.externalId,
        externalId: row.externalId,
        receivedDate: normalized?.receivedAt ?? normalized?.complaintDate ?? null,
        channel: normalized?.channel ?? null,
        subject: normalized?.subject ?? null,
        status: normalized?.status ?? null,
        priority: normalized?.priority ?? null,
        region: normalized?.region ?? null,
        department: normalized?.department ?? null,
      };
      }),
      canApprove: false,
    };
  } catch (error) {
    if (batchId) {
      await db.importBatch.update({
        where: { id: batchId },
        data: {
          status: ImportBatchStatus.FAILED,
          failureCode: error instanceof ImportValidationError ? error.code : "IMPORT_PROCESSING_FAILED",
          notes: error instanceof Error ? error.message : "فشلت معالجة ملف الاستيراد",
          processingCompletedAt: new Date(),
        },
      });
      await writeAuditLog(db, {
        action: "IMPORT_PARSING_FAILED",
        entityType: "ImportBatch",
        entityId: batchId,
        actor,
      });
    } else {
      await deleteStoredImportFile(storedFile.storageKey);
    }

    throw error;
  }
}

export async function reprocessImportBatch(batchId: string, mapping?: ColumnMapping): Promise<ImportUploadResult> {
  const batch = await db.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    throw new ImportValidationError("IMPORT_BATCH_NOT_FOUND", "دفعة الاستيراد غير موجودة", 404);
  }
  if (!REPROCESSABLE_STATUSES.has(batch.status)) {
    throw new ImportValidationError("IMPORT_BATCH_STATE_CONFLICT", "لا يمكن إعادة معالجة الدفعة في حالتها الحالية", 409);
  }
  if (!batch.storageKey) {
    throw new ImportValidationError("IMPORT_FILE_NOT_AVAILABLE", "ملف الدفعة غير متاح لإعادة المعالجة", 409);
  }

  const buffer = await readStoredImportFile(batch.storageKey);
  const actor = AUDIT_ACTOR_SINGLE_ADMIN;
  const workbook = await parseXlsxWorkbook(buffer);
  const columnMapping = mapping ?? (batch.columnMapping as ColumnMapping | null) ?? matchComplaintColumns(workbook.headers);
  validateColumnMapping(columnMapping);

  await db.importBatch.update({
    where: { id: batchId },
    data: {
      status: ImportBatchStatus.PARSING,
      processingStartedAt: new Date(),
      processingCompletedAt: null,
      failureCode: null,
      notes: null,
    },
  });

  const taxonomy = {
    categories: await db.category.findMany({ where: { isActive: true, isDeleted: false } }),
    classifications: await db.classification.findMany({
      where: { isActive: true, isDeleted: false, category: { isActive: true, isDeleted: false } },
      include: { category: true },
    }),
  };

  const normalizedRows = workbook.rows.map((row) => {
    const normalized = normalizeImportRow(row, columnMapping);
    return {
      row: normalized.normalized,
      warnings: normalized.warnings,
      errors: [
        ...normalized.errors,
        ...validateNormalizedComplaintRow(normalized.normalized, taxonomy),
      ],
    };
  });
  const existingByIdentity = await findExistingComplaints(
    normalizedRows.filter((row) => row.errors.length === 0).map((row) => row.row)
  );
  const processedRows = classifyRows({
    rawRows: workbook.rows,
    normalizedRows,
    existingByIdentity,
  });
  const counters = calculateRowCounters(processedRows);

  await db.$transaction(async (tx) => {
    await tx.importBatchRow.deleteMany({ where: { importBatchId: batchId } });
    for (let index = 0; index < processedRows.length; index += WRITE_CHUNK_SIZE) {
      const chunk = processedRows.slice(index, index + WRITE_CHUNK_SIZE);
      await tx.importBatchRow.createMany({
        data: chunk.map((row) => ({
          importBatchId: batchId,
          rowNumber: row.rowNumber,
          rawData: row.rawData,
          normalizedData: row.normalizedData ?? undefined,
          externalId: row.externalId,
          action: row.action,
          validationStatus: row.validationStatus,
          validationErrors: row.validationErrors ?? undefined,
          validationWarnings: row.validationWarnings ?? undefined,
          matchedComplaintId: row.matchedComplaintId,
        })),
      });
    }
    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        ...counters,
        status: ImportBatchStatus.READY_FOR_CONFIRMATION,
        validatedAt: new Date(),
        processingCompletedAt: new Date(),
        selectedSheet: workbook.selectedSheet,
        columnMapping: toJsonValue(columnMapping),
      },
    });
    await writeAuditLog(tx, {
      action: "IMPORT_REPROCESSED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor,
      metadata: toJsonValue(counters),
    });
  });

  return {
    batchId,
    fileName: batch.originalFileName,
    status: ImportBatchStatus.READY_FOR_CONFIRMATION,
    selectedSheet: workbook.selectedSheet,
    totalRecords: counters.totalRows,
    validRecords: counters.validRows,
    newRecords: counters.newRows,
    updatedRecords: counters.updatedRows,
    duplicateRecords: counters.duplicateRows,
    rejectedRecords: counters.rejectedRows,
    incompleteRecords: counters.invalidRows,
    warningRecords: counters.warningRows,
    noChangeRecords: counters.noChangeRows,
    columnMapping,
    errors: processedRows
      .filter((row) => row.validationErrors || row.validationWarnings)
      .slice(0, 100)
      .map((row) => ({
        row: row.rowNumber,
        errors: (row.validationErrors as unknown as RowMessage[]) ?? [],
        warnings: (row.validationWarnings as unknown as RowMessage[]) ?? [],
      })),
    preview: processedRows.slice(0, 50).map((row) => {
      const normalized = row.normalizedData as Record<string, unknown> | null;
      return {
        row: row.rowNumber,
        action: row.action,
        validationStatus: row.validationStatus,
        complaintNumber: row.externalId,
        externalId: row.externalId,
        receivedDate: normalized?.receivedAt ?? normalized?.complaintDate ?? null,
        channel: normalized?.channel ?? null,
        subject: normalized?.subject ?? null,
        status: normalized?.status ?? null,
        priority: normalized?.priority ?? null,
        region: normalized?.region ?? null,
        department: normalized?.department ?? null,
      };
    }),
    canApprove: false,
  };
}
