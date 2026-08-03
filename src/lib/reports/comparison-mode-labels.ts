import type { ComparisonMode } from "./report-contract";

/**
 * Short label for a comparison mode value (no "مقارنة مع" prefix).
 * Suitable for XLSX summary fields, dropdowns, and badge displays.
 *
 * Returns explicit strings for undefined/null and unsupported values so that
 * callers never silently misclassify an unknown mode as a known one.
 */
export function getComparisonModeLabelShort(
  comparisonMode: ComparisonMode | null | undefined
): string {
  if (comparisonMode == null) {
    return "وضع المقارنة غير محدد";
  }

  if (comparisonMode === "SAME_PERIOD_LAST_YEAR") {
    return "الفترة المماثلة من السنة السابقة";
  }

  if (comparisonMode === "PREVIOUS_EQUIVALENT_PERIOD") {
    return "الفترة السابقة المماثلة في المدة";
  }

  return "وضع المقارنة غير معروف";
}

/**
 * Label for the XLSX summary table "نوع المقارنة" field.
 * Returns "لا توجد فترة مقارنة" when there is no previous period.
 */
export function getComparisonModeLabelForTable(
  comparisonMode: ComparisonMode | null | undefined,
  hasPreviousPeriod: boolean
): string {
  if (!hasPreviousPeriod) return "لا توجد فترة مقارنة";
  return getComparisonModeLabelShort(comparisonMode);
}

/**
 * Full comparison sentence for cover pages (preview and PDF).
 * E.g. "مقارنة مع الفترة المماثلة من السنة السابقة: 2025-01-01 إلى 2025-12-31"
 */
export function getComparisonModeDescription(
  comparisonMode: ComparisonMode | null | undefined,
  previousPeriod: { from: string; to: string } | null | undefined
): string {
  if (!previousPeriod) return "لا تتوفر فترة زمنية للمقارنة";
  const label = getComparisonModeLabelShort(comparisonMode);
  return `مقارنة مع ${label}: ${previousPeriod.from} إلى ${previousPeriod.to}`;
}
