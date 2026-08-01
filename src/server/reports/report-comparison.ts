import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildComplaintWhere, parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import { buildComplaintQueryParams, type ReportFilters } from "./report-definition-service";

// ---------------------------------------------------------------------------
// Centralized period-comparison module.
//
// This is the SINGLE source of truth for period comparison used by the
// executive summary report (PDF + XLSX). `derivePreviousPeriodRange` lives
// here and nowhere else so the "same duration, immediately-before, no overlap"
// rule cannot drift between services.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_TREND_SERIES = 8;
export const DEPT_CLASS_RISES_LIMIT = 20;
export const DEFAULT_MINIMUM_INCREASE_COUNT = 1;

const OTHER_REGIONS_LABEL = "مناطق أخرى";
const UNSPECIFIED_REGION_LABEL = "غير محدد";

export type PeriodRange = { from: Date; toExclusive: Date };

/**
 * Derives the previous period range that is:
 * - exactly the same duration as the current period, and
 * - immediately before it (no gap, no overlap): previous.toExclusive === from.
 * The current period is [from, toExclusive) using half-open intervals.
 * Returns null when the range is invalid (duration <= 0).
 */
export function derivePreviousPeriodRange(from: Date, toExclusive: Date): PeriodRange | null {
  const duration = toExclusive.getTime() - from.getTime();
  if (duration <= 0) return null;
  return {
    from: new Date(from.getTime() - duration),
    toExclusive: from,
  };
}

export type RegionDayPoint = { date: string; count: number };
export type RegionTrendSeries = { regionName: string; points: RegionDayPoint[] };
export type RegionTrendData = {
  allDates: string[];
  series: RegionTrendSeries[];
  truncated: boolean;
  otherSeriesName: string | null;
};

export type TrendDirection = "ارتفاع" | "انخفاض" | "دون تغير" | "جديد" | "دون شكاوى";

export type RegionChangeRow = {
  regionName: string;
  currentCount: number;
  previousCount: number;
  difference: number;
  changeRate: number | null;
  direction: TrendDirection;
};

export type DeptClassRiseRow = {
  departmentId: string;
  departmentName: string;
  classificationId: string;
  classificationName: string;
  currentCount: number;
  previousCount: number;
  difference: number;
  changeRate: number | null;
  classificationContribution: number;
};

export type ComparisonWarning =
  | { code: "NO_COMPARISON_PERIOD"; message: string }
  | { code: "CHART_TRUNCATED"; message: string; shown: number; total: number }
  | { code: "RISES_TRUNCATED"; message: string; shown: number; total: number }
  | { code: "MISSING_DEPARTMENT"; count: number; message: string }
  | { code: "MISSING_CLASSIFICATION"; count: number; message: string };

/**
 * All dept+class pairs that appeared in either the current or the previous
 * period. Used for continuity analysis (persistent / new / resolved) so that
 * resolved pairs (present in previous only) are not lost in the "rises" list.
 */
export type DeptClassPeriodCount = {
  departmentId: string;
  departmentName: string;
  classificationId: string;
  classificationName: string;
  currentCount: number;
  previousCount: number;
};

export type ComparisonResult = {
  currentPeriod: PeriodRange;
  previousPeriod: PeriodRange | null;
  regionTrend: RegionTrendData;
  regionChanges: RegionChangeRow[];
  deptClassRises: DeptClassRiseRow[];
  deptClassRisesTotal: number;
  /** All dept×class pairs with counts from both periods (used for continuity). */
  deptClassAllPairs: DeptClassPeriodCount[];
  executiveSummaryPoints: string[];
  warnings: ComparisonWarning[];
};

// Minimal projection needed for all comparison aggregations. Region and
// department are plain string columns on Complaint; classification is a
// relation carrying the Arabic display name (nameAr).
const comparisonSelect = {
  complaintDate: true,
  receivedAt: true,
  region: true,
  department: true,
  classificationId: true,
  classification: { select: { id: true, nameAr: true } },
} satisfies Prisma.ComplaintSelect;

type ComparisonComplaint = Prisma.ComplaintGetPayload<{ select: typeof comparisonSelect }>;

/**
 * Builds the non-date where clause for a period. We deliberately reuse
 * complaint-query-service's `buildComplaintWhere` so the SAME non-date filters
 * (region/department/classification/priority/status/...) are applied to both
 * periods — the comparison must be apples-to-apples. The date window is then
 * overridden with a half-open [from, toExclusive) range on complaintDate,
 * falling back to receivedAt for rows without a complaintDate is NOT done here
 * because the KPI service and query layer both key on complaintDate.
 */
