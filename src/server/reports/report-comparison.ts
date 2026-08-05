import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildComplaintWhere, parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import { buildComplaintQueryParams, type ReportFilters } from "./report-definition-service";
import {
  assertRegionalReconciliation,
  displayRegionName,
  normalizeRegionName,
  type RegionalReconciliationInput,
} from "@/lib/reports/region-normalization";
import { buildClassificationPath } from "@/lib/reports/classification-keys";
import { comparisonHalfOpenPeriod } from "@/lib/reports/period-range";
import type { ComparisonMode } from "@/lib/reports/report-contract";

// ---------------------------------------------------------------------------
// Centralized period-comparison module.
//
// This is the SINGLE source of truth for period comparison used by the
// executive summary report (PDF + XLSX). `derivePreviousPeriodRange` lives
// here and nowhere else so the "same duration, immediately-before, no overlap"
// rule cannot drift between services.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const UNSPECIFIED_SUBJECT = "غير محدد";
export const DEPT_CLASS_RISES_LIMIT = 20;
export const DEFAULT_MINIMUM_INCREASE_COUNT = 1;

export type PeriodRange = { from: Date; toExclusive: Date };

/**
 * Derives the previous period range that is:
 * - exactly the same duration as the current period, and
 * - immediately before it (no gap, no overlap): previous.toExclusive === from.
 * The current period is [from, toExclusive) using half-open intervals.
 * Returns null when the range is invalid (duration <= 0).
 */
