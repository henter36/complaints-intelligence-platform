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
import type { ComplaintGroupMetrics, ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";
import { buildComplaintWhere, parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import type { DeptClassPeriodCount, ComparisonResult, PeriodRange } from "./report-comparison";
import { buildComplaintQueryParams, type ReportFilters } from "./report-definition-service";
import type {
  ExecutiveBriefData,
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
      label: "المغلقة",
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
      previousValue: p && previousKpis?.dueDateComplianceRate.available !== false
        ? (previousKpis?.dueDateComplianceRate.currentValue ?? kpis.dueDateComplianceRate.previousValue)
        : null,
      format: "percent",
      higherIsBetter: true,
    },
    {
      key: "averageResolutionDays",
      label: "متوسط الإغلاق",
      value: vol.closed > 0 ? roundRate(perf.averageResolutionDays) : null,
      previousValue: p && (previousResult ? previousResult.volume.closed > 0 : true)
        ? (previousKpis?.averageResolutionDays.currentValue ?? kpis.averageResolutionDays.previousValue)
        : null,
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

const UNSPECIFIED_REGION = "غير محدد";

async function fetchAllTimeRegions(): Promise<string[]> {
  const groups = await db.complaint.groupBy({
    by: ["region"],
    where: { isDeleted: false },
  });
  return groups
    .map((g) => normalizeRegionName(g.region ?? UNSPECIFIED_REGION))
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
        metrics?.averageResolutionDays != null && metrics.averageResolutionDays > 0
          ? roundRate(metrics.averageResolutionDays)
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

function buildConclusions(
  result: ComplaintKpiResult,
  comparison: ComparisonResult
): string[] {
  const points: string[] = [];
  const topRegion = result.distributions.byRegion[0];
  if (topRegion && result.volume.total > 0) {
    points.push(`${topRegion.name} الأعلى حجماً بعدد ${topRegion.total}، وتمثل ${roundRate(topRegion.total / result.volume.total * 100)}% من الإجمالي.`);
  }
  if (comparison.previousPeriod) {
    const rise = comparison.regionChanges.filter((row) => row.difference > 0)
      .sort((a, b) => b.difference - a.difference)[0];
    const fall = comparison.regionChanges.filter((row) => row.difference < 0)
      .sort((a, b) => a.difference - b.difference)[0];
    if (rise) points.push(`أعلى زيادة مطلقة في ${rise.regionName}: ${rise.difference} شكوى.`);
    if (fall) points.push(`أعلى انخفاض مطلق في ${fall.regionName}: ${Math.abs(fall.difference)} شكوى.`);
  }
  const openDepartment = [...result.distributions.byDepartment].sort((a, b) => b.open - a.open)[0];
  if (openDepartment?.open) points.push(`${openDepartment.name} الأعلى في الحالات المفتوحة بعدد ${openDepartment.open}.`);
  return points.slice(0, 4);
}

function buildNotes(result: ComplaintKpiResult, comparison: ComparisonResult): string[] {
  const notes: string[] = [];
  if (result.kpis.unclassifiedComplaints.currentValue > 0) {
    notes.push(`${result.kpis.unclassifiedComplaints.currentValue} شكوى بلا تصنيف، ما يحد من دقة تحليل الأسباب.`);
  }
  if (result.kpis.withoutDueDate.currentValue > 0) {
    notes.push(`${result.kpis.withoutDueDate.currentValue} شكوى بلا موعد مستهدف ولا تدخل في مقام الالتزام.`);
  }
  if (!comparison.previousPeriod) notes.push("لا تتوفر فترة سابقة صالحة للمقارنة الزمنية.");
  return notes.slice(0, 3);
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
// Comparative timeline (current vs previous, relative-day axis)
// ---------------------------------------------------------------------------

function sumDailyCounts(
  trend: ComparisonResult["regionTrend"]
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const series of trend.series) {
    for (const point of series.points) {
      totals.set(point.date, (totals.get(point.date) ?? 0) + point.count);
    }
  }
  return totals;
}

function buildDailyPointsForPeriod(
  period: PeriodRange,
  dailyTotals: Map<string, number>
): ComparativeTimelinePoint[] {
  const points: ComparativeTimelinePoint[] = [];
  const startMs = Date.UTC(
    period.from.getUTCFullYear(),
    period.from.getUTCMonth(),
    period.from.getUTCDate()
  );
  let relativeDay = 1;
  for (let ms = startMs; ms < period.toExclusive.getTime(); ms += DAY_MS, relativeDay++) {
    const dateStr = new Date(ms).toISOString().slice(0, 10);
    points.push({ relativeDay, count: dailyTotals.get(dateStr) ?? 0 });
  }
  return points;
}

function resolveTimelineAggregation(periodDays: number): {
  aggregation: "daily" | "weekly" | "monthly";
} {
  if (periodDays <= 31) return { aggregation: "daily" };
  if (periodDays <= 120) return { aggregation: "weekly" };
  return { aggregation: "monthly" };
}

function aggregateTimelinePoints(
  points: readonly ComparativeTimelinePoint[],
  aggregation: "daily" | "weekly" | "monthly",
  periodStart: Date
): ComparativeTimelinePoint[] {
  if (aggregation === "daily") return [...points];
  if (aggregation === "monthly") {
    const monthly = new Map<string, ComparativeTimelinePoint>();
    for (const point of points) {
      const date = new Date(periodStart.getTime() + (point.relativeDay - 1) * DAY_MS);
      const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const bucket = monthly.get(monthKey);
      if (bucket) bucket.count += point.count;
      else monthly.set(monthKey, { relativeDay: point.relativeDay, count: point.count });
    }
    return [...monthly.values()];
  }
  const aggregated: ComparativeTimelinePoint[] = [];
  for (let index = 0; index < points.length; index += 7) {
    aggregated.push({
      relativeDay: index + 1,
      count: points.slice(index, index + 7).reduce((sum, point) => sum + point.count, 0),
    });
  }
  return aggregated;
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
  const { aggregation } = resolveTimelineAggregation(periodDays);

  // Current period: sum across all series in the existing trend data.
  const currentDailyTotals = sumDailyCounts(comparison.regionTrend);
  const currentPoints = aggregateTimelinePoints(
    buildDailyPointsForPeriod(currentPeriod, currentDailyTotals),
    aggregation,
    currentPeriod.from
  );

  if (!previousPeriod) {
    return {
      current: { label: "الفترة الحالية", points: currentPoints },
      previous: null,
      periodDays,
      aggregation,
    };
  }

  // Previous period: query the DB with the same non-date filters as current.
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const baseWhere = buildComplaintWhere(query, now);

  // Merge effective-date policy for the previous period.
  const prevWhere: Prisma.ComplaintWhereInput = {
    ...baseWhere,
    isDeleted: false,
    ...buildEffectiveDateWhere(previousPeriod),
  };

  const prevComplaints = await db.complaint.findMany({
    where: prevWhere,
    select: { complaintDate: true, receivedAt: true },
  });

  const prevDailyTotals = new Map<string, number>();
  for (const complaint of prevComplaints) {
    const date = (complaint.complaintDate ?? complaint.receivedAt).toISOString().slice(0, 10);
    prevDailyTotals.set(date, (prevDailyTotals.get(date) ?? 0) + 1);
  }

  const previousPoints = aggregateTimelinePoints(
    buildDailyPointsForPeriod(previousPeriod, prevDailyTotals),
    aggregation,
    previousPeriod.from
  );

  const prevFrom = previousPeriod.from.toISOString().slice(0, 10);
  const prevTo = new Date(previousPeriod.toExclusive.getTime() - DAY_MS)
    .toISOString()
    .slice(0, 10);

  return {
    current: { label: "الفترة الحالية", points: currentPoints },
    previous: { label: `الفترة السابقة (${prevFrom} → ${prevTo})`, points: previousPoints },
    periodDays,
    aggregation,
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
      group.averageResolutionDays > 0 ? roundRate(group.averageResolutionDays) : null,
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