function buildPeriodWhere(filters: ReportFilters, period: PeriodRange, now: Date): Prisma.ComplaintWhereInput {
  const params = buildComplaintQueryParams(filters);
  // Strip the report's own date window; we apply the exact period window below.
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const where = buildComplaintWhere(query, now);
  // Half-open interval [from, toExclusive) on complaintDate.
  where.complaintDate = { gte: period.from, lt: period.toExclusive };
  return where;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function complaintDay(complaint: ComparisonComplaint): string {
  return dayKey(complaint.complaintDate ?? complaint.receivedAt);
}

function regionName(complaint: ComparisonComplaint): string {
  return complaint.region ?? UNSPECIFIED_REGION_LABEL;
}

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

/** currentCount - previousCount as a rate; null when previousCount === 0. */
function computeChangeRate(currentCount: number, previousCount: number): number | null {
  if (previousCount === 0) return null;
  return roundRate(((currentCount - previousCount) / previousCount) * 100);
}

// ---------------------------------------------------------------------------
// Region trend (daily counts per region across the current period)
// ---------------------------------------------------------------------------

function enumerateDays(period: PeriodRange): string[] {
  const days: string[] = [];
  const startMs = Date.UTC(
    period.from.getUTCFullYear(),
    period.from.getUTCMonth(),
    period.from.getUTCDate()
  );
  for (let ms = startMs; ms < period.toExclusive.getTime(); ms += DAY_MS) {
    days.push(dayKey(new Date(ms)));
  }
  return days;
}

function buildRegionTrend(
  current: ComparisonComplaint[],
  period: PeriodRange
): { data: RegionTrendData; warning: ComparisonWarning | null } {
  const allDates = enumerateDays(period);

  // Totals and per-day counts per region.
  const totalsByRegion = new Map<string, number>();
  const perDayByRegion = new Map<string, Map<string, number>>();
  for (const complaint of current) {
    const name = regionName(complaint);
    const day = complaintDay(complaint);
    totalsByRegion.set(name, (totalsByRegion.get(name) ?? 0) + 1);
    const dayMap = perDayByRegion.get(name) ?? new Map<string, number>();
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
    perDayByRegion.set(name, dayMap);
  }

  const sortedRegions = Array.from(totalsByRegion.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ar")
  );

  const topRegions = sortedRegions.slice(0, MAX_TREND_SERIES);
  const otherRegions = sortedRegions.slice(MAX_TREND_SERIES);
  const truncated = otherRegions.length > 0;

  const series: RegionTrendSeries[] = topRegions.map(([name]) => {
    const dayMap = perDayByRegion.get(name) ?? new Map<string, number>();
    return {
      regionName: name,
      points: allDates.map((date) => ({ date, count: dayMap.get(date) ?? 0 })),
    };
  });

  if (truncated) {
    // Aggregate every "other" region into a single series. Because each
    // complaint belongs to exactly one region, and named vs. other regions
    // are disjoint sets, no complaint is counted twice.
    const otherDayCounts = new Map<string, number>();
    for (const [name] of otherRegions) {
      const dayMap = perDayByRegion.get(name);
      if (!dayMap) continue;
      for (const [date, count] of dayMap) {
        otherDayCounts.set(date, (otherDayCounts.get(date) ?? 0) + count);
      }
    }
    series.push({
      regionName: OTHER_REGIONS_LABEL,
      points: allDates.map((date) => ({ date, count: otherDayCounts.get(date) ?? 0 })),
    });
  }

  const warning: ComparisonWarning | null = truncated
    ? {
        code: "CHART_TRUNCATED",
        message: `تم عرض أعلى ${MAX_TREND_SERIES} مناطق فقط في الرسم البياني، وتم تجميع البقية ضمن "${OTHER_REGIONS_LABEL}".`,
        shown: MAX_TREND_SERIES,
        total: sortedRegions.length,
      }
    : null;

  return {
    data: {
      allDates,
      series,
      truncated,
      otherSeriesName: truncated ? OTHER_REGIONS_LABEL : null,
    },
    warning,
  };
}

// ---------------------------------------------------------------------------
// Region change rows
// ---------------------------------------------------------------------------

function countByRegion(complaints: ComparisonComplaint[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const complaint of complaints) {
    const name = regionName(complaint);
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return map;
}

function resolveDirection(currentCount: number, previousCount: number): TrendDirection {
  if (currentCount > 0 && previousCount === 0) return "جديد";
  if (currentCount === 0 && previousCount === 0) return "دون شكاوى";
  if (currentCount > previousCount) return "ارتفاع";
  if (currentCount < previousCount) return "انخفاض";
  return "دون تغير";
}

const DIRECTION_SORT_RANK: Record<TrendDirection, number> = {
  ارتفاع: 0,
  جديد: 1,
  "دون تغير": 2,
  انخفاض: 3,
  "دون شكاوى": 4,
};

function compareRegionChangeRows(a: RegionChangeRow, b: RegionChangeRow): number {
  const rankDiff = DIRECTION_SORT_RANK[a.direction] - DIRECTION_SORT_RANK[b.direction];
  if (rankDiff !== 0) return rankDiff;

  // Within "ارتفاع" and "انخفاض": by difference desc (for انخفاض this yields
  // least-negative first -> most-negative last), then name asc.
  if (a.direction === "ارتفاع" || a.direction === "انخفاض") {
    const byDiff = b.difference - a.difference;
    if (byDiff !== 0) return byDiff;
  }
  return a.regionName.localeCompare(b.regionName, "ar");
}

function buildRegionChanges(
  current: ComparisonComplaint[],
  previous: ComparisonComplaint[]
): RegionChangeRow[] {
  const currentCounts = countByRegion(current);
  const previousCounts = countByRegion(previous);
  const regionNames = new Set<string>([...currentCounts.keys(), ...previousCounts.keys()]);

  const rows: RegionChangeRow[] = [];
  for (const name of regionNames) {
    const currentCount = currentCounts.get(name) ?? 0;
    const previousCount = previousCounts.get(name) ?? 0;
    const difference = currentCount - previousCount;
    rows.push({
      regionName: name,
      currentCount,
      previousCount,
      difference,
      changeRate: computeChangeRate(currentCount, previousCount),
      direction: resolveDirection(currentCount, previousCount),
    });
  }

  return rows.sort(compareRegionChangeRows);
}

// ---------------------------------------------------------------------------
// Department + classification rises
// ---------------------------------------------------------------------------

type DeptClassAccumulator = {
  departmentId: string;
  departmentName: string;
  classificationId: string;
  classificationName: string;
  currentCount: number;
  previousCount: number;
};

function deptClassKey(departmentId: string, classificationId: string): string {
  return `${departmentId} ${classificationId}`;
}

/** True when a complaint has both a usable department and classification id. */
function hasValidDeptAndClass(complaint: ComparisonComplaint): boolean {
  return Boolean(complaint.department) && Boolean(complaint.classificationId);
}

function accumulateDeptClass(
  map: Map<string, DeptClassAccumulator>,
  complaints: ComparisonComplaint[],
  field: "currentCount" | "previousCount"
): void {
  for (const complaint of complaints) {
    if (!hasValidDeptAndClass(complaint)) continue;
    const departmentId = complaint.department!;
    const classificationId = complaint.classificationId!;
    const key = deptClassKey(departmentId, classificationId);
    const existing =
      map.get(key) ??
      ({
        departmentId,
        departmentName: departmentId,
        classificationId,
        classificationName: complaint.classification?.nameAr ?? classificationId,
        currentCount: 0,
        previousCount: 0,
      } satisfies DeptClassAccumulator);
    // Prefer a real classification name whenever we encounter one.
    if (complaint.classification?.nameAr) {
      existing.classificationName = complaint.classification.nameAr;
    }
    existing[field] += 1;
    map.set(key, existing);
  }
}

function countMissingDeptOrClass(complaints: ComparisonComplaint[]): {
  missingDepartment: number;
  missingClassification: number;
} {
  let missingDepartment = 0;
  let missingClassification = 0;
  for (const complaint of complaints) {
    if (!complaint.department) missingDepartment += 1;
    if (!complaint.classificationId) missingClassification += 1;
  }
  return { missingDepartment, missingClassification };
}

function buildDeptClassRises(
  current: ComparisonComplaint[],
  previous: ComparisonComplaint[],
  minimumIncreaseCount: number
): { rows: DeptClassRiseRow[]; total: number; allPairs: DeptClassPeriodCount[]; warnings: ComparisonWarning[] } {
  const warnings: ComparisonWarning[] = [];
  const map = new Map<string, DeptClassAccumulator>();
  accumulateDeptClass(map, current, "currentCount");
  accumulateDeptClass(map, previous, "previousCount");

  const missing = countMissingDeptOrClass(current);
  if (missing.missingDepartment > 0) {
    warnings.push({
      code: "MISSING_DEPARTMENT",
      count: missing.missingDepartment,
      message: `تم استبعاد ${missing.missingDepartment} شكوى من تحليل الارتفاع لعدم تحديد الإدارة.`,
    });
  }
  if (missing.missingClassification > 0) {
    warnings.push({
      code: "MISSING_CLASSIFICATION",
      count: missing.missingClassification,
      message: `تم استبعاد ${missing.missingClassification} شكوى من تحليل الارتفاع لعدم تحديد التصنيف.`,
    });
  }

  // All pairs (for continuity analysis).
  const allPairs: DeptClassPeriodCount[] = Array.from(map.values()).map((acc) => ({
    departmentId: acc.departmentId,
    departmentName: acc.departmentName,
    classificationId: acc.classificationId,
    classificationName: acc.classificationName,
    currentCount: acc.currentCount,
    previousCount: acc.previousCount,
  }));

  // Rising rows only.
  const rising = Array.from(map.values())
    .map((accumulator) => ({
      ...accumulator,
      difference: accumulator.currentCount - accumulator.previousCount,
    }))
    .filter((row) => row.difference >= minimumIncreaseCount && row.currentCount > row.previousCount);

  // Sum of positive diffs per department (denominator for contribution).
  const positiveDiffByDept = new Map<string, number>();
  for (const row of rising) {
    positiveDiffByDept.set(row.departmentId, (positiveDiffByDept.get(row.departmentId) ?? 0) + row.difference);
  }

  const rows: DeptClassRiseRow[] = rising.map((row) => {
    const deptPositiveTotal = positiveDiffByDept.get(row.departmentId) ?? 0;
    const contribution = deptPositiveTotal > 0 ? roundRate((row.difference / deptPositiveTotal) * 100) : 0;
    return {
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      classificationId: row.classificationId,
      classificationName: row.classificationName,
      currentCount: row.currentCount,
      previousCount: row.previousCount,
      difference: row.difference,
      changeRate: computeChangeRate(row.currentCount, row.previousCount),
      classificationContribution: contribution,
    };
  });

  rows.sort(
    (a, b) =>
      b.difference - a.difference ||
      b.currentCount - a.currentCount ||
      a.departmentName.localeCompare(b.departmentName, "ar") ||
      a.classificationName.localeCompare(b.classificationName, "ar")
  );

  const total = rows.length;

  if (rows.length > DEPT_CLASS_RISES_LIMIT) {
    warnings.push({
      code: "RISES_TRUNCATED",
      message: `تم عرض أعلى ${DEPT_CLASS_RISES_LIMIT} صفاً من أصل ${total} صفاً في جدول الارتفاعات.`,
      shown: DEPT_CLASS_RISES_LIMIT,
      total: total,
    });
  }

  return { rows: rows.slice(0, DEPT_CLASS_RISES_LIMIT), total, allPairs, warnings };
}

// ---------------------------------------------------------------------------
// Executive summary points (neutral Arabic text)
// ---------------------------------------------------------------------------

function formatSignedRate(rate: number | null): string {
  if (rate === null) return "";
  const sign = rate > 0 ? "+" : "";
  return ` (${sign}${rate}%)`;
}

function buildExecutiveSummaryPoints(
  currentTotal: number,
  previousTotal: number | null,
  regionChanges: RegionChangeRow[],
  deptClassRises: DeptClassRiseRow[]
): string[] {
  const points: string[] = [];

  // Point 1: total this period vs previous, neutral wording.
  if (previousTotal === null) {
    points.push(`استُقبلت خلال الفترة الحالية ${currentTotal} شكوى.`);
  } else {
    const diff = currentTotal - previousTotal;
    const rate = computeChangeRate(currentTotal, previousTotal);
    if (diff > 0) {
      points.push(
        `استُقبلت خلال الفترة الحالية ${currentTotal} شكوى، بارتفاع قدره ${diff} شكوى${formatSignedRate(rate)} عن الفترة السابقة.`
      );
    } else if (diff < 0) {
      points.push(
        `استُقبلت خلال الفترة الحالية ${currentTotal} شكوى، بانخفاض قدره ${Math.abs(diff)} شكوى${formatSignedRate(rate)} عن الفترة السابقة.`
      );
    } else {
      points.push(
        `استُقبلت خلال الفترة الحالية ${currentTotal} شكوى، دون تغير عن الفترة السابقة.`
      );
    }
  }

  // Point 2: region with highest positive difference.
  const topRise = regionChanges.find((row) => row.direction === "ارتفاع" || row.direction === "جديد");
  if (topRise && topRise.difference > 0) {
    points.push(
      `سجّلت "${topRise.regionName}" أعلى ارتفاع في عدد الشكاوى بزيادة قدرها ${topRise.difference} شكوى.`
    );
  }

  // Point 3: region with largest decrease.
  const decreases = regionChanges.filter((row) => row.direction === "انخفاض");
  if (decreases.length > 0) {
    const topDrop = decreases.reduce((min, row) => (row.difference < min.difference ? row : min), decreases[0]);
    points.push(
      `سجّلت "${topDrop.regionName}" أكبر انخفاض في عدد الشكاوى بمقدار ${Math.abs(topDrop.difference)} شكوى.`
    );
  }

  // Point 4: dept+classification with highest difference.
  if (deptClassRises.length > 0) {
    const top = deptClassRises[0];
    points.push(
      `شهدت "${top.departmentName}" ارتفاعاً في تصنيف "${top.classificationName}" بمقدار ${top.difference} شكوى.`
    );
  }

  return points.filter((point) => point && point.trim().length > 0).slice(0, 4);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type BuildComparisonOptions = {
  minimumIncreaseCount?: number;
};

/**
 * Computes all period-comparison data with a small fixed number of DB queries
 * (two findMany calls — one per period). No per-region/per-dept queries.
 */
export async function buildComparisonResult(
  filters: ReportFilters,
  now: Date,
  options: BuildComparisonOptions = {}
): Promise<ComparisonResult> {
  const minimumIncreaseCount = options.minimumIncreaseCount ?? DEFAULT_MINIMUM_INCREASE_COUNT;

  // The report's own filters express the current period as inclusive date-only
  // strings [from, to]. Convert to a half-open UTC interval [from, toExclusive)
  // where toExclusive is the start of the day AFTER `to`.
  const currentFrom = new Date(`${filters.from}T00:00:00.000Z`);
  const currentToExclusive = new Date(new Date(`${filters.to}T00:00:00.000Z`).getTime() + DAY_MS);
  const currentPeriod: PeriodRange = { from: currentFrom, toExclusive: currentToExclusive };
  const previousPeriod = derivePreviousPeriodRange(currentPeriod.from, currentPeriod.toExclusive);

  const warnings: ComparisonWarning[] = [];

  const currentWhere = buildPeriodWhere(filters, currentPeriod, now);
  const [current, previous] = await Promise.all([
    db.complaint.findMany({ where: currentWhere, select: comparisonSelect }),
    previousPeriod
      ? db.complaint.findMany({
          where: buildPeriodWhere(filters, previousPeriod, now),
          select: comparisonSelect,
        })
      : Promise.resolve<ComparisonComplaint[]>([]),
  ]);

  if (!previousPeriod) {
    warnings.push({
      code: "NO_COMPARISON_PERIOD",
      message: "تعذّر احتساب فترة مرجعية للمقارنة لهذه الفترة.",
    });
  }

  const trend = buildRegionTrend(current, currentPeriod);
  if (trend.warning) warnings.push(trend.warning);

  const regionChanges = previousPeriod ? buildRegionChanges(current, previous) : buildRegionChanges(current, []);

  const rises = previousPeriod
    ? buildDeptClassRises(current, previous, minimumIncreaseCount)
    : buildDeptClassRises(current, [], minimumIncreaseCount);
  warnings.push(...rises.warnings);

  const executiveSummaryPoints = buildExecutiveSummaryPoints(
    current.length,
    previousPeriod ? previous.length : null,
    regionChanges,
    rises.rows
  );

  return {
    currentPeriod,
    previousPeriod,
    regionTrend: trend.data,
    regionChanges,
    deptClassRises: rises.rows,
    deptClassRisesTotal: rises.total,
    deptClassAllPairs: rises.allPairs,
    executiveSummaryPoints,
    warnings,
  };
}

/** Human-readable message for a comparison warning (for report `warnings`). */
export function comparisonWarningMessage(warning: ComparisonWarning): string {
  return warning.message;
}
