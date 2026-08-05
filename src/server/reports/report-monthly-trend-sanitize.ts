import type { MonthlyComplaintTrendPoint } from "@/lib/reports/report-contract";

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

/** Parse a calendar YYYY-MM-DD (or date prefix) into a UTC month key YYYY-MM. */
export function monthKeyFromReportEndDate(reportEndDate: string): string | null {
  const trimmed = reportEndDate.trim();
  // Accept full ISO or plain YYYY-MM-DD; use the date portion only.
  const datePart = trimmed.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  // Validate the calendar day exists in UTC.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function isValidMonthKey(monthKey: string): boolean {
  const match = MONTH_KEY_RE.exec(monthKey);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

/**
 * Defensive filter for monthly chart points before PDF rendering.
 * Never invents points — only drops invalid/future/duplicates and trims to maxMonths.
 */
export function sanitizeMonthlyTrendForReport(
  points: ReadonlyArray<MonthlyComplaintTrendPoint>,
  reportEndDate: string,
  maxMonths = 13
): MonthlyComplaintTrendPoint[] {
  const reportEndMonthKey = monthKeyFromReportEndDate(reportEndDate);
  if (!reportEndMonthKey || maxMonths < 1) return [];

  const byKey = new Map<string, MonthlyComplaintTrendPoint>();
  for (const point of points) {
    if (!isValidMonthKey(point.monthKey)) continue;
    if (point.monthKey > reportEndMonthKey) continue;
    // Last write wins for duplicate monthKey (deterministic by traversal order;
    // callers should already send unique keys).
    byKey.set(point.monthKey, point);
  }

  const sorted = [...byKey.values()].sort(compareMonthKeys);
  if (sorted.length <= maxMonths) return sorted;
  return sorted.slice(sorted.length - maxMonths);
}

function compareMonthKeys(
  a: MonthlyComplaintTrendPoint,
  b: MonthlyComplaintTrendPoint
): number {
  if (a.monthKey < b.monthKey) return -1;
  if (a.monthKey > b.monthKey) return 1;
  return 0;
}

/**
 * Review-artifact / fixture guard: throw if any point month is after report end month.
 */
export function assertTrendEndsAtOrBeforeReportEnd(
  monthlyStockFlow: ReadonlyArray<{ monthKey: string }>,
  reportTo: string
): void {
  const endKey = monthKeyFromReportEndDate(reportTo);
  if (!endKey) {
    throw new Error(`Invalid report period.to for trend guard: ${reportTo}`);
  }
  for (const point of monthlyStockFlow) {
    if (!isValidMonthKey(point.monthKey)) {
      throw new Error(`Invalid monthKey in trend fixture: ${point.monthKey}`);
    }
    if (point.monthKey > endKey) {
      throw new Error(
        `Trend fixture month ${point.monthKey} exceeds report end month ${endKey}`
      );
    }
  }
}
