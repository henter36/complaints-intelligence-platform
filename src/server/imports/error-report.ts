import { ImportRowAction, ImportRowValidationStatus } from "@prisma/client";

type ErrorReportRow = {
  rowNumber: number;
  action: ImportRowAction;
  validationStatus: ImportRowValidationStatus;
  validationErrors: unknown;
  validationWarnings: unknown;
};

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

function toMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(toSafeMessage).filter(Boolean);
}

function escapeCsv(value: unknown): string {
  let text = toSafeMessage(value);
  if (/^[=+\-@]/.test(text.trim())) {
    text = `'${text}`;
  }
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export function buildImportErrorCsv(rows: ErrorReportRow[]): string {
  const header = [
    "رقم الصف",
    "الإجراء",
    "حالة التحقق",
    "الحقل",
    "رمز الخطأ",
    "وصف الخطأ",
    "التحذيرات",
  ];

  const lines = rows.flatMap((row) => {
    const errors = Array.isArray(row.validationErrors) ? row.validationErrors : [];
    const warnings = toMessages(row.validationWarnings).join(" | ");

    if (errors.length === 0) {
      return [[row.rowNumber, row.action, row.validationStatus, "", "", "", warnings]];
    }

    return errors.map((error) => {
      const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
      return [
        row.rowNumber,
        row.action,
        row.validationStatus,
        record.field ?? "",
        record.code ?? "",
        record.message ?? "",
        warnings,
      ];
    });
  });

  return `\uFEFF${[header, ...lines].map((line) => line.map(escapeCsv).join(",")).join("\n")}\n`;
}
