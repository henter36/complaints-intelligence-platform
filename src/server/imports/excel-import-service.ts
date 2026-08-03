import {
  ImportBatchStatus,
  ComplaintStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  type Complaint,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import {
  buildComplaintFingerprint,
  resolveComplaintIdentity,
  type ComplaintIdentityMatch,
} from "@/server/complaints/identity-service";
import {
  assertSupportedExcelUpload,
  deleteStoredImportFile,
  readStoredImportFile,
  storeImportFile,
} from "./file-storage";
import { ImportValidationError } from "./import-errors";
import { calculateRowCounters } from "./import-batch-service";
import {
  analyzeColumnMapping,
  matchComplaintColumns,
  parseColumnMapping,
  validateColumnMapping,
  type ColumnMapping,
  type ColumnMappingAnalysis,
} from "./complaint-column-schema";
import {
  getImportedStatusDisplay,
  normalizeImportRow,
  type NormalizedComplaintRow,
  type RawImportRow,
  type RowMessage,
} from "./normalization";
import { DESCRIPTION_COLUMN_MISSING_BATCH_MESSAGE } from "./operational-import-semantics";
import { maskIdentifier } from "./privacy";
import { validateNormalizedComplaintRow } from "./row-validation";
import { parseXlsxWorkbook } from "./xlsx-parser";
import { resolveImportRowReference } from "./error-report";
import { resolveSourceDetailClassification } from "@/server/classifications/source-detail-classification-resolver";

const WRITE_CHUNK_SIZE = 500;
export const DUPLICATE_BLOCKING_IMPORT_STATUSES = [
  ImportBatchStatus.UPLOADED,
  ImportBatchStatus.PARSING,
  ImportBatchStatus.VALIDATED,
  ImportBatchStatus.READY_FOR_CONFIRMATION,
  ImportBatchStatus.CONFIRMING,
  ImportBatchStatus.CONFIRMED,
  ImportBatchStatus.FAILED,
] as const;
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

export type ProcessedImportRow = {
  rowNumber: number;
  rawData: Prisma.InputJsonValue;
  normalizedData: Prisma.InputJsonValue | null;
  externalId: string | null;
  action: ImportRowAction;
  validationStatus: ImportRowValidationStatus;
  validationErrors: Prisma.InputJsonValue | null;
  validationWarnings: Prisma.InputJsonValue | null;
  matchedComplaintId: string | null;
  matchedComplaintVersion: number | null;
};

type ComplaintIndexEntry =
  | { kind: "match"; complaint: Complaint }
  | { kind: "ambiguous"; complaintIds: string[] };

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
  unmappedColumns: string[];
  mappingAnalysis: ColumnMappingAnalysis;
  columnCount: number;
  errors: Array<{ row: number; errors: RowMessage[]; warnings: RowMessage[] }>;
  preview: Array<Record<string, unknown>>;
  previewTotal: number;
  qualityIssueRowsTotal: number;
  previewTruncated: boolean;
  qualityIssuesTruncated: boolean;
  batchWarnings: RowMessage[];
  canApprove: boolean;
  failureCode?: string | null;
  failureNotes?: string | null;
};

