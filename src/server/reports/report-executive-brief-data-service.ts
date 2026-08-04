/**
 * Executive brief data builder.
 *
 * Computes the extended payload required by DIGITAL_EXECUTIVE_BRIEF,
 * PRINT_EXECUTIVE_BRIEF, and FULL_ANALYTICAL report modes. It accepts the
 * already-computed `ComplaintKpiResult` and `ComparisonResult` from the
 * executive summary builder so no extra DB round-trips are needed for those.
 *
 * Additional queries in this service:
 *  - One `groupBy` to obtain the all-time region reference list (Left Join).
 *  - One `findMany` on Complaint for previous-period timeline.
 *  - Two count/groupBy calls for net-backlog-flow (FULL_ANALYTICAL only).
 */

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { COMPLAINT_SLA_DURATION_MS } from "@/server/complaints/complaint-sla-timing";
import type { ComplaintGroupMetrics, ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";
import { buildComplaintWhere, parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import type { DeptClassPeriodCount, ComparisonResult, PeriodRange } from "./report-comparison";
import { buildComplaintQueryParams, type ReportFilters } from "./report-definition-service";
import type {
  ExecutiveBriefData,
  ExecutiveBriefV2Data,
  FullAnalyticalData,
} from "./report-data-service";
import type {
  ExecutiveBriefKpiCard,
  KpiAssessment,
  RegionReferenceRow,
  ClassificationBriefRow,
  ComparativeTimelineData,
  ComparativeTimelinePoint,
  ConcentrationBand,
  MonthlyComplaintTrendPoint,
  NetBacklogFlow,
  PerfVolumeRow,
  ContinuityRow,
  ExecutiveEntityRow,
} from "@/lib/reports/report-contract";
import { normalizeRegionName } from "@/lib/reports/region-normalization";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_CLASSIFICATIONS_LIMIT = 8;

// ---------------------------------------------------------------------------
// Effective-date policy
// ---------------------------------------------------------------------------

/**
 * Builds a Prisma `WhereInput` fragment that applies the canonical date policy:
 * use `complaintDate` when present; fall back to `receivedAt` only when
 * `complaintDate` is null. A complaint is never counted twice.
 */
function buildEffectiveDateWhere(period: PeriodRange): Prisma.ComplaintWhereInput {
  return {
    OR: [
      {
        complaintDate: {
          gte: period.from,
          lt: period.toExclusive,
        },
      },
      {
        complaintDate: null,
        receivedAt: {
          gte: period.from,
          lt: period.toExclusive,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// KPI cards with assessment
// ---------------------------------------------------------------------------

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

function computeChangeRate(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return roundRate(((current - previous) / previous) * 100);
}

type KpiSpec = {
  key: string;
  label: string;
  value: number | null;
  previousValue: number | null;
  format: ExecutiveBriefKpiCard["format"];
  higherIsBetter: boolean | null;
};

function assessKpi(spec: KpiSpec): KpiAssessment {
  if (spec.value === null || spec.previousValue === null || spec.higherIsBetter === null) return "neutral";
  const diff = spec.value - spec.previousValue;
  if (diff === 0) return "neutral";
  const improved = spec.higherIsBetter ? diff > 0 : diff < 0;
  return improved ? "positive" : "negative";
}

function buildBriefKpiCard(spec: KpiSpec): ExecutiveBriefKpiCard {
  const difference =
    spec.value !== null && spec.previousValue !== null ? spec.value - spec.previousValue : null;
  const changeRate =
    spec.value !== null && spec.previousValue !== null
      ? computeChangeRate(spec.value, spec.previousValue)
      : null;
  return {
    key: spec.key,
    label: spec.label,
    value: spec.value,
    previousValue: spec.previousValue,
    difference,
    changeRate,
    format: spec.format,
    assessment: assessKpi(spec),
  };
}

function buildBriefKpis(
  result: ComplaintKpiResult,
  previousResult: ComplaintKpiResult | undefined,
  hasPrevious: boolean
): ExecutiveBriefKpiCard[] {
  const p = hasPrevious;
  const kpis = result.kpis;
  const previousKpis = previousResult?.kpis;
  const perf = result.performance;
  const vol = result.volume;
  const previousAverageEligible = (previousResult?.performance.averageResolutionEligibleCount ?? 0) > 0;
  const previousAverageResolutionDays = p && previousAverageEligible
    ? (previousResult?.performance.averageResolutionDays ?? null)
    : null;
  const previousSlaEligible = (previousResult?.performance.slaEligibleCount ?? 0) > 0;

  const specs: KpiSpec[] = [
    {
      key: "total",
      label: "إجمالي الشكاوى",
      value: vol.total,
      previousValue: p ? (previousKpis?.totalComplaints.currentValue ?? kpis.totalComplaints.previousValue) : null,
      format: "number",
      higherIsBetter: null,
    },
    {
      key: "open",
      label: "المفتوحة",
      value: vol.open,
      previousValue: p ? (previousKpis?.openComplaints.currentValue ?? kpis.openComplaints.previousValue) : null,
      format: "number",
      higherIsBetter: false,
    },
    {
      key: "closed",
      label: "المغلقة حالياً من شكاوى الفترة",
      value: vol.closed,
      previousValue: p ? (previousKpis?.closedComplaints.currentValue ?? kpis.closedComplaints.previousValue) : null,
      format: "number",
      higherIsBetter: true,
    },
    {
      key: "currentlyLate",
      label: "المتأخرة حالياً",
      value: kpis.currentlyLateComplaints.currentValue,
      previousValue: p ? (previousKpis?.currentlyLateComplaints.currentValue ?? kpis.currentlyLateComplaints.previousValue) : null,
      format: "number",
      higherIsBetter: false,
    },
    {
      key: "closedLate",
      label: "المغلقة بعد المهلة",
      value: kpis.closedLateComplaints.currentValue,
      previousValue: p ? (previousKpis?.closedLateComplaints.currentValue ?? kpis.closedLateComplaints.previousValue) : null,
      format: "number",
      higherIsBetter: false,
    },
    {
      key: "complianceRate",
      label: "الالتزام ضمن المهلة",
      value: perf.onTimeRate,
      previousValue: p && previousSlaEligible
        ? (previousResult?.performance.onTimeRate ?? null)
        : null,
      format: "percent",
      higherIsBetter: true,
    },
    {
      key: "averageResolutionDays",
      label: "متوسط الإغلاق",
      value: perf.averageResolutionEligibleCount > 0 ? roundRate(perf.averageResolutionDays ?? 0) : null,
      previousValue: previousAverageResolutionDays !== null ? roundRate(previousAverageResolutionDays) : null,
      format: "days",
      higherIsBetter: false,
    },
    {
      key: "netChange",
      label: "صافي التغير",
      value: p ? (vol.total - (previousResult?.volume.total ?? kpis.totalComplaints.previousValue ?? 0)) : null,
      previousValue: null,
      format: "number",
      higherIsBetter: null,
    },
  ];

  return specs.map(buildBriefKpiCard);
}

// ---------------------------------------------------------------------------
// All-regions reference table (Left Join against all-time region list)
// ---------------------------------------------------------------------------

async function fetchAllTimeRegions(): Promise<string[]> {
  const groups = await db.complaint.groupBy({
    by: ["region"],
    where: { isDeleted: false },
  });
  return groups
    .map((g) => normalizeRegionName(g.region))
    .filter((name, index, values) => values.indexOf(name) === index)
    .sort((a, b) => a.localeCompare(b, "ar"));
}

function directionLabel(current: number, previous: number): string {
  if (current > 0 && previous === 0) return "جديد";
  if (current === 0 && previous === 0) return "دون شكاوى";
  if (current > previous) return "↑ ارتفاع";
  if (current < previous) return "↓ انخفاض";
  return "= دون تغير";
}

function buildAllRegionsTable(
  allTimeRegions: string[],
  comparison: ComparisonResult,
  currentDistributions: ComplaintGroupMetrics[]
): RegionReferenceRow[] {
  const changeMap = new Map(
    comparison.regionChanges.map((row) => [normalizeRegionName(row.regionName), row])
  );
  const metricsMap = new Map(
    currentDistributions.map((g) => [normalizeRegionName(g.name), g])
  );

  return allTimeRegions.map((regionName) => {
    const change = changeMap.get(regionName);
    const metrics = metricsMap.get(regionName);
    const currentCount = change?.currentCount ?? 0;
    const previousCount = change?.previousCount ?? 0;
    const difference = currentCount - previousCount;
    return {
      regionName,
      currentCount,
      previousCount,
      difference,
      changeRate: computeChangeRate(currentCount, previousCount),
      complianceRate: metrics?.complianceRate ?? null,
      averageResolutionDays:
        (metrics?.averageResolutionEligibleCount ?? 0) > 0
          ? roundRate(metrics!.averageResolutionDays)
          : null,
      openCount: metrics?.open ?? 0,
      closedCount: metrics?.closed ?? 0,
      currentlyLate: metrics?.currentlyLate ?? 0,
      direction: directionLabel(currentCount, previousCount),
    };
  });
}

function buildEntityRows(
  groups: ComplaintGroupMetrics[],
  total: number,
  limit = 8
): ExecutiveEntityRow[] {
  return groups.slice(0, limit).map((group) => ({
    name: group.name,
    total: group.total,
    open: group.open,
    closed: group.closed,
    currentlyLate: group.currentlyLate,
    shareOfTotal: total > 0 ? roundRate(group.total / total * 100) : 0,
  }));
}

function hasMeaningfulPreviousData(comparison: ComparisonResult): boolean {
  return (
    comparison.previousPeriod !== null &&
    comparison.previousTotal !== null &&
    comparison.previousTotal > 0
  );
}

function buildConclusions(
  result: ComplaintKpiResult,
  comparison: ComparisonResult
): string[] {
  const points: string[] = [];
  const topRegion = result.distributions.byRegion[0];
  if (topRegion && result.volume.total > 0) {
    points.push(
      `${topRegion.name} الأعلى حجماً بعدد ${topRegion.total} شكوى،` +
      ` وتمثل ${roundRate(topRegion.total / result.volume.total * 100)}% من الإجمالي.`
    );
  }
  // Only generate comparative conclusions when previous data actually exists.
  if (hasMeaningfulPreviousData(comparison)) {
    const rise = comparison.regionChanges.filter((r) => r.difference > 0)
      .sort((a, b) => b.difference - a.difference)[0];
    const fall = comparison.regionChanges.filter((r) => r.difference < 0)
      .sort((a, b) => a.difference - b.difference)[0];
    if (rise) points.push(`أعلى زيادة في ${rise.regionName}: +${rise.difference} شكوى مقارنة بالفترة السابقة.`);
    if (fall) points.push(`أعلى انخفاض في ${fall.regionName}: ${Math.abs(fall.difference)} شكوى مقارنة بالفترة السابقة.`);
  }
  const openDepartment = [...result.distributions.byDepartment].sort((a, b) => b.open - a.open)[0];
  if (openDepartment?.open) {
    points.push(`${openDepartment.name} الأعلى في الحالات المفتوحة بعدد ${openDepartment.open}.`);
  }
  const lateClassification = [...result.distributions.byClassification]
    .sort((a, b) => b.currentlyLate - a.currentlyLate)[0];
  if (lateClassification?.currentlyLate) {
    points.push(`${lateClassification.name} الأعلى في الحالات المتأخرة بعدد ${lateClassification.currentlyLate}.`);
  }
  return points.slice(0, 5);
}

function buildNotes(result: ComplaintKpiResult, comparison: ComparisonResult): string[] {
  const notes: string[] = [];

  // 1. Fixed SLA policy — always present as context for all compliance figures.
  notes.push("المهلة المعتمدة: 7 أيام من تاريخ إنشاء الشكوى.");

  // 2. Closed without a trusted closure date — explains null average/compliance.
  const closedWithoutTrustedDate = result.performance.closedWithoutTrustedDateCount;
  if (closedWithoutTrustedDate > 0) {
    notes.push(
      `${closedWithoutTrustedDate} شكوى مغلقة بلا تاريخ إغلاق موثوق، ولم تدخل في متوسط مدة الإغلاق أو قياس الالتزام الزمني.`
    );
  } else if (result.performance.onTimeRate === null) {
    notes.push("لا تتوفر بيانات زمنية كافية لقياس الالتزام.");
  }

  // 3. Unclassified complaints (unchanged).
  if (result.kpis.unclassifiedComplaints.currentValue > 0) {
    notes.push(
      `${result.kpis.unclassifiedComplaints.currentValue} شكوى بلا تصنيف، ما يحد من دقة تحليل الأسباب.`
    );
  }

  // 4. Comparison quality.
  if (!comparison.previousPeriod) {
    notes.push("لا تتوفر فترة سابقة صالحة للمقارنة الزمنية.");
  } else if (!hasMeaningfulPreviousData(comparison)) {
    notes.push(
      "بيانات الفترة السابقة صفرية — قد يكون سبب ذلك غياب تاريخ الشكوى أو استيراد البيانات بتاريخ موحد."
    );
  }

  return notes.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Top classifications
// ---------------------------------------------------------------------------

function buildTopClassifications(
  currentDistributions: ComplaintGroupMetrics[],
  previousDistributions: ComplaintGroupMetrics[],
  currentTotal: number,
  limit: number = TOP_CLASSIFICATIONS_LIMIT
): ClassificationBriefRow[] {
  const prevMap = new Map(
    previousDistributions.map((g) => [g.id ?? g.name, g.total])
  );

  return currentDistributions.slice(0, limit).map((group) => {
    const currentCount = group.total;
    const previousCount = prevMap.get(group.id ?? group.name) ?? 0;
    const difference = currentCount - previousCount;
    return {
      classificationId: group.id ?? group.name,
      classificationName: group.name,
      currentCount,
      previousCount,
      difference,
      changeRate: computeChangeRate(currentCount, previousCount),
      shareOfTotal: currentTotal > 0 ? roundRate((currentCount / currentTotal) * 100) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Monthly timeline buckets (UTC calendar months)
// ---------------------------------------------------------------------------

export const ARABIC_MONTH_NAMES: readonly string[] = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

export const MONTHLY_WINDOW_SIZE = 13;

/** One bucket in a monthly window. */
export type MonthlyTrendPoint = {
  monthKey: string;
  monthLabel: string;
  currentCount: number;
  previousCount: number | null;
};

export type MonthBucket = { key: string; label: string; from: Date; toExclusive: Date };

function utcMonthBucket(year: number, monthIndex: number): MonthBucket {
  const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  return {
    key,
    label: `${ARABIC_MONTH_NAMES[monthIndex]} ${year}`,
    from: new Date(Date.UTC(year, monthIndex, 1)),
    toExclusive: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date: Date, delta: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}

/**
 * Legacy forward-looking window used by the comparative current/previous timeline.
 * Starts at the month of `period.from` and walks exactly 13 months forward.
 * Prefer {@link computeMonthlyHistoryWindow} for V2 historical trend charts.
 */
export function computeThirteenMonthWindow(period: PeriodRange): MonthBucket[] {
  const startYear = period.from.getUTCFullYear();
  const startMonthIdx = period.from.getUTCMonth();
  const buckets: MonthBucket[] = [];
  for (let i = 0; i < MONTHLY_WINDOW_SIZE; i++) {
    const totalMonths = startMonthIdx + i;
    const year = startYear + Math.floor(totalMonths / 12);
    const month = totalMonths % 12;
    buckets.push(utcMonthBucket(year, month));
  }
  return buckets;
}

/**
 * Backward-looking monthly history window for the V2 executive brief chart.
 *
 * Rules (UTC):
 * 1. reportEndMonth = first day of the month containing reportEnd
 *    (callers pass currentPeriod.toExclusive − 1 ms, or any inclusive end instant).
 * 2. earliestAllowedMonth = reportEndMonth − (maxMonths − 1) months (default 12 → 13 months max).
 * 3. actualStartMonth = later of (earliest available data month, earliestAllowedMonth).
 * 4. Months inclusive from actualStartMonth through reportEndMonth.
 * 5. Count is always between 1 and maxMonths (default 13).
 * 6. Never creates a month after reportEndMonth.
 */
export function computeMonthlyHistoryWindow(options: {
  reportEnd: Date;
  earliestAvailableDate: Date | null;
  maxMonths?: number;
}): MonthBucket[] {
  const maxMonths = options.maxMonths ?? MONTHLY_WINDOW_SIZE;
  if (maxMonths < 1) return [];

  const reportEndMonth = startOfUtcMonth(options.reportEnd);
  const earliestAllowedMonth = addUtcMonths(reportEndMonth, -(maxMonths - 1));

  let actualStartMonth = earliestAllowedMonth;
  if (options.earliestAvailableDate) {
    const dataMonth = startOfUtcMonth(options.earliestAvailableDate);
    if (dataMonth.getTime() > actualStartMonth.getTime()) {
      actualStartMonth = dataMonth;
    }
  }
  // Never start after the report end month (empty data set collapses to report month).
  if (actualStartMonth.getTime() > reportEndMonth.getTime()) {
    actualStartMonth = reportEndMonth;
  }

  const buckets: MonthBucket[] = [];
  let cursor = actualStartMonth;
  while (cursor.getTime() <= reportEndMonth.getTime() && buckets.length < maxMonths) {
    buckets.push(utcMonthBucket(cursor.getUTCFullYear(), cursor.getUTCMonth()));
    cursor = addUtcMonths(cursor, 1);
  }
  return buckets;
}

/** Counts complaints (by effective date) that fall in each month bucket.
 *  Buckets not covered by any complaint stay at 0. */
export function groupComplaintsByMonth(
  complaints: Array<{ complaintDate: Date | null; receivedAt: Date }>,
  buckets: readonly MonthBucket[]
): Map<string, number> {
  const result = new Map<string, number>();
  for (const b of buckets) result.set(b.key, 0);
  for (const c of complaints) {
    const date = c.complaintDate ?? c.receivedAt;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    const prev = result.get(key);
    if (prev !== undefined) result.set(key, prev + 1);
  }
  return result;
}

async function fetchComplaintsForTimeline(
  period: PeriodRange,
  filters: ReportFilters,
  now: Date
): Promise<Array<{ complaintDate: Date | null; receivedAt: Date }>> {
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const baseWhere = buildComplaintWhere(query, now);
  const where: Prisma.ComplaintWhereInput = {
    ...baseWhere,
    isDeleted: false,
    ...buildEffectiveDateWhere(period),
  };
  return db.complaint.findMany({ where, select: { complaintDate: true, receivedAt: true } });
}

async function buildComparativeTimeline(
  comparison: ComparisonResult,
  filters: ReportFilters,
  now: Date
): Promise<ComparativeTimelineData> {
  const { currentPeriod, previousPeriod } = comparison;
  const periodDays = Math.round(
    (currentPeriod.toExclusive.getTime() - currentPeriod.from.getTime()) / DAY_MS
  );

  // Always use the 13-month calendar window for consistency.
  const currentBuckets = computeThirteenMonthWindow(currentPeriod);

  const currentComplaints = await fetchComplaintsForTimeline(currentPeriod, filters, now);
  const currentCounts = groupComplaintsByMonth(currentComplaints, currentBuckets);

  const currentPoints: ComparativeTimelinePoint[] = currentBuckets.map((b, i) => ({
    relativeDay: i + 1,
    count: currentCounts.get(b.key) ?? 0,
    label: b.label,
  }));

  if (!previousPeriod) {
    return {
      current: { label: "الفترة الحالية", points: currentPoints },
      previous: null,
      periodDays,
      aggregation: "monthly",
    };
  }

  const previousBuckets = computeThirteenMonthWindow(previousPeriod);
  const previousComplaints = await fetchComplaintsForTimeline(previousPeriod, filters, now);
  const previousCounts = groupComplaintsByMonth(previousComplaints, previousBuckets);

  // Previous points use the SAME labels as current (aligned by index) so that
  // the bar chart renders both series as side-by-side columns per month.
  const previousPoints: ComparativeTimelinePoint[] = currentBuckets.map((currentB, i) => ({
    relativeDay: i + 1,
    count: previousCounts.get(previousBuckets[i]?.key ?? "") ?? 0,
    label: currentB.label,
  }));

  const prevFrom = previousPeriod.from.toISOString().slice(0, 10);
  const prevTo = new Date(previousPeriod.toExclusive.getTime() - DAY_MS).toISOString().slice(0, 10);

  return {
    current: { label: "الفترة الحالية", points: currentPoints },
    previous: { label: `الفترة السابقة (${prevFrom} → ${prevTo})`, points: previousPoints },
    periodDays,
    aggregation: "monthly",
  };
}

// ---------------------------------------------------------------------------
// Concentration bands
// ---------------------------------------------------------------------------

function computeConcentration(
  groups: ComplaintGroupMetrics[],
  entityType: ConcentrationBand["entityType"],
  totalComplaints: number
): ConcentrationBand {
  if (totalComplaints === 0) {
    return { entityType, top1SharePercent: 0, top3SharePercent: 0, top5SharePercent: 0, totalEntities: 0 };
  }
  const sorted = [...groups].sort((a, b) => b.total - a.total);
  const sumTop = (n: number) =>
    roundRate((sorted.slice(0, n).reduce((s, g) => s + g.total, 0) / totalComplaints) * 100);
  return {
    entityType,
    top1SharePercent: sumTop(1),
    top3SharePercent: sumTop(3),
    top5SharePercent: sumTop(5),
    totalEntities: groups.length,
  };
}

// ---------------------------------------------------------------------------
// Net backlog flow (FULL_ANALYTICAL only)
// ---------------------------------------------------------------------------

/**
 * inflow  = complaints whose effective date (complaintDate ?? receivedAt)
 *           falls in the current period, matching all report filters.
 * outflow = distinct complaints closed/resolved in the current period,
 *           scoped to complaints matching all non-date report filters.
 *
 * Outflow policy: a complaint that was closed multiple times within the period
 * is counted once (groupBy deduplication).
 */
async function buildNetBacklogFlow(
  filters: ReportFilters,
  now: Date,
  currentPeriod: PeriodRange
): Promise<NetBacklogFlow> {
  const periodDays = Math.round(
    (currentPeriod.toExclusive.getTime() - currentPeriod.from.getTime()) / DAY_MS
  );

  // Build non-date complaint filters.
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const baseWhere = buildComplaintWhere(query, now);

  // Inflow: apply effective-date OR policy to current period.
  const inflowWhere: Prisma.ComplaintWhereInput = {
    ...baseWhere,
    isDeleted: false,
    ...buildEffectiveDateWhere(currentPeriod),
  };
  const inflow = await db.complaint.count({ where: inflowWhere });

  // Non-date filters for outflow complaint scope (no date on complaint itself;
  // the date axis here is changedAt on the status transition).
  const nonDateComplaintFilters: Prisma.ComplaintWhereInput = {
    ...baseWhere,
    isDeleted: false,
  };

  // Outflow: deduplicated by complaint via groupBy.
  const outflowGroups = await db.complaintStatusHistory.groupBy({
    by: ["complaintId"],
    where: {
      toStatus: { in: ["CLOSED", "RESOLVED"] },
      changedAt: {
        gte: currentPeriod.from,
        lt: currentPeriod.toExclusive,
      },
      complaint: {
        is: nonDateComplaintFilters,
      },
    },
  });
  const outflow = outflowGroups.length;

  return { inflow, outflow, net: inflow - outflow, periodDays };
}

// ---------------------------------------------------------------------------
// Performance vs volume
// ---------------------------------------------------------------------------

function buildPerfVolumeRows(
  distributions: ComplaintGroupMetrics[],
  totalComplaints: number
): PerfVolumeRow[] {
  const rows = distributions.map((group) => ({
    entityName: group.name,
    totalComplaints: group.total,
    complianceRate: group.complianceRate,
    averageResolutionDays:
      group.averageResolutionEligibleCount > 0 ? roundRate(group.averageResolutionDays) : null,
    currentlyLate: group.currentlyLate,
    share: totalComplaints > 0 ? roundRate((group.total / totalComplaints) * 100) : 0,
  }));
  return rows.sort((a, b) => b.totalComplaints - a.totalComplaints);
}

// ---------------------------------------------------------------------------
// Continuity analysis (re-occurrence of dept+classification pairs)
// ---------------------------------------------------------------------------

function buildContinuityRows(allPairs: DeptClassPeriodCount[]): ContinuityRow[] {
  const rows: ContinuityRow[] = [];

  for (const pair of allPairs) {
    if (pair.currentCount === 0 && pair.previousCount === 0) continue;

    let recurrenceType: ContinuityRow["recurrenceType"];
    if (pair.currentCount > 0 && pair.previousCount > 0) {
      recurrenceType = "persistent";
    } else if (pair.currentCount > 0) {
      recurrenceType = "new";
    } else {
      recurrenceType = "resolved";
    }

    rows.push({
      departmentName: pair.departmentName,
      classificationName: pair.classificationName,
      currentCount: pair.currentCount,
      previousCount: pair.previousCount,
      appearsInBothPeriods: recurrenceType === "persistent",
      recurrenceType,
    });
  }

  return rows.sort(
    (a, b) =>
      Number(b.appearsInBothPeriods) - Number(a.appearsInBothPeriods) ||
      b.currentCount - a.currentCount
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildExecutiveBriefData(
  filters: ReportFilters,
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  previousResult?: ComplaintKpiResult,
  now: Date = new Date()
): Promise<ExecutiveBriefData> {
  const hasPrevious = comparison.previousPeriod !== null;

  const [allTimeRegions, comparativeTimeline] = await Promise.all([
    fetchAllTimeRegions(),
    buildComparativeTimeline(comparison, filters, now),
  ]);

  const briefKpis = buildBriefKpis(result, previousResult, hasPrevious);

  const allRegions = buildAllRegionsTable(
    allTimeRegions,
    comparison,
    result.distributions.byRegion
  );

  const topClassifications = buildTopClassifications(
    result.distributions.byClassification,
    previousResult?.distributions.byClassification ?? [],
    result.volume.total
  );

  const concentrationBands: ConcentrationBand[] = [
    computeConcentration(result.distributions.byRegion, "region", result.volume.total),
    computeConcentration(result.distributions.byClassification, "classification", result.volume.total),
    computeConcentration(result.distributions.byDepartment, "department", result.volume.total),
  ];

  return {
    briefKpis,
    allRegions,
    topClassifications,
    comparativeTimeline,
    concentrationBands,
    topDepartments: buildEntityRows(result.distributions.byDepartment, result.volume.total),
    conclusions: buildConclusions(result, comparison),
    notes: buildNotes(result, comparison),
  };
}

export async function buildFullAnalyticalData(
  filters: ReportFilters,
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  previousResult?: ComplaintKpiResult,
  now: Date = new Date()
): Promise<FullAnalyticalData> {
  const [briefData, netBacklogFlow] = await Promise.all([
    buildExecutiveBriefData(filters, result, comparison, previousResult, now),
    buildNetBacklogFlow(filters, now, comparison.currentPeriod),
  ]);

  const perfVolumeRows = buildPerfVolumeRows(
    result.distributions.byDepartment,
    result.volume.total
  );

  let continuityRows: ContinuityRow[] = [];
  if (comparison.previousPeriod) {
    continuityRows = buildContinuityRows(comparison.deptClassAllPairs);
  }

  return {
    ...briefData,
    netBacklogFlow,
    perfVolumeRows,
    continuityRows,
  };
}

// ---------------------------------------------------------------------------
// V2: monthly complaint trend (backward-looking, single-axis series)
// ---------------------------------------------------------------------------

type TrendComplaint = {
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date | null;
};

function isValidTrendDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function resolveTrendCreatedAt(complaint: Pick<TrendComplaint, "complaintDate" | "receivedAt">): Date | null {
  if (isValidTrendDate(complaint.complaintDate)) return complaint.complaintDate;
  return isValidTrendDate(complaint.receivedAt) ? complaint.receivedAt : null;
}

/**
 * Trusted closure timestamp for month assignment.
 * Status alone is never enough — closedAt must be present and not before creation.
 */
export function resolveTrustedClosedAt(
  complaint: Pick<TrendComplaint, "complaintDate" | "receivedAt" | "closedAt">
): Date | null {
  const createdAt = resolveTrendCreatedAt(complaint);
  if (!createdAt || !isValidTrendDate(complaint.closedAt)) return null;
  if (complaint.closedAt.getTime() < createdAt.getTime()) return null;
  return complaint.closedAt;
}

function nonDateComplaintWhere(filters: ReportFilters, now: Date): Prisma.ComplaintWhereInput {
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  return {
    ...buildComplaintWhere(query, now),
    isDeleted: false,
  };
}

/**
 * Aggregates four monthly series for the V2 chart over a pre-built history window.
 * Exportable pure function for unit tests.
 */
export function aggregateMonthlyComplaintTrend(
  complaints: readonly TrendComplaint[],
  buckets: readonly MonthBucket[]
): MonthlyComplaintTrendPoint[] {
  return buckets.map((bucket) => {
    const startMs = bucket.from.getTime();
    const endMs = bucket.toExclusive.getTime(); // exclusive month end (= next month 00:00 UTC)
    let receivedCount = 0;
    let closedDuringMonthCount = 0;
    let openAtMonthEndCount = 0;
    let lateAtMonthEndCount = 0;

    for (const c of complaints) {
      const createdAt = resolveTrendCreatedAt(c);
      if (!createdAt) continue;
      const createdMs = createdAt.getTime();
      const trustedClosedAt = resolveTrustedClosedAt(c);

      // receivedCount: actual creation date inside the month
      if (createdMs >= startMs && createdMs < endMs) {
        receivedCount++;
      }

      // closedDuringMonthCount: trusted closedAt inside the month
      if (trustedClosedAt) {
        const closedMs = trustedClosedAt.getTime();
        if (closedMs >= startMs && closedMs < endMs) {
          closedDuringMonthCount++;
        }
      }

      // openAtMonthEnd: created on or before month end, not closed at or before month end
      if (createdMs >= endMs) continue;
      const closedByMonthEnd = trustedClosedAt !== null && trustedClosedAt.getTime() < endMs;
      if (closedByMonthEnd) continue;

      openAtMonthEndCount++;
      // late when monthEnd > createdAt + 7 days (exact 7-day boundary is not late)
      const deadlineMs = createdMs + COMPLAINT_SLA_DURATION_MS;
      if (endMs > deadlineMs) {
        lateAtMonthEndCount++;
      }
    }

    return {
      monthKey: bucket.key,
      monthLabel: bucket.label,
      receivedCount,
      closedDuringMonthCount,
      openAtMonthEndCount,
      lateAtMonthEndCount,
    };
  });
}

async function fetchEarliestAvailableComplaintDate(
  filters: ReportFilters,
  now: Date,
  reportToExclusive: Date
): Promise<Date | null> {
  const baseWhere = nonDateComplaintWhere(filters, now);
  // Bound lookback for performance: never consider complaints created after report end.
  const where: Prisma.ComplaintWhereInput = {
    ...baseWhere,
    OR: [
      { complaintDate: { lt: reportToExclusive } },
      { complaintDate: null, receivedAt: { lt: reportToExclusive } },
    ],
  };

  // Two ordered probes cover COALESCE(complaintDate, receivedAt) without loading all rows.
  const [byComplaintDate, byReceivedAt] = await Promise.all([
    db.complaint.findFirst({
      where: { ...where, complaintDate: { not: null, lt: reportToExclusive } },
      orderBy: { complaintDate: "asc" },
      select: { complaintDate: true, receivedAt: true },
    }),
    db.complaint.findFirst({
      where: { ...where, complaintDate: null, receivedAt: { lt: reportToExclusive } },
      orderBy: { receivedAt: "asc" },
      select: { complaintDate: true, receivedAt: true },
    }),
  ]);

  const candidates = [byComplaintDate, byReceivedAt]
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .map((row) => resolveTrendCreatedAt(row))
    .filter((d): d is Date => d !== null);

  if (candidates.length === 0) return null;
  return candidates.reduce((min, d) => (d.getTime() < min.getTime() ? d : min));
}

async function buildMonthlyStockFlow(
  filters: ReportFilters,
  comparison: ComparisonResult,
  now: Date
): Promise<MonthlyComplaintTrendPoint[]> {
  const reportToExclusive = comparison.currentPeriod.toExclusive;
  // Inclusive report end instant used to identify reportEndMonth.
  const reportEnd = new Date(reportToExclusive.getTime() - 1);

  const earliestAvailableDate = await fetchEarliestAvailableComplaintDate(
    filters,
    now,
    reportToExclusive
  );

  const buckets = computeMonthlyHistoryWindow({
    reportEnd,
    earliestAvailableDate,
    maxMonths: MONTHLY_WINDOW_SIZE,
  });
  if (buckets.length === 0) return [];

  // toExclusive of last month = first day of the month after report end month
  const windowToExclusive = buckets[buckets.length - 1].toExclusive;

  const baseWhere = nonDateComplaintWhere(filters, now);

  // Trend is NOT limited by filters.from: inject the history window manually.
  // Include every complaint created before windowToExclusive so month-end stock
  // reconstructs correctly even for issues opened before the first chart month.
  const complaints = await db.complaint.findMany({
    where: {
      ...baseWhere,
      OR: [
        { complaintDate: { lt: windowToExclusive } },
        { complaintDate: null, receivedAt: { lt: windowToExclusive } },
      ],
    },
    select: { complaintDate: true, receivedAt: true, closedAt: true },
  });

  // Defensive: never count anything with creation after the report window end,
  // even if the DB bound was widened unexpectedly.
  const bounded = complaints.filter((c) => {
    const created = resolveTrendCreatedAt(c);
    return created !== null && created.getTime() < windowToExclusive.getTime();
  });

  return aggregateMonthlyComplaintTrend(bounded, buckets);
}

// ---------------------------------------------------------------------------
// V2: all-time complaint count (no date filter)
// ---------------------------------------------------------------------------

async function fetchAllTimeTotal(
  filters: ReportFilters,
  now: Date
): Promise<number> {
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const baseWhere = buildComplaintWhere(query, now);
  return db.complaint.count({ where: { ...baseWhere, isDeleted: false } });
}

// ---------------------------------------------------------------------------
// V2: open/late counts per classification at current period end
// ---------------------------------------------------------------------------

async function fetchClassificationOpenLate(
  filters: ReportFilters,
  comparison: ComparisonResult,
  now: Date
): Promise<Record<string, { openAtEnd: number; lateAtEnd: number }>> {
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const baseWhere = buildComplaintWhere(query, now);

  const periodEndMs = comparison.currentPeriod.toExclusive.getTime();

  const complaints = await db.complaint.findMany({
    where: { ...baseWhere, isDeleted: false },
    select: {
      classificationId: true,
      complaintDate: true,
      receivedAt: true,
      closedAt: true,
    },
  });

  const result: Record<string, { openAtEnd: number; lateAtEnd: number }> = {};

  for (const c of complaints) {
    const effectiveMs = (c.complaintDate ?? c.receivedAt).getTime();
    if (effectiveMs >= periodEndMs) continue;

    const closedBeforeEnd = c.closedAt && c.closedAt.getTime() < periodEndMs;
    if (closedBeforeEnd) continue;

    const key = c.classificationId ?? "__unclassified__";
    if (!result[key]) result[key] = { openAtEnd: 0, lateAtEnd: 0 };
    result[key].openAtEnd++;
    const slaDeadlineMs = effectiveMs + COMPLAINT_SLA_DURATION_MS;
    if (slaDeadlineMs < periodEndMs) result[key].lateAtEnd++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// V2 public API
// ---------------------------------------------------------------------------

export async function buildExecutiveBriefV2Data(
  filters: ReportFilters,
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  previousResult?: ComplaintKpiResult,
  now: Date = new Date()
): Promise<ExecutiveBriefV2Data> {
  const [briefData, allTimeTotal, monthlyStockFlow, classificationOpenLate] = await Promise.all([
    buildExecutiveBriefData(filters, result, comparison, previousResult, now),
    fetchAllTimeTotal(filters, now),
    buildMonthlyStockFlow(filters, comparison, now),
    fetchClassificationOpenLate(filters, comparison, now),
  ]);

  return { ...briefData, allTimeTotal, monthlyStockFlow, classificationOpenLate };
}
