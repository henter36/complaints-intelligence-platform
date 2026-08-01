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
 *  - One `findMany` on ComplaintStatusHistory for net-backlog-flow (FULL_ANALYTICAL only).
 */

import { db } from "@/lib/db";
import type { ComplaintGroupMetrics, ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";
import type { ComparisonResult, PeriodRange } from "./report-comparison";
import type { ReportFilters } from "./report-definition-service";
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
} from "@/lib/reports/report-contract";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_CLASSIFICATIONS_LIMIT = 8;
const MATRIX_MAX_ROWS = 10;
const MATRIX_MAX_COLS = 8;

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
  value: number;
  previousValue: number | null;
  format: ExecutiveBriefKpiCard["format"];
  higherIsBetter: boolean | null; // null = neutral regardless of direction
};

function assessKpi(spec: KpiSpec): KpiAssessment {
  if (spec.previousValue === null || spec.higherIsBetter === null) return "neutral";
  const diff = spec.value - spec.previousValue;
  if (diff === 0) return "neutral";
  const improved = spec.higherIsBetter ? diff > 0 : diff < 0;
  return improved ? "positive" : "negative";
}

function buildBriefKpiCard(spec: KpiSpec): ExecutiveBriefKpiCard {
  const difference =
    spec.previousValue !== null ? spec.value - spec.previousValue : null;
  const changeRate =
    spec.previousValue !== null
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
  hasPrevious: boolean
): ExecutiveBriefKpiCard[] {
  const p = hasPrevious;
  const kpis = result.kpis;
  const perf = result.performance;
  const vol = result.volume;

  const specs: KpiSpec[] = [
    {
      key: "total",
      label: "إجمالي الشكاوى",
      value: vol.total,
      previousValue: p ? (kpis.totalComplaints.previousValue ?? null) : null,
      format: "number",
      higherIsBetter: null,
    },
    {
      key: "open",
      label: "المفتوحة",
      value: vol.open,
      previousValue: p ? (kpis.openComplaints.previousValue ?? null) : null,
      format: "number",
      higherIsBetter: false,
    },
    {
      key: "closed",
      label: "المغلقة",
      value: vol.closed,
      previousValue: p ? (kpis.closedComplaints.previousValue ?? null) : null,
      format: "number",
      higherIsBetter: true,
    },
    {
      key: "currentlyLate",
      label: "المتأخرة حالياً",
      value: kpis.currentlyLateComplaints.currentValue,
      previousValue: p ? (kpis.currentlyLateComplaints.previousValue ?? null) : null,
      format: "number",
      higherIsBetter: false,
    },
    {
      key: "complianceRate",
      label: "نسبة الالتزام%",
      value: roundRate(perf.onTimeRate),
      previousValue: p ? (kpis.dueDateComplianceRate.previousValue ?? null) : null,
      format: "percent",
      higherIsBetter: true,
    },
    {
      key: "averageResolutionDays",
      label: "متوسط زمن الإغلاق (يوم)",
      value: roundRate(perf.averageResolutionDays),
      previousValue: p ? (kpis.averageResolutionDays.previousValue ?? null) : null,
      format: "days",
      higherIsBetter: false,
    },
    {
      key: "highPriorityOpen",
      label: "عالية الأولوية المفتوحة",
      value: kpis.highPriorityOpenComplaints.currentValue,
      previousValue: p ? (kpis.highPriorityOpenComplaints.previousValue ?? null) : null,
      format: "number",
      higherIsBetter: false,
    },
    {
      key: "unclassified",
      label: "غير المصنفة",
      value: kpis.unclassifiedComplaints.currentValue,
      previousValue: p ? (kpis.unclassifiedComplaints.previousValue ?? null) : null,
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
    .map((g) => g.region ?? UNSPECIFIED_REGION)
    .filter((name, index, arr) => arr.indexOf(name) === index)
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
  // Map from regionName → comparison row (has current/previous counts)
  const changeMap = new Map(
    comparison.regionChanges.map((row) => [row.regionName, row])
  );

  // Map from regionName → current-period metrics (for compliance/resolution)
  const metricsMap = new Map(
    currentDistributions.map((g) => [g.name, g])
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
      currentlyLate: metrics?.currentlyLate ?? 0,
      direction: directionLabel(currentCount, previousCount),
    };
  });
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
      categoryName: "",
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

async function buildComparativeTimeline(
  comparison: ComparisonResult,
  filters: ReportFilters
): Promise<ComparativeTimelineData> {
  const { currentPeriod, previousPeriod } = comparison;
  const periodDays = Math.round(
    (currentPeriod.toExclusive.getTime() - currentPeriod.from.getTime()) / DAY_MS
  );

  // Current period: sum across all series in the existing trend data.
  const currentDailyTotals = sumDailyCounts(comparison.regionTrend);
  const currentPoints = buildDailyPointsForPeriod(currentPeriod, currentDailyTotals);

  if (!previousPeriod) {
    return {
      current: { label: "الفترة الحالية", points: currentPoints },
      previous: null,
      periodDays,
    };
  }

  // Previous period: need per-day counts. Query the DB.
  const { buildComplaintQueryParams } = await import("./report-definition-service");
  const { buildComplaintWhere, parseComplaintQuery } = await import("@/server/complaints/complaint-query-service");

  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const where = buildComplaintWhere(query, new Date());
  where.complaintDate = { gte: previousPeriod.from, lt: previousPeriod.toExclusive };
  where.isDeleted = false;

  const prevComplaints = await db.complaint.findMany({
    where,
    select: { complaintDate: true, receivedAt: true },
  });

  const prevDailyTotals = new Map<string, number>();
  for (const complaint of prevComplaints) {
    const date = (complaint.complaintDate ?? complaint.receivedAt).toISOString().slice(0, 10);
    prevDailyTotals.set(date, (prevDailyTotals.get(date) ?? 0) + 1);
  }

  const previousPoints = buildDailyPointsForPeriod(previousPeriod, prevDailyTotals);

  const prevFrom = previousPeriod.from.toISOString().slice(0, 10);
  const prevTo = new Date(previousPeriod.toExclusive.getTime() - DAY_MS)
    .toISOString()
    .slice(0, 10);

  return {
    current: { label: "الفترة الحالية", points: currentPoints },
    previous: { label: `الفترة السابقة (${prevFrom} → ${prevTo})`, points: previousPoints },
    periodDays,
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

async function buildNetBacklogFlow(
  currentPeriod: PeriodRange
): Promise<NetBacklogFlow> {
  const periodDays = Math.round(
    (currentPeriod.toExclusive.getTime() - currentPeriod.from.getTime()) / DAY_MS
  );

  // Inflow: complaints with complaintDate (or receivedAt) in the current period.
  const inflow = await db.complaint.count({
    where: {
      isDeleted: false,
      OR: [
        {
          complaintDate: {
            gte: currentPeriod.from,
            lt: currentPeriod.toExclusive,
          },
        },
      ],
    },
  });

  // Outflow: status transitions to CLOSED or RESOLVED within the period.
  const outflow = await db.complaintStatusHistory.count({
    where: {
      toStatus: { in: ["CLOSED", "RESOLVED"] },
      changedAt: {
        gte: currentPeriod.from,
        lt: currentPeriod.toExclusive,
      },
    },
  });

  return { inflow, outflow, net: inflow - outflow, periodDays };
}

// ---------------------------------------------------------------------------
// Performance vs volume
// ---------------------------------------------------------------------------

function buildPerfVolumeRows(
  distributions: ComplaintGroupMetrics[],
  totalComplaints: number
): PerfVolumeRow[] {
  return distributions.map((group) => ({
    entityName: group.name,
    totalComplaints: group.total,
    complianceRate: group.complianceRate,
    averageResolutionDays:
      group.averageResolutionDays > 0 ? roundRate(group.averageResolutionDays) : null,
    currentlyLate: group.currentlyLate,
    share: totalComplaints > 0 ? roundRate((group.total / totalComplaints) * 100) : 0,
  }));
}

// ---------------------------------------------------------------------------
// Continuity analysis (re-occurrence of dept+classification pairs)
// ---------------------------------------------------------------------------

function buildContinuityRows(
  current: ComparisonResult["deptClassRises"],
  comparison: ComparisonResult
): ContinuityRow[] {
  // Build sets of dept+class keys for current and previous periods.
  type DeptClassKey = string;
  const currentKeys = new Map<DeptClassKey, { dept: string; class: string; currentCount: number }>();
  const previousKeys = new Map<DeptClassKey, number>();

  for (const rise of comparison.deptClassRises) {
    const key = `${rise.departmentId}||${rise.classificationId}`;
    currentKeys.set(key, {
      dept: rise.departmentName,
      class: rise.classificationName,
      currentCount: rise.currentCount,
    });
    previousKeys.set(key, rise.previousCount);
  }

  const rows: ContinuityRow[] = [];
  for (const [key, cur] of currentKeys) {
    const previousCount = previousKeys.get(key) ?? 0;
    const appearsInBoth = previousCount > 0 && cur.currentCount > 0;
    let recurrenceType: ContinuityRow["recurrenceType"];
    if (appearsInBoth) recurrenceType = "persistent";
    else if (cur.currentCount > 0 && previousCount === 0) recurrenceType = "new";
    else recurrenceType = "absent";

    rows.push({
      departmentName: cur.dept,
      classificationName: cur.class,
      currentCount: cur.currentCount,
      previousCount,
      appearsInBothPeriods: appearsInBoth,
      recurrenceType,
    });
  }

  return rows.sort((a, b) =>
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
  previousResult?: ComplaintKpiResult
): Promise<ExecutiveBriefData> {
  const hasPrevious = comparison.previousPeriod !== null;

  const [allTimeRegions, comparativeTimeline] = await Promise.all([
    fetchAllTimeRegions(),
    buildComparativeTimeline(comparison, filters),
  ]);

  const briefKpis = buildBriefKpis(result, hasPrevious);

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
  };
}

export async function buildFullAnalyticalData(
  filters: ReportFilters,
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  previousResult?: ComplaintKpiResult
): Promise<FullAnalyticalData> {
  const [briefData, netBacklogFlow] = await Promise.all([
    buildExecutiveBriefData(filters, result, comparison, previousResult),
    buildNetBacklogFlow(comparison.currentPeriod),
  ]);

  const perfVolumeRows = buildPerfVolumeRows(
    result.distributions.byDepartment,
    result.volume.total
  );

  const continuityRows = buildContinuityRows(comparison.deptClassRises, comparison);

  return {
    ...briefData,
    netBacklogFlow,
    perfVolumeRows,
    continuityRows,
  };
}