function parsePeriodType(value?: string | null): PeriodType {
  const normalized = (value ?? "monthly").toUpperCase();
  if (Object.hasOwn(PeriodType, normalized)) {
    return PeriodType[normalized as keyof typeof PeriodType];
  }
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

function toOptionalDateKey(value: Date | string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function identityKey(identity: ComplaintIdentityMatch): string {
  return `${identity.strategy}:${identity.value}`;
}

function safeIdentityKey(input: {
  externalId?: string | null;
  sourceReference?: string | null;
  complaintDate?: Date | string | null;
  region?: string | null;
  facility?: string | null;
  department?: string | null;
  subject?: string | null;
}): string {
  return identityKey(resolveComplaintIdentity(input));
}

function fingerprintIdentityKey(input: {
  complaintDate?: Date | string | null;
  region?: string | null;
  facility?: string | null;
  department?: string | null;
  subject?: string | null;
}): string {
  return `fingerprint:${buildComplaintFingerprint(input)}`;
}

function uniqueIdentityKeys(keys: Array<string | null>): string[] {
  return [...new Set(keys.filter((key): key is string => key !== null))];
}

export function complaintCandidateIdentityKeys(complaint: Pick<Complaint, "externalId" | "sourceReference" | "complaintDate" | "region" | "facility" | "department" | "subject">): string[] {
  return uniqueIdentityKeys([
    complaint.externalId ? safeIdentityKey({ externalId: complaint.externalId }) : null,
    complaint.sourceReference && complaint.complaintDate
      ? safeIdentityKey({
          sourceReference: complaint.sourceReference,
          complaintDate: complaint.complaintDate,
        })
      : null,
    fingerprintIdentityKey(complaint),
  ]);
}

export function normalizedCandidateIdentityKeys(row: NormalizedComplaintRow): string[] {
  const complaintDate = row.complaintDate ?? row.receivedAt;

  return uniqueIdentityKeys([
    row.externalId ? safeIdentityKey({ externalId: row.externalId }) : null,
    row.sourceReference && complaintDate
      ? safeIdentityKey({ sourceReference: row.sourceReference, complaintDate })
      : null,
    fingerprintIdentityKey({
      complaintDate,
      region: row.region,
      facility: row.facility,
      department: row.department,
      subject: row.subject,
    }),
  ]);
}

export function hasMeaningfulChange(row: NormalizedComplaintRow, complaint: Complaint): boolean {
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
    [row.complainantIdentifier, complaint.complainantIdentifier],
    [row.complainantName, complaint.complainantName],
    [row.complainantPhone, complaint.complainantPhone],
    [toOptionalDateKey(row.complaintDate), toOptionalDateKey(complaint.complaintDate)],
    [toOptionalDateKey(row.receivedAt), toOptionalDateKey(complaint.receivedAt)],
    [toOptionalDateKey(row.dueDate), toOptionalDateKey(complaint.dueDate)],
    [toOptionalDateKey(row.closedAt), toOptionalDateKey(complaint.closedAt)],
  ];

  return comparisons.some(([left, right]) => left !== undefined && left !== right);
}

function resolveValidationStatus(
  errors: RowMessage[],
  warnings: RowMessage[]
): ImportRowValidationStatus {
  if (errors.length > 0) return ImportRowValidationStatus.INVALID;
  const realWarnings = warnings.filter((w) => w.level !== "derived");
  if (realWarnings.length > 0) return ImportRowValidationStatus.WARNING;
  return ImportRowValidationStatus.VALID;
}

export type ImportRowOutcome =
  | "REJECTED"
  | "IMPORTED_WITH_WARNINGS"
  | "IMPORTED";

function assertNever(value: never): never {
  throw new Error(`Unhandled import validation status: ${String(value)}`);
}

export function getImportRowOutcome(
  validationStatus: ImportRowValidationStatus
): ImportRowOutcome {
  switch (validationStatus) {
    case ImportRowValidationStatus.INVALID:
      return "REJECTED";
    case ImportRowValidationStatus.WARNING:
      return "IMPORTED_WITH_WARNINGS";
    case ImportRowValidationStatus.VALID:
    case ImportRowValidationStatus.PENDING:
      return "IMPORTED";
    default:
      return assertNever(validationStatus);
  }
}

function addComplaintIndexEntry(
  index: Map<string, ComplaintIndexEntry>,
  key: string,
  complaint: Complaint
): void {
  const current = index.get(key);
  if (!current) {
    index.set(key, { kind: "match", complaint });
    return;
  }

  if (current.kind === "match" && current.complaint.id !== complaint.id) {
    index.set(key, { kind: "ambiguous", complaintIds: [current.complaint.id, complaint.id] });
    return;
  }

  if (current.kind === "ambiguous" && !current.complaintIds.includes(complaint.id)) {
    current.complaintIds.push(complaint.id);
  }
}

async function findExistingComplaints(rows: NormalizedComplaintRow[]): Promise<Map<string, ComplaintIndexEntry>> {
  const externalIds = rows.map((row) => row.externalId).filter((value): value is string => Boolean(value));
  const sourceReferences = rows.map((row) => row.sourceReference).filter((value): value is string => Boolean(value));
  const fingerprintCandidateFilters = rows
    .filter((row) => !row.externalId && !row.sourceReference && row.subject)
    .map((row) => ({
      subject: row.subject,
      ...(row.region ? { region: row.region } : {}),
      ...(row.facility ? { facility: row.facility } : {}),
      ...(row.department ? { department: row.department } : {}),
    }));

  if (
    externalIds.length === 0 &&
    sourceReferences.length === 0 &&
    fingerprintCandidateFilters.length === 0
  ) {
    return new Map();
  }

  const complaints = await db.complaint.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(externalIds.length ? [{ externalId: { in: externalIds } }] : []),
        ...(sourceReferences.length ? [{ sourceReference: { in: sourceReferences } }] : []),
        ...fingerprintCandidateFilters,
      ],
    },
  });

  const result = new Map<string, ComplaintIndexEntry>();
  for (const complaint of complaints) {
    for (const key of complaintCandidateIdentityKeys(complaint)) {
      addComplaintIndexEntry(result, key, complaint);
    }
  }

  return result;
}

