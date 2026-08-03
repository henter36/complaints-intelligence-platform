import type { ColumnMapping } from "./complaint-column-schema";

export const QUALITY_OBSERVATION_DISPLAY_LIMIT = 100;
export const PREVIEW_EMPTY_DISPLAY = "—";

/**
 * Presentation-only value resolution: prefer normalized, then raw (via mapping/aliases), else empty.
 * Does not mutate stored ImportBatchRow data.
 */
export function resolvePreviewValue(
  normalizedData: Record<string, unknown> | null | undefined,
  rawData: Record<string, unknown> | null | undefined,
  normalizedKey: string,
  columnMapping?: ColumnMapping | null,
  rawAliases: readonly string[] = []
): unknown {
  const normalizedValue = normalizedData?.[normalizedKey];
  if (isPresentPreviewValue(normalizedValue)) {
    return normalizedValue;
  }

  if (!rawData) {
    return undefined;
  }

  if (columnMapping) {
    for (const [header, field] of Object.entries(columnMapping)) {
      if (field === normalizedKey && isPresentPreviewValue(rawData[header])) {
        return rawData[header];
      }
    }
  }

  for (const alias of rawAliases) {
    if (isPresentPreviewValue(rawData[alias])) {
      return rawData[alias];
    }
  }

  if (isPresentPreviewValue(rawData[normalizedKey])) {
    return rawData[normalizedKey];
  }

  return undefined;
}

export function formatPreviewDisplayValue(value: unknown): string {
  if (!isPresentPreviewValue(value)) {
    return PREVIEW_EMPTY_DISPLAY;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function isPresentPreviewValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

export type QualityObservationCounts = {
  blockingRowCount: number;
  warningRowCount: number;
  displayedObservationCount: number;
  qualityDisplayLimit: number;
};

export function orderQualityObservationsForDisplay<T>(
  blockingRows: readonly T[],
  warningRows: readonly T[],
  displayLimit = QUALITY_OBSERVATION_DISPLAY_LIMIT
): T[] {
  return [...blockingRows, ...warningRows].slice(0, displayLimit);
}

export function buildQualityObservationsSummary(counts: QualityObservationCounts): string {
  const { blockingRowCount, warningRowCount, qualityDisplayLimit } = counts;
  const limitText = formatObservationCount(qualityDisplayLimit);

  if (blockingRowCount === 0 && warningRowCount === 0) {
    return "لا توجد أخطاء مانعة أو ملاحظات جودة في الصفوف المعروضة.";
  }

  if (blockingRowCount > 0 && warningRowCount > 0) {
    return [
      `يوجد ${formatObservationCount(blockingRowCount)} ${arabicCountLabel(blockingRowCount, "صف مانع", "صفان مانعان", "صفوف مانعة")}`,
      `و${formatObservationCount(warningRowCount)} ${arabicCountLabel(warningRowCount, "صف يحتوي ملاحظات جودة", "صفان يحتويان ملاحظات جودة", "صفوف تحتوي ملاحظات جودة")}.`,
      `يعرض النظام أول ${limitText} ملاحظة، مع تقديم الصفوف المانعة أولًا.`,
    ].join(" ");
  }

  if (blockingRowCount > 0) {
    const showsAllBlocking = blockingRowCount <= qualityDisplayLimit;
    return [
      `يوجد ${formatObservationCount(blockingRowCount)} ${arabicCountLabel(blockingRowCount, "صف مانع", "صفان مانعان", "صفوف مانعة")}.`,
      showsAllBlocking
        ? `يعرض النظام جميع الصفوف المانعة ضمن حد العرض البالغ ${limitText}.`
        : `يعرض النظام أول ${limitText} صف مانع.`,
    ].join(" ");
  }

  return [
    `يوجد ${formatObservationCount(warningRowCount)} ${arabicCountLabel(warningRowCount, "صف يحتوي ملاحظات جودة غير مانعة", "صفان يحتويان ملاحظات جودة غير مانعة", "صفوف تحتوي ملاحظات جودة غير مانعة")}.`,
    `يعرض النظام أول ${limitText} ملاحظة.`,
  ].join(" ");
}

function formatObservationCount(value: number): string {
  return new Intl.NumberFormat("ar-SA").format(value);
}

function arabicCountLabel(
  count: number,
  singular: string,
  dual: string,
  plural: string
): string {
  if (count === 1) return singular;
  if (count === 2) return dual;
  return plural;
}