export function derivePreviousPeriodRange(
  from: Date,
  toExclusive: Date,
  mode: ComparisonMode = "PREVIOUS_EQUIVALENT_PERIOD"
): PeriodRange | null {
  return comparisonHalfOpenPeriod(from, toExclusive, mode);
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

export type RegionSubjectChangeRow = {
  regionName: string;
  subject: string;
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
  | { code: "MISSING_CLASSIFICATION"; count: number; message: string }
  | {
      code: "REGIONAL_RECONCILIATION_DRIFT";
      message: string;
      currentTotal: number;
      previousTotal: number | null;
    };

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
  /** Total complaints in the current period from raw DB query count. */
  currentTotal: number;
  /**
   * Total complaints in the previous period from raw DB query count.
   * null = no previous period was queried.
   * 0   = a valid previous period was queried and returned zero complaints.
   */
  previousTotal: number | null;
  regionTrend: RegionTrendData;
  regionChanges: RegionChangeRow[];
  /** Strongest subject increase/decrease per region. Optional for old fixtures. */
  regionSubjectChanges?: RegionSubjectChangeRow[];
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
  subject: true,
  department: true,
  classificationId: true,
  categoryId: true,
  classification: { select: { id: true, nameAr: true, categoryId: true } },
  category: { select: { id: true, nameAr: true } },
} satisfies Prisma.ComplaintSelect;

type ComparisonComplaint = Prisma.ComplaintGetPayload<{ select: typeof comparisonSelect }>;

/**
 * Builds the non-date where clause for a period. We deliberately reuse
 * complaint-query-service's `buildComplaintWhere` so the SAME non-date filters
 * (region/department/classification/priority/status/...) are applied to both
 * periods — the comparison must be apples-to-apples. The date window is then
 * combined with a half-open [from, toExclusive) effective-date range. A row
 * uses complaintDate when present and receivedAt only when complaintDate is
 * null, matching the shared report/KPI date policy.
 */
function buildPeriodWhere(filters: ReportFilters, period: PeriodRange, now: Date): Prisma.ComplaintWhereInput {
  const params = buildComplaintQueryParams(filters);
  // Strip the report's own date window; we apply the exact period window below.
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const where = buildComplaintWhere(query, now);
  const { complaintDate: _ignoredDate, ...nonDateWhere } = where;
  return {
    AND: [
      nonDateWhere,
      {
        OR: [
          { complaintDate: { gte: period.from, lt: period.toExclusive } },
          {
            complaintDate: null,
            receivedAt: { gte: period.from, lt: period.toExclusive },
          },
        ],
      },
    ],
  };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function complaintDay(complaint: ComparisonComplaint): string {
  return dayKey(complaint.complaintDate ?? complaint.receivedAt);
}

function regionCanonicalKey(complaint: ComparisonComplaint): string {
  return normalizeRegionName(complaint.region);
}

function subjectName(complaint: ComparisonComplaint): string {
  return complaint.subject?.trim() || UNSPECIFIED_SUBJECT;
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

  const totalsByDay = new Map<string, number>();
  for (const complaint of current) {
    const day = complaintDay(complaint);
    totalsByDay.set(day, (totalsByDay.get(day) ?? 0) + 1);
  }

  return {
    data: {
      allDates,
      series: [{
        regionName: "إجمالي الشكاوى",
        points: allDates.map((date) => ({ date, count: totalsByDay.get(date) ?? 0 })),
      }],
      truncated: false,
      otherSeriesName: null,
    },
    warning: null,
  };
}

// ---------------------------------------------------------------------------
// Region change rows
// ---------------------------------------------------------------------------

function countByRegion(complaints: ComparisonComplaint[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const complaint of complaints) {
    const key = regionCanonicalKey(complaint);
    map.set(key, (map.get(key) ?? 0) + 1);
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

/** Captures reconciliation drift as a warning in production; throws when strict. */
export function validateRegionalReconciliation(
  input: RegionalReconciliationInput,
  warnings: ComparisonWarning[],
  strict: boolean
): void {
  try {
    assertRegionalReconciliation(input);
  } catch (error) {
    if (strict) throw error;
    warnings.push({
      code: "REGIONAL_RECONCILIATION_DRIFT",
      message:
        "تعذر التحقق من تطابق مجموع المناطق مع إجمالي الفترة؛ تم إنشاء التقرير مع تحذير للمراجعة.",
      currentTotal: input.currentTotal,
      previousTotal: input.previousTotal,
    });
  }
}

function buildRegionChanges(
  current: ComparisonComplaint[],
  previous: ComparisonComplaint[],
  warnings: ComparisonWarning[],
  strictRegionalReconciliation: boolean
): RegionChangeRow[] {
  const currentCounts = countByRegion(current);
  const previousCounts = countByRegion(previous);
  const regionKeys = new Set<string>([...currentCounts.keys(), ...previousCounts.keys()]);

  const rows: RegionChangeRow[] = [];
  for (const key of regionKeys) {
    const currentCount = currentCounts.get(key) ?? 0;
    const previousCount = previousCounts.get(key) ?? 0;
    const difference = currentCount - previousCount;
    rows.push({
      regionName: displayRegionName(key),
      currentCount,
      previousCount,
      difference,
      changeRate: computeChangeRate(currentCount, previousCount),
      direction: resolveDirection(currentCount, previousCount),
    });
  }

  rows.sort(compareRegionChangeRows);

  const currentReconciliationRows = Array.from(
    currentCounts.values(),
    (currentCount) => ({ currentCount })
  );
  const previousReconciliationRows = Array.from(
    previousCounts.values(),
    (previousCount) => ({ previousCount })
  );

  validateRegionalReconciliation(
    {
      currentRows: currentReconciliationRows,
      previousRows: previousReconciliationRows,
      currentTotal: current.length,
      previousTotal: previous.length,
    },
    warnings,
    strictRegionalReconciliation
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Strongest subject change per region
// ---------------------------------------------------------------------------

type RegionSubjectAccumulator = {
  regionName: string;
  subject: string;
  currentCount: number;
  previousCount: number;
};

function regionSubjectKey(region: string, subject: string): string {
  return `${region}\u0000${subject}`;
}

function accumulateRegionSubjects(
  map: Map<string, RegionSubjectAccumulator>,
  complaints: ComparisonComplaint[],
  field: "currentCount" | "previousCount"
): void {
  for (const complaint of complaints) {
    const region = displayRegionName(regionCanonicalKey(complaint));
    const subject = subjectName(complaint);
    const key = regionSubjectKey(region, subject);
    const existing = map.get(key) ?? {
      regionName: region,
      subject,
      currentCount: 0,
      previousCount: 0,
    };
    existing[field] += 1;
    map.set(key, existing);
  }
}

function compareSubjectChangeMagnitude(
  candidate: RegionSubjectChangeRow,
  current: RegionSubjectChangeRow
): number {
  const absoluteDifference = Math.abs(candidate.difference) - Math.abs(current.difference);
  if (absoluteDifference !== 0) return absoluteDifference;

  const candidateVolume = candidate.currentCount + candidate.previousCount;
  const currentVolume = current.currentCount + current.previousCount;
  if (candidateVolume !== currentVolume) return candidateVolume - currentVolume;

  return -candidate.subject.localeCompare(current.subject, "ar");
}

function buildRegionSubjectChanges(
  current: ComparisonComplaint[],
  previous: ComparisonComplaint[]
): RegionSubjectChangeRow[] {
  const accumulators = new Map<string, RegionSubjectAccumulator>();
  accumulateRegionSubjects(accumulators, current, "currentCount");
  accumulateRegionSubjects(accumulators, previous, "previousCount");

  const strongestByRegion = new Map<string, RegionSubjectChangeRow>();
  for (const accumulator of accumulators.values()) {
    const difference = accumulator.currentCount - accumulator.previousCount;
    if (difference === 0) continue;

    const candidate: RegionSubjectChangeRow = {
      regionName: accumulator.regionName,
      subject: accumulator.subject,
      currentCount: accumulator.currentCount,
      previousCount: accumulator.previousCount,
      difference,
      changeRate: computeChangeRate(accumulator.currentCount, accumulator.previousCount),
      direction: resolveDirection(accumulator.currentCount, accumulator.previousCount),
    };
    const existing = strongestByRegion.get(candidate.regionName);
    if (!existing || compareSubjectChangeMagnitude(candidate, existing) > 0) {
      strongestByRegion.set(candidate.regionName, candidate);
    }
  }

  return [...strongestByRegion.values()].sort((a, b) =>
    a.regionName.localeCompare(b.regionName, "ar")
  );
}

// ---------------------------------------------------------------------------
// Department + classification rises
// ---------------------------------------------------------------------------

type DeptClassAccumulator = {
  departmentId: string;
  departmentName: string;
  classificationId: string;
  classificationName: string;
  classificationPath: string;
  currentCount: number;
  previousCount: number;
};

function deptClassKey(departmentId: string, classificationId: string): string {
  return `${departmentId}\u0000${classificationId}`;
}

/** True when a complaint has both a usable department and classification id. */
function hasValidDeptAndClass(complaint: ComparisonComplaint): boolean {
  return Boolean(complaint.department) && Boolean(complaint.classificationId);
}

function classificationPathForComplaint(complaint: ComparisonComplaint): string {
  return buildClassificationPath(
    complaint.category?.nameAr,
    complaint.classification?.nameAr
  );
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
    const path = classificationPathForComplaint(complaint);
    const leaf = complaint.classification?.nameAr ?? classificationId;
    const existing =
      map.get(key) ??
      ({
        departmentId,
        departmentName: departmentId,
        classificationId,
        classificationName: leaf,
        classificationPath: path,
        currentCount: 0,
        previousCount: 0,
      } satisfies DeptClassAccumulator);
    if (complaint.classification?.nameAr) {
      existing.classificationName = complaint.classification.nameAr;
      existing.classificationPath = path;
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
    classificationName: acc.classificationPath,
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
      classificationName: row.classificationPath,
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
  comparisonMode?: ComparisonMode;
  includeComparison?: boolean;
  /** When true, regional reconciliation drift throws. Defaults to NODE_ENV === "test". */
  strictRegionalReconciliation?: boolean;
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
  const comparisonMode = options.comparisonMode ?? "PREVIOUS_EQUIVALENT_PERIOD";
  const strictRegionalReconciliation =
    options.strictRegionalReconciliation ?? process.env.NODE_ENV === "test";

  // The report's own filters express the current period as inclusive date-only
  // strings [from, to]. Convert to a half-open UTC interval [from, toExclusive)
  // where toExclusive is the start of the day AFTER `to`.
  const currentFrom = new Date(`${filters.from}T00:00:00.000Z`);
  const currentToExclusive = new Date(new Date(`${filters.to}T00:00:00.000Z`).getTime() + DAY_MS);
  const currentPeriod: PeriodRange = { from: currentFrom, toExclusive: currentToExclusive };
  const previousPeriod = options.includeComparison === false
    ? null
    : derivePreviousPeriodRange(currentPeriod.from, currentPeriod.toExclusive, comparisonMode);

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

  const regionChanges = previousPeriod
    ? buildRegionChanges(current, previous, warnings, strictRegionalReconciliation)
    : buildRegionChanges(current, [], warnings, strictRegionalReconciliation);
  const regionSubjectChanges = previousPeriod ? buildRegionSubjectChanges(current, previous) : [];

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
    currentTotal: current.length,
    previousTotal: previousPeriod ? previous.length : null,
    regionTrend: trend.data,
    regionChanges,
    regionSubjectChanges,
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