type RowClassificationContext = {
  seenImportIdentities: Map<string, number>;
  seenMatchedComplaints: Map<string, number>;
  existingByIdentity: Map<string, ComplaintIndexEntry>;
};

type RowClassification = {
  action: ImportRowAction;
  matchedComplaintId: string | null;
  matchedComplaintVersion: number | null;
};

function duplicateRowError(firstRow: number, currentRow: number, externalId?: string): RowMessage {
  const identityLabel = externalId?.trim() ? `رقم الشكوى ${externalId.trim()} ` : "";
  return {
    field: "externalId",
    code: "DUPLICATE_ROW_IN_FILE",
    message: `${identityLabel}مكرر في الصفين ${firstRow} و${currentRow}.`,
  };
}

function duplicateTargetError(firstMatchedRow: number): RowMessage {
  return {
    field: "externalId",
    code: "DUPLICATE_TARGET_COMPLAINT",
    message: `يوجد صف آخر يستهدف الشكوى نفسها: ${firstMatchedRow}`,
  };
}

function ambiguousIdentityError(): RowMessage {
  return {
    field: "externalId",
    code: "AMBIGUOUS_COMPLAINT_IDENTITY",
    message: "هوية الصف تطابق أكثر من شكوى قائمة",
  };
}

function isDuplicateImportIdentity(
  identity: string,
  rowNumber: number,
  context: RowClassificationContext,
  errors: RowMessage[],
  externalId?: string
): boolean {
  const firstRow = context.seenImportIdentities.get(identity);
  if (firstRow) {
    errors.push(duplicateRowError(firstRow, rowNumber, externalId));
    return true;
  }

  context.seenImportIdentities.set(identity, rowNumber);
  return false;
}

function findExistingComplaintEntry(
  normalized: NormalizedComplaintRow,
  existingByIdentity: Map<string, ComplaintIndexEntry>
): ComplaintIndexEntry | undefined {
  return normalizedCandidateIdentityKeys(normalized)
    .map((key) => existingByIdentity.get(key))
    .find(Boolean);
}

function classifyMatchedComplaint(
  complaint: Complaint,
  normalized: NormalizedComplaintRow,
  rowNumber: number,
  context: RowClassificationContext,
  errors: RowMessage[]
): RowClassification {
  const firstMatchedRow = context.seenMatchedComplaints.get(complaint.id);
  if (firstMatchedRow) {
    errors.push(duplicateTargetError(firstMatchedRow));
    return { action: ImportRowAction.DUPLICATE, matchedComplaintId: null, matchedComplaintVersion: null };
  }

  context.seenMatchedComplaints.set(complaint.id, rowNumber);

  return {
    action: hasMeaningfulChange(normalized, complaint)
      ? ImportRowAction.UPDATE
      : ImportRowAction.NO_CHANGE,
    matchedComplaintId: complaint.id,
    matchedComplaintVersion: complaint.version,
  };
}

function classifyValidImportRow(
  normalized: NormalizedComplaintRow,
  rowNumber: number,
  context: RowClassificationContext,
  errors: RowMessage[]
): RowClassification {
  const identity = normalizedCandidateIdentityKeys(normalized)[0];
  if (isDuplicateImportIdentity(identity, rowNumber, context, errors, normalized.externalId)) {
    return { action: ImportRowAction.DUPLICATE, matchedComplaintId: null, matchedComplaintVersion: null };
  }

  const existing = findExistingComplaintEntry(normalized, context.existingByIdentity);
  if (!existing) {
    return { action: ImportRowAction.NEW, matchedComplaintId: null, matchedComplaintVersion: null };
  }

  if (existing.kind === "ambiguous") {
    errors.push(ambiguousIdentityError());
    return { action: ImportRowAction.DUPLICATE, matchedComplaintId: null, matchedComplaintVersion: null };
  }

  return classifyMatchedComplaint(existing.complaint, normalized, rowNumber, context, errors);
}

