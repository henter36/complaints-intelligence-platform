import { ComplaintPriority, ComplaintStatus } from "@prisma/client";
import type { ComplaintImportField, ColumnMapping } from "./complaint-column-schema";

export type RawImportRow = {
  rowNumber: number;
  values: Record<string, unknown>;
};

export type NormalizedComplaintRow = {
  externalId?: string;
  sourceReference?: string;
  complaintDate?: Date;
  receivedAt?: Date;
  dueDate?: Date;
  closedAt?: Date;
  status?: ComplaintStatus;
  subject?: string;
  description?: string;
  complainantName?: string;
  complainantIdentifier?: string;
  complainantPhone?: string;
  region?: string;
  facility?: string;
  department?: string;
  category?: string;
  classification?: string;
  priority?: ComplaintPriority;
  channel?: string;
  resolution?: string;
};

export type RowMessage = {
  field: string;
  code: string;
  message: string;
};

const STATUS_LABELS = new Map<string, ComplaintStatus>([
  ["جديده", ComplaintStatus.NEW],
  ["جديد", ComplaintStatus.NEW],
  ["مفتوحه", ComplaintStatus.OPEN],
  ["مفتوح", ComplaintStatus.OPEN],
  ["قيد المعالجه", ComplaintStatus.IN_PROGRESS],
  ["بانتظار الرد", ComplaintStatus.AWAITING_RESPONSE],
  ["محلوله", ComplaintStatus.RESOLVED],
  ["مغلقه", ComplaintStatus.CLOSED],
  ["ملغاه", ComplaintStatus.CANCELLED],
]);

const PRIORITY_LABELS = new Map<string, ComplaintPriority>([
  ["منخفضه", ComplaintPriority.LOW],
  ["متوسطه", ComplaintPriority.MEDIUM],
  ["عاليه", ComplaintPriority.HIGH],
  ["حرجه", ComplaintPriority.CRITICAL],
]);

function normalizeArabicToken(value: string): string {
  return value
    .trim()
    .replaceAll(/[إأآا]/g, "ا")
    .replaceAll("ى", "ي")
    .replaceAll("ة", "ه")
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

function primitiveCellText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return undefined;
}

export function normalizeTextCell(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  const cellText = primitiveCellText(value);
  if (cellText === undefined) return undefined;

  const text = cellText
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim().replaceAll(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || undefined;
}

export function isFormulaLikeValue(value: unknown): boolean {
  return typeof value === "string" && /^[=+\-@]/.test(value.trim());
}

export function normalizeExcelSerialDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;

  const wholeDays = Math.floor(serial);
  const milliseconds = Math.round((serial - wholeDays) * 86_400_000);
  const excelEpoch = Date.UTC(1899, 11, 30);
  return new Date(excelEpoch + wholeDays * 86_400_000 + milliseconds);
}

export function parseUtcCalendarDate(text: string): Date | undefined {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return date;
}

