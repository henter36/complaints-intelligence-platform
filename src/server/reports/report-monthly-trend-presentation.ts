import type { MonthlyComplaintTrendPoint } from "@/lib/reports/report-contract";
import { ARABIC_MONTH_NAMES } from "./report-executive-brief-data-service";

export type MonthlyTrendTotals = {
  registeredTotal: number;
  closedTotal: number;
};

export function calculateMonthlyTrendTotals(
  points: readonly MonthlyComplaintTrendPoint[]
): MonthlyTrendTotals {
  let registeredTotal = 0;
  let closedTotal = 0;
  for (const point of points) {
    registeredTotal += point.receivedCount;
    closedTotal += point.closedDuringMonthCount;
  }
  return { registeredTotal, closedTotal };
}

export type MonthlyTrendInsight = {
  key: string;
  text: string;
};

export type ReportMonthStatus = {
  isPartial: boolean;
  dayOfMonth: number;
  monthLabel: string;
};

type ParsedReportEnd = {
  year: number;
  month: number;
  day: number;
  monthKey: string;
};

function parseReportEndDateUtc(reportEndDate: string): ParsedReportEnd | null {
  const trimmed = reportEndDate.trim();
  const datePart = trimmed.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    monthKey: `${year}-${String(month).padStart(2, "0")}`,
  };
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatArabicMonthLabel(year: number, month: number): string {
  return `${ARABIC_MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * Resolves whether the report end date falls mid-month (partial) using UTC calendar math.
 * Returns null for invalid dates so callers can skip incorrect conclusions.
 */
export function resolveReportMonthStatus(
  reportEndDate: string
): ReportMonthStatus | null {
  const parsed = parseReportEndDateUtc(reportEndDate);
  if (!parsed) return null;
  const lastDay = daysInUtcMonth(parsed.year, parsed.month);
  return {
    isPartial: parsed.day < lastDay,
    dayOfMonth: parsed.day,
    monthLabel: formatArabicMonthLabel(parsed.year, parsed.month),
  };
}

function buildPeakRegistrationInsight(
  points: readonly MonthlyComplaintTrendPoint[]
): MonthlyTrendInsight | null {
  if (points.length === 0) return null;
  let best = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    if (
      point.receivedCount > best.receivedCount
      || (point.receivedCount === best.receivedCount && point.monthKey > best.monthKey)
    ) {
      best = point;
    }
  }
  if (best.receivedCount <= 0) return null;
  return {
    key: "peak-registration",
    text: `أعلى حجم تسجيل كان في ${best.monthLabel} بعدد ${best.receivedCount} شكوى.`,
  };
}

function buildFlowInsight(
  points: readonly MonthlyComplaintTrendPoint[],
  reportEndDate: string
): MonthlyTrendInsight | null {
  const status = resolveReportMonthStatus(reportEndDate);
  const parsed = parseReportEndDateUtc(reportEndDate);
  const partialKey = status?.isPartial && parsed ? parsed.monthKey : null;
  const complete = points.filter((point) => point.monthKey !== partialKey);
  if (complete.length === 0) return null;

  // Balanced convergence: closed within ±10% of received (90%-110%), not a
  // one-sided "closed at least 90% of received" test — the latter also
  // flags months where far more was closed than received as "converged".
  const proximate = complete.filter(
    (point) =>
      point.receivedCount > 0
      && Math.abs(point.closedDuringMonthCount - point.receivedCount) / point.receivedCount <= 0.10
  );
  if (proximate.length >= Math.ceil(complete.length / 2)) {
    return {
      key: "flow-proximity",
      text: `اقترب عدد المغلقة من عدد المسجلة في ${proximate.length} من ${complete.length} شهرًا مكتملًا.`,
    };
  }

  let gapPoint: MonthlyComplaintTrendPoint | null = null;
  let gap = 0;
  for (const point of complete) {
    const delta = point.receivedCount - point.closedDuringMonthCount;
    if (delta <= 0) continue;
    if (
      gapPoint === null
      || delta > gap
      || (delta === gap && point.monthKey > gapPoint.monthKey)
    ) {
      gap = delta;
      gapPoint = point;
    }
  }
  if (!gapPoint || gap <= 0) return null;
  return {
    key: "largest-gap",
    text: `أكبر فجوة بين المسجلة والمغلقة ظهرت في ${gapPoint.monthLabel} بفارق ${gap} شكوى.`,
  };
}

function buildMonthStatusInsight(
  reportEndDate: string
): MonthlyTrendInsight | null {
  const status = resolveReportMonthStatus(reportEndDate);
  if (!status) return null;
  if (status.isPartial) {
    return {
      key: "partial-month",
      text: `${status.monthLabel} يمثل شهرًا جزئيًا حتى يوم ${status.dayOfMonth}.`,
    };
  }
  return {
    key: "complete-month",
    text: `تنتهي البيانات بنهاية شهر ${status.monthLabel}.`,
  };
}

/**
 * Builds up to three key notes for the monthly registered/closed trend page.
 * Flow comparison excludes the partial report-end month when applicable.
 */
export function buildMonthlyTrendInsights(options: {
  points: readonly MonthlyComplaintTrendPoint[];
  reportEndDate: string;
}): MonthlyTrendInsight[] {
  const insights: MonthlyTrendInsight[] = [];
  const peak = buildPeakRegistrationInsight(options.points);
  if (peak) insights.push(peak);
  const flow = buildFlowInsight(options.points, options.reportEndDate);
  if (flow) insights.push(flow);
  const monthStatus = buildMonthStatusInsight(options.reportEndDate);
  if (monthStatus) insights.push(monthStatus);
  return insights.slice(0, 3);
}
