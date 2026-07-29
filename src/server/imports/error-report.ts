import { ImportRowAction, ImportRowValidationStatus } from "@prisma/client";

type ErrorReportRow = {
  rowNumber: number;
  action: ImportRowAction;
  validationStatus: ImportRowValidationStatus;
  validationErrors: unknown;
  validationWarnings: unknown;
};

function toMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === "object" && "message" in item) {
      return String((item as { message?: unknown }).message ?? "");
    }
    return String(item);
  }).filter(Boolean);
}

function escapeCsv(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text.trim())) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
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
