import { ComplaintStatus } from "@prisma/client";
import { isClosedComplaintStatus } from "@/server/complaints/status";
import type { NormalizedComplaintRow, RowMessage } from "./normalization";

export type OperationalImportRow = NormalizedComplaintRow & {
  sourceUpdatedAt?: Date;
};

export type OperationalImportSemanticsResult = {
  row: OperationalImportRow;
  warnings: RowMessage[];
  derived: RowMessage[];
};

export const DESCRIPTION_COLUMN_MISSING_BATCH_MESSAGE =
  "لم يُعثر على عمود «وصف الشكوى» في الملف، وستُستورد السجلات دون وصف.";

export const DESCRIPTION_VALUE_MISSING_ROW_MESSAGE =
  "قيمة وصف الشكوى فارغة في هذا الصف، وسيُستورد السجل دون وصف.";

function cloneDate(value: Date | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function copyOperationalRow(input: OperationalImportRow): OperationalImportRow {
  return {
    ...input,
    complaintDate: cloneDate(input.complaintDate),
    receivedAt: cloneDate(input.receivedAt),
    dueDate: cloneDate(input.dueDate),
    closedAt: cloneDate(input.closedAt),
    sourceUpdatedAt: cloneDate(input.sourceUpdatedAt),
  };
}

function applySubjectFallback(
  row: OperationalImportRow,
  derived: RowMessage[]
): void {
  if (row.subject?.trim() || !row.sourceDetail?.trim()) return;

  row.subject = row.sourceDetail.trim();
  derived.push({
    field: "subject",
    code: "SUBJECT_DERIVED_FROM_SOURCE_DETAIL",
    message: "تم استخدام قيمة «تفصيل» كموضوع للشكوى.",
    level: "derived",
    originalValue: "",
    usedValue: row.subject,
    source: "sourceDetail",
  });
}

function applyClosedAtRule(
  row: OperationalImportRow,
  derived: RowMessage[]
): void {
  const status = row.status ?? ComplaintStatus.NEW;

  if (!isClosedComplaintStatus(status) && row.closedAt) {
    derived.push({
      field: "closedAt",
      code: "CLOSED_AT_IGNORED_FOR_NON_CLOSED_STATUS",
      message: "تم تجاهل تاريخ الإغلاق لأن حالة الشكوى غير مغلقة.",
      level: "derived",
      originalValue: row.closedAt.toISOString(),
      usedValue: "",
      source: "status",
    });
    delete row.closedAt;
  }
}

export function applyOperationalImportSemantics(
  input: OperationalImportRow
): OperationalImportSemanticsResult {
  const row = copyOperationalRow(input);
  const warnings: RowMessage[] = [];
  const derived: RowMessage[] = [];

  applySubjectFallback(row, derived);
  applyClosedAtRule(row, derived);

  return { row, warnings, derived };
}

export function buildMissingDescriptionRowWarning(): RowMessage {
  return {
    field: "description",
    code: "DESCRIPTION_VALUE_MISSING",
    message: DESCRIPTION_VALUE_MISSING_ROW_MESSAGE,
    level: "warning",
    originalValue: "",
    usedValue: "",
    source: "description",
  };
}
