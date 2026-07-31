import { ImportRowAction, ImportRowValidationStatus } from "@prisma/client";
import { normalizeColumnHeader } from "./complaint-column-schema";

export type ErrorReportRow = {
  rowNumber: number;
  action: ImportRowAction;
  validationStatus: ImportRowValidationStatus;
  validationErrors: unknown;
  validationWarnings: unknown;
  externalId?: string | null;
  rawData?: unknown;
  normalizedData?: unknown;
};

export type ImportRowReferenceInput = {
  externalId?: string | null;
  rawData?: unknown;
  normalizedData?: unknown;
};

const COMPLAINT_NUMBER_RAW_KEYS = [
  "رقم الشكوى",
  "معرف الشكوى",
  "رقم البلاغ",
  "complaint id",
  "external id",
  "complaint number",
  "reference number",
  "الرقم المرجعي",
  "رقم المرجع",
  "المعرف",
  "المُعرف",
];

const COMPLAINT_NUMBER_HEADER_SET = new Set(
  COMPLAINT_NUMBER_RAW_KEYS.map((key) => normalizeColumnHeader(key))
);

function cellToDisplay(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function normalizeReference(value: unknown): string | null {
  const text = cellToDisplay(value);
  return text || null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveReferenceFromNormalizedData(normalizedData: unknown): string | null {
  const normalized = toRecord(normalizedData);
  if (!normalized) return null;
  return normalizeReference(normalized.externalId) ?? normalizeReference(normalized.sourceReference);
}

function isComplaintNumberHeader(header: string): boolean {
  return COMPLAINT_NUMBER_HEADER_SET.has(normalizeColumnHeader(header));
}

function resolveReferenceFromRawData(rawData: unknown): string | null {
  const raw = toRecord(rawData);
  if (!raw) return null;

  for (const [header, value] of Object.entries(raw)) {
    if (!isComplaintNumberHeader(header)) continue;
    const text = normalizeReference(value);
    if (text) return text;
  }

  return null;
}

export function resolveImportRowReference(row: ImportRowReferenceInput): string {
  return (
    normalizeReference(row.externalId) ??
    resolveReferenceFromNormalizedData(row.normalizedData) ??
    resolveReferenceFromRawData(row.rawData) ??
    "غير متوفر"
  );
}

export function toSafeMessage(value: unknown): string {
  if (typeof value === "string") return value;

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (value instanceof Error) return value.message;

  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }

  return "";
}

function toMessageRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return item as Record<string, unknown>;
    }
    return { message: toSafeMessage(item) };
  });
}

function escapeCsv(value: unknown): string {
  let text = toSafeMessage(value);
  if (/^[=+\-@]/.test(text.trim())) {
    text = `'${text}`;
  }
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function levelLabel(level: unknown, fallback: "خطأ" | "تحذير" | "قيمة مشتقة"): string {
  if (level === "derived") return "قيمة مشتقة";
  if (level === "warning") return "تحذير";
  if (level === "error") return "خطأ";
  return fallback;
}

function importedLabel(status: ImportRowValidationStatus): string {
  if (status === ImportRowValidationStatus.INVALID) return "لا";
  if (status === ImportRowValidationStatus.WARNING) return "نعم مع تحذيرات";
  return "نعم";
}

function suggestedAction(code: unknown, levelFallback: string): string {
  const value = typeof code === "string" ? code : "";
  if (value.includes("DESCRIPTION")) return "راجع نص الشكوى أو الموضوع في المصدر";
  if (value.includes("CLOSED_AT") || value.includes("TERMINAL_STATUS")) {
    return "أضف تاريخ إغلاق في المصدر أو راجع الحالة";
  }
  if (value.includes("IDENTITY") || value.includes("MISSING")) {
    return "أكمل الحقل الإلزامي ثم أعد المعالجة";
  }
  if (levelFallback === "تحذير" || levelFallback === "قيمة مشتقة") {
    return "مراجعة جودة بيانات لاحقة";
  }
  return "صحّح الصف ثم أعد المعالجة";
}

export function buildImportErrorCsv(rows: ErrorReportRow[]): string {
  const header = [
    "رقم الصف",
    "رقم الشكوى",
    "المستوى",
    "الحقل",
    "القيمة الأصلية",
    "القيمة المستخدمة",
    "مصدر القيمة",
    "رمز التحقق",
    "الرسالة",
    "تم الاستيراد",
    "الإجراء المقترح",
    "الإجراء",
    "حالة التحقق",
  ];

  const lines = rows.flatMap((row) => {
    const complaintNumber = resolveImportRowReference(row);
    const imported = importedLabel(row.validationStatus);
    const errors = toMessageRecords(row.validationErrors);
    const warnings = toMessageRecords(row.validationWarnings);
    const messages = [
      ...errors.map((item) => ({ item, fallbackLevel: "خطأ" as const })),
      ...warnings.map((item) => ({ item, fallbackLevel: "تحذير" as const })),
    ];

    if (messages.length === 0) {
      return [[
        row.rowNumber,
        complaintNumber,
        "تحذير",
        "",
        "",
        "",
        "",
        "",
        "",
        imported,
        "مراجعة جودة بيانات لاحقة",
        row.action,
        row.validationStatus,
      ]];
    }

    return messages.map(({ item, fallbackLevel }) => {
      const level = levelLabel(item.level, fallbackLevel);
      return [
        row.rowNumber,
        complaintNumber,
        level,
        item.field ?? "",
        item.originalValue ?? "",
        item.usedValue ?? "",
        item.source ?? "",
        item.code ?? "",
        item.message ?? "",
        imported,
        suggestedAction(item.code, level),
        row.action,
        row.validationStatus,
      ];
    });
  });

  return `\uFEFF${[header, ...lines].map((line) => line.map(escapeCsv).join(",")).join("\n")}\n`;
}