function buildProcessedImportRow(input: {
  rawRow: RawImportRow;
  normalized: NormalizedComplaintRow;
  errors: RowMessage[];
  warnings: RowMessage[];
  classification: RowClassification;
}): ProcessedImportRow {
  return {
    rowNumber: input.rawRow.rowNumber,
    rawData: toJsonValue(input.rawRow.values),
    normalizedData: input.errors.length > 0 ? null : toJsonValue(input.normalized),
    externalId: input.normalized.externalId ?? null,
    action: input.classification.action,
    validationStatus: resolveValidationStatus(input.errors, input.warnings),
    validationErrors: input.errors.length ? toJsonValue(input.errors) : null,
    validationWarnings: input.warnings.length ? toJsonValue(input.warnings) : null,
    matchedComplaintId: input.classification.matchedComplaintId,
    matchedComplaintVersion: input.classification.matchedComplaintVersion,
  };
}

function classifyRows(input: {
  rawRows: RawImportRow[];
  normalizedRows: Array<{ row: NormalizedComplaintRow; errors: RowMessage[]; warnings: RowMessage[] }>;
  existingByIdentity: Map<string, ComplaintIndexEntry>;
}): ProcessedImportRow[] {
  const context: RowClassificationContext = {
    seenImportIdentities: new Map<string, number>(),
    seenMatchedComplaints: new Map<string, number>(),
    existingByIdentity: input.existingByIdentity,
  };

  return input.rawRows.map((rawRow, index) => {
    const normalizedResult = input.normalizedRows[index];
    const errors = [...normalizedResult.errors];
    const warnings = [...normalizedResult.warnings];
    const normalized = normalizedResult.row;
    const classification = errors.length === 0
      ? classifyValidImportRow(normalized, rawRow.rowNumber, context, errors)
      : {
          action: ImportRowAction.REJECT,
          matchedComplaintId: null,
          matchedComplaintVersion: null,
        };

    return buildProcessedImportRow({ rawRow, normalized, errors, warnings, classification });
  });
}

type ProcessedWorkbook = {
  selectedSheet: string;
  columnMapping: ColumnMapping;
  mappingAnalysis: ColumnMappingAnalysis;
  columnCount: number;
  processedRows: ProcessedImportRow[];
  counters: ReturnType<typeof calculateRowCounters>;
  batchWarnings: RowMessage[];
};

export function resolveEffectiveColumnMapping(input: {
  headers: readonly string[];
  callerMapping?: unknown;
  storedMapping?: unknown;
}): {
  columnMapping: ColumnMapping;
  mappingAnalysis: ColumnMappingAnalysis;
  manuallyMapped: boolean;
} {
  const callerMapping = parseColumnMapping(input.callerMapping);
  const storedMapping = parseColumnMapping(input.storedMapping);
  const manuallyMapped = Boolean(callerMapping ?? storedMapping);
  let columnMapping: ColumnMapping;
  let conflicts: ColumnMappingAnalysis["conflicts"] = [];

  if (callerMapping) {
    columnMapping = callerMapping;
  } else if (storedMapping) {
    columnMapping = storedMapping;
  } else {
    const matched = matchComplaintColumns([...input.headers]);
    columnMapping = matched.mapping;
    conflicts = matched.conflicts;
  }

  const mappingAnalysis = analyzeColumnMapping([...input.headers], columnMapping, {
    conflicts,
    manuallyMapped,
  });

  try {
    validateColumnMapping(columnMapping, input.headers);
  } catch (error) {
    if (
      error instanceof ImportValidationError &&
      error.code === "IMPORT_REQUIRED_COLUMNS_MISSING"
    ) {
      throw new ImportValidationError(error.code, error.message, error.status, {
        ...error.details,
        missingRequiredFields: mappingAnalysis.missingRequiredFields,
        mappingAnalysis,
      });
    }
    throw error;
  }

  return { columnMapping, mappingAnalysis, manuallyMapped };
}

