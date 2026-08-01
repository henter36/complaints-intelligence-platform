import { formatNumber } from "@/lib/ar-utils";
import type { ReportMatrixSection } from "./report-contract";

export function buildMatrixTruncationMessage(
  section: ReportMatrixSection
): string | null {
  const displayedRows = section.rowHeaders.length;
  const displayedColumns = section.columnHeaders.length;

  if (section.truncatedRows && section.truncatedColumns) {
    return (
      `تم عرض ${formatNumber(displayedRows)} من أصل `
      + `${formatNumber(section.totalRows)} صفاً، و`
      + `${formatNumber(displayedColumns)} من أصل `
      + `${formatNumber(section.totalColumns)} عموداً.`
    );
  }

  if (section.truncatedRows) {
    return (
      `تم عرض ${formatNumber(displayedRows)} من أصل `
      + `${formatNumber(section.totalRows)} صفاً `
      + `(أعلى ${formatNumber(section.maxRows)}).`
    );
  }

  if (section.truncatedColumns) {
    return (
      `تم عرض ${formatNumber(displayedColumns)} من أصل `
      + `${formatNumber(section.totalColumns)} عموداً `
      + `(أعلى ${formatNumber(section.maxColumns)}).`
    );
  }

  if (section.truncated) {
    return "تم اختصار عرض بيانات المصفوفة.";
  }

  return null;
}