function parseExplicitIsoDateTime(text: string): Date | undefined {
  if (!text.includes("T") && !/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) {
    return undefined;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function normalizeDateCell(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;

  if (typeof value === "number") {
    return normalizeExcelSerialDate(value) ?? undefined;
  }

  const text = normalizeTextCell(value);
  if (!text) return undefined;

  return parseExplicitIsoDateTime(text) ?? parseUtcCalendarDate(text);
}

function normalizeStatus(value: unknown): ComplaintStatus | undefined {
  const text = normalizeTextCell(value);
  if (!text) return undefined;
  if (Object.prototype.hasOwnProperty.call(ComplaintStatus, text)) {
    return ComplaintStatus[text as keyof typeof ComplaintStatus];
  }
  return STATUS_LABELS.get(normalizeArabicToken(text));
}

function normalizePriority(value: unknown): ComplaintPriority | undefined {
  const text = normalizeTextCell(value);
  if (!text) return undefined;
  if (Object.prototype.hasOwnProperty.call(ComplaintPriority, text)) {
    return ComplaintPriority[text as keyof typeof ComplaintPriority];
  }
  return PRIORITY_LABELS.get(normalizeArabicToken(text));
}

const DATE_FIELDS = new Set<ComplaintImportField>(["complaintDate", "receivedAt", "dueDate", "closedAt"]);
const ENUM_FIELDS = new Set<ComplaintImportField>(["status", "priority"]);
const TEXT_FIELDS = [
  "externalId",
  "sourceReference",
  "subject",
  "description",
  "complainantName",
  "complainantIdentifier",
  "complainantPhone",
  "region",
  "facility",
  "department",
  "category",
  "classification",
  "channel",
  "resolution",
] as const satisfies readonly ComplaintImportField[];

type TextImportField = (typeof TEXT_FIELDS)[number];

function assignDateField(target: NormalizedComplaintRow, field: ComplaintImportField, date: Date): void {
  if (field === "complaintDate") target.complaintDate = date;
  if (field === "receivedAt") target.receivedAt = date;
  if (field === "dueDate") target.dueDate = date;
  if (field === "closedAt") target.closedAt = date;
}

function assignTextField(target: NormalizedComplaintRow, field: TextImportField, value: string): void {
  target[field] = value;
}

function normalizeDateField(
  target: NormalizedComplaintRow,
  field: ComplaintImportField,
  value: unknown,
  errors: RowMessage[]
): void {
  const date = normalizeDateCell(value);
  if (value !== undefined && value !== null && value !== "" && !date) {
    errors.push({ field, code: "INVALID_DATE", message: "التاريخ غير صالح أو ملتبس" });
    return;
  }

  if (date) assignDateField(target, field, date);
}

function normalizeEnumField(
  target: NormalizedComplaintRow,
  field: ComplaintImportField,
  value: unknown,
  errors: RowMessage[]
): void {
  if (field === "status") {
    const status = normalizeStatus(value);
    if (value !== undefined && value !== null && value !== "" && !status) {
      errors.push({ field, code: "INVALID_STATUS", message: "حالة الشكوى غير مدعومة" });
    } else if (status) {
      target.status = status;
    }
  }

  if (field === "priority") {
    const priority = normalizePriority(value);
    if (value !== undefined && value !== null && value !== "" && !priority) {
      errors.push({ field, code: "INVALID_PRIORITY", message: "الأولوية غير مدعومة" });
    } else if (priority) {
      target.priority = priority;
    }
  }
}

function normalizeMappedField(
  target: NormalizedComplaintRow,
  field: ComplaintImportField,
  value: unknown,
  errors: RowMessage[]
): void {
  if (DATE_FIELDS.has(field)) {
    normalizeDateField(target, field, value, errors);
    return;
  }

  if (ENUM_FIELDS.has(field)) {
    normalizeEnumField(target, field, value, errors);
    return;
  }

  const text = normalizeTextCell(value);
  if (text && TEXT_FIELDS.includes(field as TextImportField)) {
    assignTextField(target, field as TextImportField, text);
  }
}

function collectCrossFieldWarnings(normalized: NormalizedComplaintRow): RowMessage[] {
  if (!normalized.dueDate || !normalized.receivedAt || normalized.dueDate >= normalized.receivedAt) {
    return [];
  }

  return [{
    field: "dueDate",
    code: "DUE_DATE_BEFORE_RECEIVED_AT",
    message: "تاريخ الاستحقاق يسبق تاريخ الورود",
  }];
}

export function normalizeImportRow(
  rawRow: RawImportRow,
  mapping: ColumnMapping
): { normalized: NormalizedComplaintRow; warnings: RowMessage[]; errors: RowMessage[] } {
  const normalized: NormalizedComplaintRow = {};
  const warnings: RowMessage[] = [];
  const errors: RowMessage[] = [];

  for (const [header, field] of Object.entries(mapping)) {
    const value = rawRow.values[header];

    if (isFormulaLikeValue(value)) {
      errors.push({
        field,
        code: "FORMULA_NOT_ALLOWED",
        message: "لا يسمح باستخدام صيغ Excel في حقول الاستيراد",
      });
      continue;
    }

    normalizeMappedField(normalized, field, value, errors);
  }

  if (!normalized.status) normalized.status = ComplaintStatus.NEW;
  if (!normalized.priority) normalized.priority = ComplaintPriority.MEDIUM;

  warnings.push(...collectCrossFieldWarnings(normalized));

  return { normalized, warnings, errors };
}