async function processWorkbookPreview(
  buffer: Buffer,
  callerMapping?: unknown,
  storedMapping?: unknown
): Promise<ProcessedWorkbook> {
  const workbook = await parseXlsxWorkbook(buffer);
  const { columnMapping, mappingAnalysis } = resolveEffectiveColumnMapping({
    headers: workbook.headers,
    callerMapping,
    storedMapping,
  });

  const [categoryList, classificationList] = await Promise.all([
    db.category.findMany({ where: { isActive: true, isDeleted: false } }),
    db.classification.findMany({
      where: { isActive: true, isDeleted: false, category: { isActive: true, isDeleted: false } },
      include: { category: true },
    }),
  ]);
  const taxonomy = { categories: categoryList, classifications: classificationList };

  const hasDescriptionColumn = Object.values(columnMapping).includes("description");
  const batchWarnings: RowMessage[] = [];
  if (!hasDescriptionColumn) {
    batchWarnings.push({
      field: "description",
      code: "DESCRIPTION_COLUMN_MISSING",
      message: DESCRIPTION_COLUMN_MISSING_BATCH_MESSAGE,
      level: "warning",
    });
  }

  const normalizedRows = workbook.rows.map((row) => {
    const normResult = normalizeImportRow(row, columnMapping);
    const normalized = normResult.normalized;

    const classificationResolution = resolveSourceDetailClassification({
      sourceDetail: normalized.sourceDetail,
      explicitClassification: normalized.classification,
      classifications: classificationList,
    });
    if (classificationResolution.status === "MATCHED") {
      normalized.classification = classificationResolution.match.classificationName;
      normalized.category = classificationResolution.match.categoryName;
      normResult.derived.push({
        field: "classification",
        code: "CLASSIFICATION_RESOLVED_FROM_SOURCE_DETAIL",
        message: `تم تحديد التصنيف «${classificationResolution.match.classificationName}» من قيمة تفصيل.`,
        level: "derived",
        originalValue: normalized.sourceDetail ?? "",
        usedValue: classificationResolution.match.classificationName,
        source: "sourceDetail",
      });
    } else if (classificationResolution.status === "AMBIGUOUS") {
      normResult.warnings.push({
        field: "classification",
        code: "SOURCE_DETAIL_CLASSIFICATION_AMBIGUOUS",
        message: `قيمة التفصيل تطابق أكثر من تصنيف: ${classificationResolution.matches.map((m) => m.classificationName).join("، ")}.`,
        level: "warning",
      });
    }

    const validation = validateNormalizedComplaintRow(normalized, taxonomy);
    return {
      row: normalized,
      warnings: [
        ...normResult.warnings,
        ...normResult.derived,
        ...validation.warnings,
      ],
      errors: [...normResult.errors, ...validation.errors],
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

  return {
    selectedSheet: workbook.selectedSheet,
    columnMapping,
    mappingAnalysis,
    columnCount: workbook.headers.filter(Boolean).length,
    processedRows,
    counters: calculateRowCounters(processedRows),
    batchWarnings,
  };
}

export async function persistPreviewRows(
  batchId: string,
  processedRows: ProcessedImportRow[],
  client: Pick<typeof db, "importBatchRow"> = db
): Promise<void> {
  await client.importBatchRow.deleteMany({ where: { importBatchId: batchId } });
  for (let index = 0; index < processedRows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = processedRows.slice(index, index + WRITE_CHUNK_SIZE);
    await client.importBatchRow.createMany({
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
        matchedComplaintVersion: row.matchedComplaintVersion,
      })),
    });
  }
}

async function cleanupPreviewRows(batchId: string): Promise<void> {
  await db.importBatchRow.deleteMany({ where: { importBatchId: batchId } });
}

async function markImportBatchFailed(
  batchId: string,
  actor: string,
  error: unknown
): Promise<void> {
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
}

async function finalizeReadyImportBatch(input: {
  batchId: string;
  actor: string;
  processed: ProcessedWorkbook;
  includeValidatedTransition: boolean;
  auditAction: "IMPORT_REPROCESSED" | "IMPORT_VALIDATION_COMPLETED";
}): Promise<void> {
  await db.$transaction(async (tx) => {
    await persistPreviewRows(input.batchId, input.processed.processedRows, tx);

    if (input.includeValidatedTransition) {
      await tx.importBatch.update({
        where: { id: input.batchId },
        data: {
          ...input.processed.counters,
          status: ImportBatchStatus.VALIDATED,
          validatedAt: new Date(),
          selectedSheet: input.processed.selectedSheet,
          columnMapping: toJsonValue(input.processed.columnMapping),
        },
      });
    }

    await tx.importBatch.update({
      where: { id: input.batchId },
      data: {
        ...input.processed.counters,
        status: ImportBatchStatus.READY_FOR_CONFIRMATION,
        validatedAt: new Date(),
        processingCompletedAt: new Date(),
        selectedSheet: input.processed.selectedSheet,
        columnMapping: toJsonValue(input.processed.columnMapping),
      },
    });
    await writeAuditLog(tx, {
      action: input.auditAction,
      entityType: "ImportBatch",
      entityId: input.batchId,
      actor: input.actor,
      metadata: toJsonValue(input.processed.counters),
    });
    await writeAuditLog(tx, {
      action: "IMPORT_READY_FOR_CONFIRMATION",
      entityType: "ImportBatch",
      entityId: input.batchId,
      actor: input.actor,
    });
  }, { maxWait: 10_000, timeout: 60_000 });
}

