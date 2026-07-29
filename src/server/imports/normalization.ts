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
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

export function normalizeTextCell(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  const text = String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
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

export function normalizeDateCell(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;

  if (typeof value === "number") {
    return normalizeExcelSerialDate(value) ?? undefined;
  }

  const text = normalizeTextCell(value);
  if (!text) return undefined;

  const isoLike = new Date(text);
  if (!Number.isNaN(isoLike.getTime())) return isoLike;

  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return date;
    }
  }

  return undefined;
}

function normalizeStatus(value: unknown): ComplaintStatus | undefined {
  const text = normalizeTextCell(value);
  if (!text) return undefined;
  if (text in ComplaintStatus) return ComplaintStatus[text as keyof typeof ComplaintStatus];
  return STATUS_LABELS.get(normalizeArabicToken(text));
}

function normalizePriority(value: unknown): ComplaintPriority | undefined {
  const text = normalizeTextCell(value);
  if (!text) return undefined;
  if (text in ComplaintPriority) return ComplaintPriority[text as keyof typeof ComplaintPriority];
  return PRIORITY_LABELS.get(normalizeArabicToken(text));
}

const DATE_FIELDS = new Set<ComplaintImportField>(["complaintDate", "receivedAt", "dueDate", "closedAt"]);

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

    if (DATE_FIELDS.has(field)) {
      const date = normalizeDateCell(value);
      if (value !== undefined && value !== null && value !== "" && !date) {
        errors.push({ field, code: "INVALID_DATE", message: "التاريخ غير صالح أو ملتبس" });
      } else if (date) {
        if (field === "complaintDate") normalized.complaintDate = date;
        if (field === "receivedAt") normalized.receivedAt = date;
        if (field === "dueDate") normalized.dueDate = date;
        if (field === "closedAt") normalized.closedAt = date;
      }
      continue;
    }

    if (field === "status") {
      const status = normalizeStatus(value);
      if (value !== undefined && value !== null && value !== "" && !status) {
        errors.push({ field, code: "INVALID_STATUS", message: "حالة الشكوى غير مدعومة" });
      } else if (status) {
        normalized.status = status;
      }
      continue;
    }

    if (field === "priority") {
      const priority = normalizePriority(value);
      if (value !== undefined && value !== null && value !== "" && !priority) {
        errors.push({ field, code: "INVALID_PRIORITY", message: "الأولوية غير مدعومة" });
      } else if (priority) {
        normalized.priority = priority;
      }
      continue;
    }

    const text = normalizeTextCell(value);
    if (text) {
      normalized[field] = text as never;
    }
  }

  if (!normalized.status) normalized.status = ComplaintStatus.NEW;
  if (!normalized.priority) normalized.priority = ComplaintPriority.MEDIUM;

  if (normalized.dueDate && normalized.receivedAt && normalized.dueDate < normalized.receivedAt) {
    warnings.push({
      field: "dueDate",
      code: "DUE_DATE_BEFORE_RECEIVED_AT",
      message: "تاريخ الاستحقاق يسبق تاريخ الورود",
    });
  }

  return { normalized, warnings, errors };
}