function toImportUploadResult(
  batchId: string,
  fileName: string,
  processed: ProcessedWorkbook,
  status: ImportBatchStatus = ImportBatchStatus.READY_FOR_CONFIRMATION
): ImportUploadResult {
  const qualityIssueRows = processed.processedRows.filter(
    (row) => row.validationErrors || row.validationWarnings
  );
  const PREVIEW_LIMIT = 50;
  const QUALITY_LIMIT = 100;

  return {
    batchId,
    fileName,
    status,
    selectedSheet: processed.selectedSheet,
    totalRecords: processed.counters.totalRows,
    validRecords: processed.counters.validRows,
    newRecords: processed.counters.newRows,
    updatedRecords: processed.counters.updatedRows,
    duplicateRecords: processed.counters.duplicateRows,
    rejectedRecords: processed.counters.rejectedRows,
    incompleteRecords: processed.counters.invalidRows,
    warningRecords: processed.counters.warningRows,
    noChangeRecords: processed.counters.noChangeRows,
    columnMapping: processed.columnMapping,
    unmappedColumns: processed.mappingAnalysis.unmappedColumns,
    mappingAnalysis: processed.mappingAnalysis,
    columnCount: processed.columnCount,
    batchWarnings: processed.batchWarnings,
    errors: qualityIssueRows
      .slice(0, QUALITY_LIMIT)
      .map((row) => ({
        row: row.rowNumber,
        complaintNumber: resolveImportRowReference({
          externalId: row.externalId,
          rawData: row.rawData,
          normalizedData: row.normalizedData,
        }),
        errors: (row.validationErrors as unknown as RowMessage[]) ?? [],
        warnings: (row.validationWarnings as unknown as RowMessage[]) ?? [],
        validationStatus: row.validationStatus,
        imported: getImportRowOutcome(row.validationStatus),
      })),
    qualityIssueRowsTotal: qualityIssueRows.length,
    qualityIssuesTruncated: qualityIssueRows.length > QUALITY_LIMIT,
    preview: processed.processedRows.slice(0, PREVIEW_LIMIT).map((row) => {
      const normalized = row.normalizedData as Record<string, unknown> | null;
      const identifier =
        typeof normalized?.complainantIdentifier === "string"
          ? normalized.complainantIdentifier
          : null;
      return {
        row: row.rowNumber,
        action: row.action,
        validationStatus: row.validationStatus,
        complaintNumber: row.externalId,
        externalId: row.externalId,
        receivedDate: normalized?.receivedAt ?? normalized?.complaintDate ?? null,
        channel: normalized?.channel ?? null,
        subject: normalized?.subject ?? null,
        sourceDetail: normalized?.sourceDetail ?? null,
        sourceStatus: normalized?.sourceStatus ?? null,
        sourceActionStatus: normalized?.sourceActionStatus ?? null,
        status: normalized?.status ?? null,
        statusDisplay: typeof normalized?.status === "string"
          ? getImportedStatusDisplay(normalized.status as ComplaintStatus)
          : null,
        priority: normalized?.priority ?? null,
        region: normalized?.region ?? null,
        department: normalized?.department ?? null,
        facility: normalized?.facility ?? null,
        complainantIdentifierMasked: identifier ? maskIdentifier(identifier) : null,
      };
    }),
    previewTotal: processed.counters.totalRows,
    previewTruncated: processed.counters.totalRows > PREVIEW_LIMIT,
    canApprove:
      status === ImportBatchStatus.READY_FOR_CONFIRMATION &&
      processed.counters.invalidRows === 0 &&
      processed.counters.rejectedRows === 0,
  };
}

export async function loadImportBatchForResume(batchId: string): Promise<ImportUploadResult> {
  const batch = await db.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) {
    throw new ImportValidationError("IMPORT_BATCH_NOT_FOUND", "دفعة الاستيراد غير موجودة", 404);
  }
  if (batch.status === ImportBatchStatus.CONFIRMED || batch.status === ImportBatchStatus.ROLLED_BACK) {
    throw new ImportValidationError("IMPORT_BATCH_STATE_CONFLICT", "هذه الدفعة نهائية ولا يمكن استكمالها", 409);
  }

  const columnMapping = parseColumnMapping(batch.columnMapping) ?? Object.create(null) as ColumnMapping;
  const firstRawData = batch.rows[0]?.rawData;
  const headers = firstRawData && typeof firstRawData === "object" && !Array.isArray(firstRawData)
    ? Object.keys(firstRawData)
    : Object.keys(columnMapping);
  const processedRows: ProcessedImportRow[] = batch.rows.map((row) => ({
    rowNumber: row.rowNumber,
    rawData: row.rawData as Prisma.InputJsonValue,
    normalizedData: row.normalizedData as Prisma.InputJsonValue | null,
    externalId: row.externalId,
    action: row.action,
    validationStatus: row.validationStatus,
    validationErrors: row.validationErrors as Prisma.InputJsonValue | null,
    validationWarnings: row.validationWarnings as Prisma.InputJsonValue | null,
    matchedComplaintId: row.matchedComplaintId,
    matchedComplaintVersion: row.matchedComplaintVersion,
  }));
  const mappingAnalysis = analyzeColumnMapping(headers, columnMapping, { manuallyMapped: true });

  const result = toImportUploadResult(batch.id, batch.originalFileName, {
    selectedSheet: batch.selectedSheet ?? "",
    columnMapping,
    mappingAnalysis,
    columnCount: headers.length,
    processedRows,
    counters: calculateRowCounters(processedRows),
    batchWarnings: [],
  }, batch.status);
  return {
    ...result,
    failureCode: batch.failureCode,
    failureNotes: batch.notes,
  };
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
    const now = new Date();
    const batch = await db.$transaction(async (tx) => {
      const duplicateBatch = await tx.importBatch.findFirst({
        where: {
          fileHash: storedFile.fileHash,
          status: { in: [...DUPLICATE_BLOCKING_IMPORT_STATUSES] },
        },
        select: { id: true, status: true },
        orderBy: { createdAt: "desc" },
      });

      if (duplicateBatch) {
        const canDelete = REPROCESSABLE_STATUSES.has(duplicateBatch.status);
        throw new ImportValidationError(
          "IMPORT_FILE_ALREADY_EXISTS",
          "سبق رفع هذا الملف، ويمكنك استكمال الدفعة الحالية أو حذفها.",
          409,
          {
          existingBatchId: duplicateBatch.id,
            existingBatchStatus: duplicateBatch.status,
            canResume: duplicateBatch.status !== ImportBatchStatus.CONFIRMED,
            canDelete,
          }
        );
      }

      return tx.importBatch.create({
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

    const processed = await processWorkbookPreview(buffer);

    await finalizeReadyImportBatch({
      batchId: batch.id,
      actor,
      processed,
      includeValidatedTransition: true,
      auditAction: "IMPORT_VALIDATION_COMPLETED",
    });

    return toImportUploadResult(batch.id, input.file.name, processed);
  } catch (error) {
    if (batchId) {
      await cleanupPreviewRows(batchId);
      await markImportBatchFailed(batchId, actor, error);
    } else {
      await deleteStoredImportFile(storedFile.storageKey);
    }

    throw error;
  }
}

export async function reprocessImportBatch(batchId: string, mapping?: unknown): Promise<ImportUploadResult> {
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

  let processed: ProcessedWorkbook;
  try {
    processed = await processWorkbookPreview(buffer, mapping, batch.columnMapping);
    await finalizeReadyImportBatch({
      batchId,
      actor,
      processed,
      includeValidatedTransition: false,
      auditAction: "IMPORT_REPROCESSED",
    });
  } catch (error) {
    await cleanupPreviewRows(batchId);
    await markImportBatchFailed(batchId, actor, error);
    throw error;
  }

  return toImportUploadResult(batchId, batch.originalFileName, processed);
}
