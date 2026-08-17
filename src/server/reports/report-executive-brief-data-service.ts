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

import type { ComplaintGroupMetrics, ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";
import { COMPLAINT_SLA_DURATION_MS, resolveComplaintEffectiveClosedAt } from "@/server/complaints/complaint-sla-timing";
import type { ComplaintSlaSnapshot } from "@/server/complaints/complaint-sla-timing";
import { ComplaintStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildComplaintWhere, parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import { comparisonWarningMessage } from "./report-comparison";
import type { DeptClassPeriodCount, ComparisonResult, PeriodRange, RegionChangeRow } from "./report-comparison";
import { buildComplaintQueryParams, type ReportFilters } from "./report-definition-service";
import { loadPatternAnalysisForFilters } from "@/server/analytics/pattern/pattern-report-integration-service";
import { buildPatternAnalysisBriefConclusions } from "@/lib/analytics/finding-brief-conclusions";
import { rankFindingsForExecutiveBrief } from "@/lib/analytics/finding-ranking";
import { PATTERN_ANALYSIS_CONFIG } from "@/lib/analytics/pattern-analysis-config";
import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";
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
  ExecutivePeriodMetrics,
  RegionSnapshotAtEndRow,
  DepartmentPeriodMetricsRow,
  ClassificationSnapshotAtEndRow,
  ClassificationTrendRow,
  FacilityFollowUpRow,
  FacilityImprovementRow,
} from "@/lib/reports/report-contract";
import {
  buildClassificationPath,
  classificationKey,
  UNCLASSIFIED_CLASSIFICATION_KEY,
  UNCLASSIFIED_CLASSIFICATION_LABEL,
} from "@/lib/reports/classification-keys";
import {
  displayRegionName,
  normalizeRegionName,
} from "@/lib/reports/region-normalization";
import {
  buildExecutiveReportSnapshotData,
  resolveComplaintClosureInstants,
  UNSPECIFIED_GROUP_LABEL,
  type ComplaintStatusHistoryEntry,
  type ExecutiveReportSnapshotData,
  type ReportPeriodGroupSnapshot,
} from "./report-period-snapshot-service";
import {
  buildHistoricalFacilityClosureEventWhere,
  buildHistoricalOperationalFacilityWhere,
  combineComplaintWhere,
  isFacilityEligibleAt,
  isFacilityEventEligible,
  loadFacilityOperationalRegistry,
  type FacilityOperationalRegistry,
} from "@/server/facilities/facility-operational-scope-service";

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
  hasPrevious: boolean,
  periodMetrics: ExecutivePeriodMetrics
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
      label: "المفتوحة نهاية الفترة",
      value: periodMetrics.current.openAtEnd,
      previousValue: p ? (periodMetrics.previous?.openAtEnd ?? null) : null,
      format: "number",
      higherIsBetter: false,
    },
    {
      key: "closed",
      label: "المغلقة خلال الفترة",
      value: periodMetrics.current.closedDuringPeriod,
      previousValue: p ? (periodMetrics.previous?.closedDuringPeriod ?? null) : null,
      format: "number",
      higherIsBetter: true,
    },
    {
      key: "currentlyLate",
      label: "المتأخرة نهاية الفترة",
      value: periodMetrics.current.lateAtEnd,
      previousValue: p ? (periodMetrics.previous?.lateAtEnd ?? null) : null,
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
  const keys = [
    ...new Set(groups.map((g) => normalizeRegionName(g.region))),
  ];
  return keys
    .map((key) => displayRegionName(key))
    .sort((a, b) => a.localeCompare(b, "ar"));
}

function directionLabel(current: number, previous: number): string {
  if (current > 0 && previous === 0) return "جديد";
  if (current === 0 && previous === 0) return "دون شكاوى";
  if (current > previous) return "↑ ارتفاع";
  if (current < previous) return "↓ انخفاض";
  return "= دون تغير";
}

/**
 * Merge region-change rows by canonical key so alias variants never create
 * duplicate buckets or double-count the same complaints.
 */
function accumulateCanonicalRegionChanges(
  rows: ComparisonResult["regionChanges"]
): Map<string, { currentCount: number; previousCount: number }> {
  const map = new Map<string, { currentCount: number; previousCount: number }>();
  for (const row of rows) {
    const key = normalizeRegionName(row.regionName);
    const existing = map.get(key) ?? { currentCount: 0, previousCount: 0 };
    existing.currentCount += row.currentCount;
    existing.previousCount += row.previousCount;
    map.set(key, existing);
  }
  return map;
}

function buildAllRegionsTable(
  allTimeRegions: string[],
  comparison: ComparisonResult,
  currentDistributions: ComplaintGroupMetrics[],
  regionSnapshot: Record<string, ReportPeriodGroupSnapshot>
): RegionReferenceRow[] {
  const changeMap = accumulateCanonicalRegionChanges(comparison.regionChanges);
  const metricsMap = new Map(
    currentDistributions.map((g) => [normalizeRegionName(g.name), g])
  );

  const regionKeys = new Set<string>([
    ...allTimeRegions.map((name) => normalizeRegionName(name)),
    ...changeMap.keys(),
    ...Object.keys(regionSnapshot),
  ]);

  const rows: RegionReferenceRow[] = [...regionKeys]
    .map((key) => {
      const change = changeMap.get(key);
      const metrics = metricsMap.get(key);
      // openCount/currentlyLate are stock-at-period-end (include prior-period
      // backlog); currentCount/previousCount/difference/changeRate stay
      // Inflow-based (complaints registered within each period) — do not merge.
      const snapshot = regionSnapshot[key];
      const currentCount = change?.currentCount ?? 0;
      const previousCount = change?.previousCount ?? 0;
      const difference = currentCount - previousCount;
      return {
        regionName: displayRegionName(key),
        currentCount,
        previousCount,
        difference,
        changeRate: computeChangeRate(currentCount, previousCount),
        complianceRate: metrics?.complianceRate ?? null,
        averageResolutionDays:
          (metrics?.averageResolutionEligibleCount ?? 0) > 0
            ? roundRate(metrics!.averageResolutionDays)
            : null,
        openCount: snapshot?.openAtEnd ?? 0,
        closedCount: metrics?.closed ?? 0,
        currentlyLate: snapshot?.lateAtEnd ?? 0,
        direction: directionLabel(currentCount, previousCount),
      };
    })
    .sort((a, b) => a.regionName.localeCompare(b.regionName, "ar"));

  return rows;
}

/**
 * `total`/`closed`/`open`/`currentlyLate` here mean, respectively:
 * receivedDuringPeriod, closedDuringPeriod, openAtEnd (includes prior-period
 * backlog), lateAtEnd — sourced from the department period snapshot, not from
 * current-status distributions.
 */
/** An entity (department, facility, ...) with only prior-period backlog (zero registrations this period) still has activity. */
function hasEntityActivity(snapshot: ReportPeriodGroupSnapshot): boolean {
  return (
    snapshot.receivedDuringPeriod > 0
    || snapshot.closedDuringPeriod > 0
    || snapshot.openAtEnd > 0
    || snapshot.lateAtEnd > 0
  );
}

function compareExecutiveEntityRows(left: ExecutiveEntityRow, right: ExecutiveEntityRow): number {
  return (
    right.total - left.total
    || right.open - left.open
    || right.currentlyLate - left.currentlyLate
    || right.closed - left.closed
    || left.name.localeCompare(right.name, "ar")
  );
}

/**
 * Builds candidates directly from the period snapshot (not from
 * result.distributions, which only contains entities with inflow this
 * period) so a backlog-only department — zero registrations but open
 * complaints carried over from before the period — is never dropped.
 */
function buildEntityRows(
  totalReceivedDuringPeriod: number,
  groupSnapshot: Record<string, ReportPeriodGroupSnapshot>,
  limit = 8
): ExecutiveEntityRow[] {
  return Object.entries(groupSnapshot)
    .filter(([, snapshot]) => hasEntityActivity(snapshot))
    .map(([name, snapshot]) => ({
      name,
      total: snapshot.receivedDuringPeriod,
      open: snapshot.openAtEnd,
      closed: snapshot.closedDuringPeriod,
      currentlyLate: snapshot.lateAtEnd,
      shareOfTotal:
        totalReceivedDuringPeriod > 0
          ? roundRate((snapshot.receivedDuringPeriod / totalReceivedDuringPeriod) * 100)
          : 0,
    }))
    .sort(compareExecutiveEntityRows)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// V2: pattern-analysis-driven facility and classification sections
// (page 4 "السجون الأكثر حاجة للمتابعة" / "أفضل السجون تحسناً" /
// "أبرز اتجاهات التصنيفات عبر الفترات"). Every row here is built directly
// from the shared pattern-analysis engine's own AnalyticalFinding[] — no
// trend/chronic/repeat/concentration/priority logic is recomputed here.
// ---------------------------------------------------------------------------

const FACILITY_ROWS_LIMIT = 5;
const CLASSIFICATION_TRENDS_LIMIT = 5;
const TREND_TRAIL_MAX_PERIODS = 5;

function isUnspecifiedOrEmptyFacilityName(name: string): boolean {
  return name === UNSPECIFIED_GROUP_LABEL || name.trim() === "";
}

const TREND_PATTERN_LABELS: Record<string, ClassificationTrendRow["patternLabel"]> = {
  CONTINUED_RISE: "استمرار مرتفع",
  NO_MEANINGFUL_IMPROVEMENT: "استمرار مرتفع",
  ESCALATING: "تصاعد مستمر",
  SUSTAINED_IMPROVEMENT: "تحسن مستدام",
  RELAPSE_AFTER_IMPROVEMENT: "عودة للارتفاع بعد تحسن",
  EMERGING: "مشكلة ناشئة",
  VOLATILE: "متذبذب",
};

function classificationTrendPatternLabel(pattern: unknown): ClassificationTrendRow["patternLabel"] {
  if (typeof pattern === "string" && pattern in TREND_PATTERN_LABELS) return TREND_PATTERN_LABELS[pattern];
  return "نمط ملحوظ";
}

/** `finding.entityName` is always "facility — classification" for CLASSIFICATION-scoped findings; this recovers just the classification half. */
function classificationLabelFromEntityName(entityName: string): string {
  const separatorIndex = entityName.indexOf(" — ");
  return separatorIndex === -1 ? entityName : entityName.slice(separatorIndex + 3);
}

function facilityOfFinding(finding: AnalyticalFinding): string | null {
  const value = finding.drilldownFilters.facility;
  return typeof value === "string" && !isUnspecifiedOrEmptyFacilityName(value) ? value : null;
}

function parsePeriodCountsMetric(finding: AnalyticalFinding): number[] {
  const raw = finding.supportingMetrics.periodCounts;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "number") ? parsed : [];
  } catch {
    return [];
  }
}

function formatPeriodTrail(counts: readonly number[]): string {
  return counts.slice(-TREND_TRAIL_MAX_PERIODS).join("، ");
}

/**
 * "أبرز المشكلات المستمرة حسب السجن والتصنيف" (spec §1-4): the top facility×
 * classification trends by priorityScore — chronic issues, escalation,
 * relapse, emerging problems, volatility, and sustained improvement all in
 * one ranked list, each with its own trailing-period trail and its OWN real
 * streak length (which can exceed how many trail values are shown).
 */
export function buildClassificationTrendRows(
  findings: readonly AnalyticalFinding[],
  limit: number = CLASSIFICATION_TRENDS_LIMIT
): ClassificationTrendRow[] {
  const relevant = findings.filter(
    (f) =>
      f.entityType === "CLASSIFICATION"
      && (f.type === "CHRONIC_ISSUE" || f.type === "TREND_PATTERN" || f.type === "SUSTAINED_IMPROVEMENT")
  );
  return rankFindingsForExecutiveBrief(relevant)
    .slice(0, limit)
    .map((finding) => ({
      facility: facilityOfFinding(finding) ?? "—",
      classification: classificationLabelFromEntityName(finding.entityName),
      currentCount: finding.currentValue,
      difference: finding.difference ?? 0,
      trail: formatPeriodTrail(parsePeriodCountsMetric(finding)),
      streakPeriods: typeof finding.supportingMetrics.streakPeriods === "number" ? finding.supportingMetrics.streakPeriods : 0,
      patternLabel: classificationTrendPatternLabel(finding.supportingMetrics.pattern),
      priorityScore: finding.priorityScore,
    }));
}

function priorityBandLabel(score: number): FacilityFollowUpRow["priorityBand"] {
  const { high, medium } = PATTERN_ANALYSIS_CONFIG.priorityBandThresholds;
  if (score >= high) return "مرتفعة";
  if (score >= medium) return "متوسطة";
  return "منخفضة";
}

/**
 * "المشكلات المستمرة" cover-page count (spec §6): findings that represent a
 * continuing or escalating problem — CONTINUED_RISE / ESCALATING trend
 * findings, plus high-priority chronic issues — never a raw finding count
 * that would also sweep in improvements or low-signal trend findings.
 */
function computeContinuedProblemFindingCount(findings: readonly AnalyticalFinding[]): number {
  const { high } = PATTERN_ANALYSIS_CONFIG.priorityBandThresholds;
  return findings.filter((f) => {
    if (f.type === "CHRONIC_ISSUE") return f.priorityScore >= high;
    if (f.type === "TREND_PATTERN") {
      const pattern = f.supportingMetrics.pattern;
      return pattern === "CONTINUED_RISE" || pattern === "ESCALATING";
    }
    return false;
  }).length;
}

/**
 * Tie-breakers for follow-up ranking (spec §11), applied only once
 * priorityScore itself is equal: 1. priorityScore (caller sorts this first
 * implicitly since it's the primary key), 2. a real chronic issue outranks a
 * non-chronic one, 3. longer streak, 4. more distinct complainants involved,
 * 5. larger current-period volume, 6. facility name for a deterministic
 * final order. Never falls back to raw volume alone.
 */
function compareFacilityFollowUpRows(a: FacilityFollowUpRow, b: FacilityFollowUpRow): number {
  return (
    b.priorityScore - a.priorityScore
    || Number(b.isChronic) - Number(a.isChronic)
    || (b.streakPeriods ?? -1) - (a.streakPeriods ?? -1)
    || b.distinctComplainantsForRanking - a.distinctComplainantsForRanking
    || b.totalComplaints - a.totalComplaints
    || a.facility.localeCompare(b.facility, "ar")
  );
}

/**
 * "السجون الأكثر حاجة للمتابعة" (spec §1/§3/§10/§11): facilities ranked by
 * the highest priorityScore among ALL their findings (classification-level
 * chronic/trend issues, plus facility-level repeat/mass-complaint/multi-issue
 * signals) — never by raw period volume alone. `totalComplaints` is sourced
 * from `facilityCurrentPeriodTotals` — the SAME aggregation that produced
 * every finding here — so it can never show 0 while a current-period-bound
 * finding (chronic issue, trend, mass complaint) is driving the row. A
 * facility whose real current-period total is 0 is only kept when a genuine
 * chronic/relapse finding (whose evidence can legitimately span periods
 * before the current one) justifies it, and is flagged `isHistoricalOnly` so
 * the renderer can say so explicitly instead of showing a bare, misleading 0.
 * Repeat complainant vs. mass/collective complaint are surfaced as real
 * numbers (spec §10) but never with a person's identifier.
 */
export function buildFacilitiesNeedingFollowUp(
  findings: readonly AnalyticalFinding[],
  facilityCurrentPeriodTotals: Record<string, number>,
  limit: number = FACILITY_ROWS_LIMIT
): FacilityFollowUpRow[] {
  const byFacilityFindings = new Map<string, AnalyticalFinding[]>();
  for (const finding of findings) {
    const facility = facilityOfFinding(finding);
    if (!facility) continue;
    const list = byFacilityFindings.get(facility) ?? [];
    list.push(finding);
    byFacilityFindings.set(facility, list);
  }

  const rows: FacilityFollowUpRow[] = [];
  for (const [facility, facilityFindings] of byFacilityFindings) {
    const classificationFindings = facilityFindings.filter(
      (f) => f.entityType === "CLASSIFICATION" && f.type !== "SUSTAINED_IMPROVEMENT"
    );
    const topIssue = rankFindingsForExecutiveBrief(classificationFindings)[0] as AnalyticalFinding | undefined;
    const priorityScore = Math.max(...facilityFindings.map((f) => f.priorityScore));

    const repeatFinding = facilityFindings.find((f) => f.type === "REPEAT_COMPLAINANT");
    const massFindings = facilityFindings.filter((f) => f.type === "MASS_COMPLAINT");
    const massFinding = massFindings.length > 0
      ? massFindings.reduce((best, f) => (f.currentValue > best.currentValue ? f : best))
      : undefined;

    const repeatComplainants =
      typeof repeatFinding?.supportingMetrics.repeatComplainantCount === "number"
        ? repeatFinding.supportingMetrics.repeatComplainantCount
        : null;
    const repeatComplaints = repeatFinding ? repeatFinding.currentValue : null;
    const spreadComplainants =
      typeof massFinding?.supportingMetrics.distinctComplainants === "number"
        ? massFinding.supportingMetrics.distinctComplainants
        : null;
    const spreadComplaints = massFinding ? massFinding.currentValue : null;

    const hasChronicIssue = classificationFindings.some((f) => f.type === "CHRONIC_ISSUE");
    const hasRelapse = classificationFindings.some(
      (f) => f.type === "TREND_PATTERN" && f.supportingMetrics.pattern === "RELAPSE_AFTER_IMPROVEMENT"
    );

    const totalComplaints = facilityCurrentPeriodTotals[facility] ?? 0;
    const isHistoricalOnly = totalComplaints === 0;

    // §1: zero real current-period activity is only worth showing when a
    // genuinely historical/chronic signal justifies it — never on the
    // strength of a repeat/mass-complaint finding alone (those are always
    // current-period-bound once sourced from the same aggregation above, so
    // a real one can no longer coincide with a 0 total).
    if (isHistoricalOnly && !hasChronicIssue && !hasRelapse) continue;

    const topIssueDistinct =
      topIssue?.type === "CHRONIC_ISSUE" && typeof topIssue.supportingMetrics.distinctComplainants === "number"
        ? topIssue.supportingMetrics.distinctComplainants
        : 0;
    const distinctComplainantsForRanking = Math.max(topIssueDistinct, repeatComplainants ?? 0, spreadComplainants ?? 0);

    rows.push({
      facility,
      totalComplaints,
      isHistoricalOnly,
      topIssueLabel: topIssue ? classificationLabelFromEntityName(topIssue.entityName) : "—",
      patternLabel: topIssue ? classificationTrendPatternLabel(topIssue.supportingMetrics.pattern) : "—",
      streakPeriods:
        topIssue && typeof topIssue.supportingMetrics.streakPeriods === "number"
          ? topIssue.supportingMetrics.streakPeriods
          : null,
      repeatComplainants,
      repeatComplaints,
      spreadComplainants,
      spreadComplaints,
      priorityBand: priorityBandLabel(priorityScore),
      priorityScore,
      isChronic: hasChronicIssue,
      distinctComplainantsForRanking,
    });
  }

  return rows.sort(compareFacilityFollowUpRows).slice(0, limit);
}

/**
 * "أفضل السجون تحسناً" (spec §4): facilities with a real SUSTAINED_IMPROVEMENT
 * finding (the engine already requires a multi-period decline, never a
 * single-period drop) — ranked by the size of the actual decrease, so the
 * facility with the lowest current count is never assumed to be "best".
 */
export function buildFacilitiesWithSustainedImprovement(
  findings: readonly AnalyticalFinding[],
  limit: number = FACILITY_ROWS_LIMIT
): FacilityImprovementRow[] {
  const bestPerFacility = new Map<string, AnalyticalFinding>();
  for (const finding of findings) {
    if (finding.type !== "SUSTAINED_IMPROVEMENT") continue;
    const facility = facilityOfFinding(finding);
    if (!facility) continue;
    const candidateDecrease = (finding.previousValue ?? 0) - finding.currentValue;
    const existing = bestPerFacility.get(facility);
    const existingDecrease = existing ? (existing.previousValue ?? 0) - existing.currentValue : -Infinity;
    if (candidateDecrease > existingDecrease) bestPerFacility.set(facility, finding);
  }

  return [...bestPerFacility.entries()]
    .map(([facility, finding]) => ({
      facility,
      startValue: finding.previousValue ?? 0,
      currentValue: finding.currentValue,
      decrease: (finding.previousValue ?? 0) - finding.currentValue,
      streakPeriods: typeof finding.supportingMetrics.streakPeriods === "number" ? finding.supportingMetrics.streakPeriods : 0,
      classificationLabel: classificationLabelFromEntityName(finding.entityName),
    }))
    .sort((a, b) => b.decrease - a.decrease)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// V2: region-only conclusions (page 4 "الاستنتاجات")
// ---------------------------------------------------------------------------

const MAX_REGION_CONCLUSIONS = 5;

function compareRisingRegionChanges(a: RegionChangeRow, b: RegionChangeRow): number {
  return (
    b.difference - a.difference
    || (b.changeRate ?? -Infinity) - (a.changeRate ?? -Infinity)
    || a.regionName.localeCompare(b.regionName, "ar")
  );
}

function compareDecliningRegionChanges(a: RegionChangeRow, b: RegionChangeRow): number {
  return (
    Math.abs(b.difference) - Math.abs(a.difference)
    || Math.abs(b.changeRate ?? 0) - Math.abs(a.changeRate ?? 0)
    || a.regionName.localeCompare(b.regionName, "ar")
  );
}

/** previousCount === 0 (direction "جديد") never fabricates a change rate — worded as a fresh appearance instead. */
function formatRisingRegionConclusion(row: RegionChangeRow): string {
  if (row.previousCount === 0 && row.currentCount > 0) {
    return `سجلت ${row.regionName} ${row.currentCount} شكوى خلال الفترة الحالية بعد عدم تسجيل شكاوى في الفترة السابقة.`;
  }
  const rateSuffix = row.changeRate === null ? "" : `، بنسبة تغير ${Math.abs(row.changeRate)}%`;
  return `سجلت ${row.regionName} ارتفاعًا قدره ${row.difference} شكوى مقارنة بالفترة السابقة${rateSuffix}.`;
}

function formatDecliningRegionConclusion(row: RegionChangeRow): string {
  const rateSuffix = row.changeRate === null ? "" : `، بنسبة تغير ${Math.abs(row.changeRate)}%`;
  return `سجلت ${row.regionName} انخفاضًا قدره ${Math.abs(row.difference)} شكوى مقارنة بالفترة السابقة${rateSuffix}.`;
}

/**
 * Guarantees both directions are represented (when both exist) instead of
 * letting whichever direction has more rows consume every slot: each
 * direction gets up to 2 guaranteed rows first, then remaining slots (up to
 * {@link MAX_REGION_CONCLUSIONS}) go to whichever side's next-strongest
 * unselected row has the larger magnitude of change.
 */
function selectBalancedRegionConclusions(
  rising: readonly RegionChangeRow[],
  declining: readonly RegionChangeRow[]
): RegionChangeRow[] {
  if (declining.length === 0) return rising.slice(0, MAX_REGION_CONCLUSIONS);
  if (rising.length === 0) return declining.slice(0, MAX_REGION_CONCLUSIONS);

  const guaranteedEach = Math.min(2, rising.length, declining.length);
  const selected: RegionChangeRow[] = [
    ...rising.slice(0, guaranteedEach),
    ...declining.slice(0, guaranteedEach),
  ];

  let nextRisingIndex = guaranteedEach;
  let nextDecliningIndex = guaranteedEach;
  while (
    selected.length < MAX_REGION_CONCLUSIONS
    && (nextRisingIndex < rising.length || nextDecliningIndex < declining.length)
  ) {
    const nextRising = rising[nextRisingIndex];
    const nextDeclining = declining[nextDecliningIndex];
    if (nextRising && (!nextDeclining || nextRising.difference >= Math.abs(nextDeclining.difference))) {
      selected.push(nextRising);
      nextRisingIndex++;
    } else if (nextDeclining) {
      selected.push(nextDeclining);
      nextDecliningIndex++;
    }
  }
  return selected;
}

/**
 * V2's conclusions are built ONLY from region rise/decline vs. the previous
 * period — never departments, facilities, classifications, or channels. See
 * {@link buildConclusions} for the department/classification-based version
 * still used by the other (non-V2) executive brief modes.
 */
export function buildRegionOnlyConclusions(comparison: ComparisonResult): string[] {
  if (!comparison.previousPeriod) {
    return ["لا تتوفر فترة سابقة صالحة لاستخراج استنتاجات مقارنة للمناطق."];
  }

  const rising = comparison.regionChanges
    .filter((row) => row.difference > 0)
    .sort(compareRisingRegionChanges);
  const declining = comparison.regionChanges
    .filter((row) => row.difference < 0)
    .sort(compareDecliningRegionChanges);

  if (rising.length === 0 && declining.length === 0) {
    return ["لم تسجل المناطق تغيرات في أعداد الشكاوى مقارنة بالفترة السابقة."];
  }

  return selectBalancedRegionConclusions(rising, declining).map((row) =>
    row.difference > 0 ? formatRisingRegionConclusion(row) : formatDecliningRegionConclusion(row)
  );
}

function hasMeaningfulPreviousData(comparison: ComparisonResult): boolean {
  return (
    comparison.previousPeriod !== null &&
    comparison.previousTotal !== null &&
    comparison.previousTotal > 0
  );
}

type OpenDepartmentCandidate = {
  name: string;
  openAtEnd: number;
  lateAtEnd: number;
  receivedDuringPeriod: number;
};

/** The department with the highest openAtEnd, over the full snapshot (backlog-only departments included). */
function findMostOpenDepartment(
  departmentSnapshot: Record<string, ReportPeriodGroupSnapshot>
): OpenDepartmentCandidate | null {
  const candidates = Object.entries(departmentSnapshot)
    .map(([name, snapshot]) => ({
      name,
      openAtEnd: snapshot.openAtEnd,
      lateAtEnd: snapshot.lateAtEnd,
      receivedDuringPeriod: snapshot.receivedDuringPeriod,
    }))
    .filter((candidate) => candidate.openAtEnd > 0)
    .sort(
      (left, right) =>
        right.openAtEnd - left.openAtEnd
        || right.lateAtEnd - left.lateAtEnd
        || right.receivedDuringPeriod - left.receivedDuringPeriod
        || left.name.localeCompare(right.name, "ar")
    );

  return candidates[0] ?? null;
}

function buildConclusions(
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  departmentSnapshot: Record<string, ReportPeriodGroupSnapshot>,
  classificationSnapshot: Record<string, ReportPeriodGroupSnapshot>
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
  // "Open"/"late" here mean openAtEnd/lateAtEnd (period-end stock). Built
  // from the full department snapshot (not result.distributions, which only
  // covers departments with inflow this period) so a backlog-only department
  // — no new registrations but a large carried-over open balance — is still
  // eligible to be named here.
  const openDepartment = findMostOpenDepartment(departmentSnapshot);
  if (openDepartment) {
    points.push(`${openDepartment.name} الأعلى في الحالات المفتوحة نهاية الفترة بعدد ${openDepartment.openAtEnd}.`);
  }
  const lateClassification = [...result.distributions.byClassification]
    .map((group) => {
      const key = group.id ? classificationKey(group.id) : UNCLASSIFIED_CLASSIFICATION_KEY;
      return { name: group.name, lateAtEnd: classificationSnapshot[key]?.lateAtEnd ?? 0 };
    })
    .sort((a, b) => b.lateAtEnd - a.lateAtEnd)[0];
  if (lateClassification?.lateAtEnd) {
    points.push(`${lateClassification.name} الأعلى في الحالات المتأخرة نهاية الفترة بعدد ${lateClassification.lateAtEnd}.`);
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

/** Same key resolution `buildTopClassifications` and `buildClassificationChanges` both need, so the "same" classification always resolves to the same id in either. */
function classificationRowKey(group: ComplaintGroupMetrics): string {
  if (group.id) return group.id;
  // Null id + unclassified display name → shared sentinel for open/late join.
  if (
    group.name === UNCLASSIFIED_CLASSIFICATION_LABEL ||
    group.classificationName === UNCLASSIFIED_CLASSIFICATION_LABEL
  ) {
    return UNCLASSIFIED_CLASSIFICATION_KEY;
  }
  return group.name;
}

type ClassificationRowInfo = {
  classificationId: string;
  classificationName: string;
  classificationPath: string;
  categoryId: string | null;
  categoryName: string;
};

/** Resolves the stable identity and Arabic display path shared by classification tables. */
function resolveClassificationRowInfo(group: ComplaintGroupMetrics): ClassificationRowInfo {
  const id = classificationRowKey(group);
  const isUnclassified = id === UNCLASSIFIED_CLASSIFICATION_KEY;
  const classificationName = isUnclassified
    ? UNCLASSIFIED_CLASSIFICATION_LABEL
    : (group.classificationName ?? group.name);
  const categoryName = isUnclassified ? "" : (group.categoryName ?? "");
  const classificationPath = isUnclassified
    ? UNCLASSIFIED_CLASSIFICATION_LABEL
    : buildClassificationPath(categoryName || null, classificationName);
  return {
    classificationId: id,
    classificationName,
    classificationPath,
    categoryId: isUnclassified ? null : (group.categoryId ?? null),
    categoryName: categoryName || (isUnclassified ? UNCLASSIFIED_CLASSIFICATION_LABEL : ""),
  };
}

export function buildTopClassifications(
  currentDistributions: ComplaintGroupMetrics[],
  previousDistributions: ComplaintGroupMetrics[],
  currentTotal: number,
  limit: number = TOP_CLASSIFICATIONS_LIMIT
): ClassificationBriefRow[] {
  const prevMap = new Map(previousDistributions.map((g) => [classificationRowKey(g), g.total]));

  return currentDistributions.slice(0, limit).map((group) => {
    const currentCount = group.total;
    const info = resolveClassificationRowInfo(group);
    const previousCount = prevMap.get(info.classificationId) ?? 0;
    return {
      categoryId: info.categoryId,
      categoryName: info.categoryName,
      classificationId: info.classificationId,
      classificationName: info.classificationName,
      classificationPath: info.classificationPath,
      currentCount,
      previousCount,
      difference: currentCount - previousCount,
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
  const periodWhere: Prisma.ComplaintWhereInput = {
    ...baseWhere,
    isDeleted: false,
    ...buildEffectiveDateWhere(period),
  };
  const where = combineComplaintWhere(
    periodWhere,
    await buildHistoricalOperationalFacilityWhere()
  );
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
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  const query = parseComplaintQuery(params);
  const baseWhere = buildComplaintWhere(query, now);
  const [receivedFacilityScope, closureFacilityScope] = await Promise.all([
    buildHistoricalOperationalFacilityWhere(),
    buildHistoricalFacilityClosureEventWhere(),
  ]);
  const inflowWhere = combineComplaintWhere({
    ...baseWhere,
    isDeleted: false,
    ...buildEffectiveDateWhere(currentPeriod),
  }, receivedFacilityScope);
  const nonDateComplaintFilters: Prisma.ComplaintWhereInput = {
    ...baseWhere,
    isDeleted: false,
  };
  const [inflow, outflowGroups] = await Promise.all([
    db.complaint.count({ where: inflowWhere }),
    db.complaintStatusHistory.groupBy({
      by: ["complaintId"],
      where: {
        toStatus: { in: ["CLOSED", "RESOLVED"] },
        changedAt: { gte: currentPeriod.from, lt: currentPeriod.toExclusive },
        complaint: { is: nonDateComplaintFilters },
        ...closureFacilityScope,
      },
    }),
  ]);
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
      classificationPath: pair.classificationPath ?? pair.classificationName,
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

function toExecutivePeriodMetrics(snapshot: ExecutiveReportSnapshotData): ExecutivePeriodMetrics {
  return {
    current: {
      receivedDuringPeriod: snapshot.current.receivedDuringPeriod,
      closedDuringPeriod: snapshot.current.closedDuringPeriod,
      openAtEnd: snapshot.current.openAtEnd,
      lateAtEnd: snapshot.current.lateAtEnd,
    },
    previous: snapshot.previous
      ? {
          receivedDuringPeriod: snapshot.previous.receivedDuringPeriod,
          closedDuringPeriod: snapshot.previous.closedDuringPeriod,
          openAtEnd: snapshot.previous.openAtEnd,
          lateAtEnd: snapshot.previous.lateAtEnd,
        }
      : null,
  };
}

function toRegionSnapshotRows(byRegion: Record<string, ReportPeriodGroupSnapshot>): RegionSnapshotAtEndRow[] {
  return Object.entries(byRegion).map(([key, group]) => ({
    regionName: displayRegionName(key),
    openAtEnd: group.openAtEnd,
    lateAtEnd: group.lateAtEnd,
  }));
}

function toDepartmentPeriodMetricsRows(
  byDepartment: Record<string, ReportPeriodGroupSnapshot>
): DepartmentPeriodMetricsRow[] {
  return Object.entries(byDepartment).map(([departmentName, group]) => ({
    departmentName,
    ...group,
  }));
}

function toClassificationSnapshotRows(
  byClassification: Record<string, ReportPeriodGroupSnapshot>
): ClassificationSnapshotAtEndRow[] {
  return Object.entries(byClassification).map(([classificationId, group]) => ({
    classificationId,
    openAtEnd: group.openAtEnd,
    lateAtEnd: group.lateAtEnd,
  }));
}

/** Trims, drops blanks, and dedupes by exact text — stable regardless of source order. */
function deduplicateWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
}

/**
 * Shared core for {@link buildExecutiveBriefData} and
 * {@link buildExecutiveBriefV2Data}. Returns the already-computed
 * {@link ExecutiveReportSnapshotData} alongside the built brief so V2 can
 * read `snapshotData.byFacility` without re-running the snapshot query.
 */
async function buildExecutiveBriefDataWithSnapshot(
  filters: ReportFilters,
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  previousResult: ComplaintKpiResult | undefined,
  now: Date
): Promise<{ briefData: ExecutiveBriefData; snapshotData: ExecutiveReportSnapshotData }> {
  const hasPrevious = comparison.previousPeriod !== null;

  const [allTimeRegions, comparativeTimeline] = await Promise.all([
    fetchAllTimeRegions(),
    buildComparativeTimeline(comparison, filters, now),
  ]);
  // Sequenced after the timeline fetch (not folded into the Promise.all above)
  // so this query's position in the call order stays stable regardless of the
  // timeline's own (1 or 2, depending on whether a previous period exists) calls.
  // Pattern analysis runs alongside the snapshot query — neither depends on
  // the other — strictly AFTER every call above, so its own query never
  // shifts their fixed call order.
  const [snapshotData, patternAnalysis] = await Promise.all([
    buildExecutiveReportSnapshotData(
      filters,
      { currentPeriod: comparison.currentPeriod, previousPeriod: comparison.previousPeriod },
      now
    ),
    loadPatternAnalysisForFilters(comparison.currentPeriod.from, comparison.currentPeriod.toExclusive, {
      facility: filters.facility ?? null,
      region: filters.region ?? null,
      classificationId: filters.classificationId ?? null,
    }),
  ]);

  const periodMetrics = toExecutivePeriodMetrics(snapshotData);
  const briefKpis = buildBriefKpis(result, previousResult, hasPrevious, periodMetrics);

  const allRegions = buildAllRegionsTable(
    allTimeRegions,
    comparison,
    result.distributions.byRegion,
    snapshotData.byRegion
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

  const warnings = deduplicateWarnings([
    ...comparison.warnings.map(comparisonWarningMessage),
    ...snapshotData.warnings,
  ]);

  const briefData: ExecutiveBriefData = {
    briefKpis,
    allRegions,
    topClassifications,
    comparativeTimeline,
    concentrationBands,
    topDepartments: buildEntityRows(
      periodMetrics.current.receivedDuringPeriod,
      snapshotData.byDepartment
    ),
    // Highest-priority pattern-analysis findings lead the conclusions list — the
    // engine's own explanation text, never re-derived — capped small enough
    // (spec §1: "دون إغراق التقرير بالتفاصيل") to stay inside the existing
    // conclusions-box budget alongside the base region/department conclusions.
    conclusions: [
      ...buildPatternAnalysisBriefConclusions(patternAnalysis, 2),
      ...buildConclusions(result, comparison, snapshotData.byDepartment, snapshotData.byClassification),
    ],
    notes: buildNotes(result, comparison),
    warnings,
    periodMetrics,
    regionSnapshotAtEnd: toRegionSnapshotRows(snapshotData.byRegion),
    departmentPeriodMetrics: toDepartmentPeriodMetricsRows(snapshotData.byDepartment),
    classificationSnapshotAtEnd: toClassificationSnapshotRows(snapshotData.byClassification),
    patternAnalysis,
  };

  return { briefData, snapshotData };
}

export async function buildExecutiveBriefData(
  filters: ReportFilters,
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  previousResult?: ComplaintKpiResult,
  now: Date = new Date()
): Promise<ExecutiveBriefData> {
  const { briefData } = await buildExecutiveBriefDataWithSnapshot(filters, result, comparison, previousResult, now);
  return briefData;
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
  id?: string;
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date | null;
  /** Mapped from Complaint.sourceUpdatedAt — last-update closure fallback. */
  lastUpdatedAt: Date | null;
  facility?: string | null;
  statusHistory: readonly ComplaintStatusHistoryEntry[];
};

const TREND_COMPLAINT_SELECT = {
  id: true,
  status: true,
  complaintDate: true,
  receivedAt: true,
  closedAt: true,
  sourceUpdatedAt: true,
  facility: true,
  statusHistory: {
    select: { fromStatus: true, toStatus: true, changedAt: true },
  },
} as const;

function toTrendComplaint(row: {
  id: string;
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date | null;
  sourceUpdatedAt: Date | null;
  facility: string | null;
  statusHistory: readonly ComplaintStatusHistoryEntry[];
}): TrendComplaint & { id: string } {
  return {
    id: row.id,
    status: row.status,
    complaintDate: row.complaintDate,
    receivedAt: row.receivedAt,
    closedAt: row.closedAt,
    lastUpdatedAt: row.sourceUpdatedAt,
    facility: row.facility,
    statusHistory: row.statusHistory,
  };
}

/**
 * Logical eligibility for monthly stock/flow chart points.
 * Uses effective closed date (closedAt, else lastUpdatedAt for closed statuses).
 */
export function isComplaintAffectingMonthlyTrend(
  complaint: TrendComplaint,
  windowFrom: Date,
  windowToExclusive: Date
): boolean {
  const createdAt = resolveTrendCreatedAt(complaint);
  if (!createdAt) return false;
  const createdMs = createdAt.getTime();
  if (createdMs >= windowToExclusive.getTime()) return false;
  if (createdMs >= windowFrom.getTime()) return true;
  const effectiveClosedAt = resolveTrustedClosedAt(complaint);
  if (effectiveClosedAt === null) return true;
  return effectiveClosedAt.getTime() >= windowFrom.getTime();
}

export function dedupeTrendComplaintsById(
  rows: readonly (TrendComplaint & { id: string })[]
): Array<TrendComplaint & { id: string }> {
  const byId = new Map<string, TrendComplaint & { id: string }>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * Prisma where for the main candidate set of the monthly trend chart.
 * Intentionally broader than trustedClosedAt semantics: closedAt before creation
 * or lastUpdatedAt fallbacks may still need a secondary fetch / post-filter.
 */
function normalizeWhereAnd(
  value: Prisma.ComplaintWhereInput["AND"]
): Prisma.ComplaintWhereInput[] {
  if (!value) return [];
  return Array.isArray(value) ? [...value] : [value];
}

export function buildMonthlyTrendPrimaryWhere(
  baseWhere: Prisma.ComplaintWhereInput,
  windowFrom: Date,
  windowToExclusive: Date
): Prisma.ComplaintWhereInput {
  const { AND: existingAnd, ...baseWithoutAnd } = baseWhere;
  const creationUpperBoundPredicate: Prisma.ComplaintWhereInput = {
    OR: [
      { complaintDate: { lt: windowToExclusive } },
      { complaintDate: null, receivedAt: { lt: windowToExclusive } },
    ],
  };
  const affectingWindowPredicate: Prisma.ComplaintWhereInput = {
    OR: [
      // Created inside the history window → can contribute receivedCount.
      { complaintDate: { gte: windowFrom } },
      { complaintDate: null, receivedAt: { gte: windowFrom } },
      // No closedAt → may be open stock or closed via lastUpdatedAt.
      { closedAt: null },
      // closedAt on/after window start → may close during a chart month.
      { closedAt: { gte: windowFrom } },
      // last-update fallback may close during the window when closedAt is absent/untrusted.
      { sourceUpdatedAt: { gte: windowFrom } },
    ],
  };
  return {
    ...baseWithoutAnd,
    AND: [
      ...normalizeWhereAnd(existingAnd),
      creationUpperBoundPredicate,
      affectingWindowPredicate,
    ],
  };
}

function isValidTrendDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function resolveTrendCreatedAt(complaint: Pick<TrendComplaint, "complaintDate" | "receivedAt">): Date | null {
  if (isValidTrendDate(complaint.complaintDate)) return complaint.complaintDate;
  return isValidTrendDate(complaint.receivedAt) ? complaint.receivedAt : null;
}

/**
 * Effective closure for month assignment via the central SLA resolver.
 * Status alone never rebuilds historic stock — the effective date does.
 */
export function resolveTrustedClosedAt(
  complaint: TrendComplaint
): Date | null {
  const snapshot: ComplaintSlaSnapshot = {
    status: complaint.status,
    complaintDate: complaint.complaintDate,
    receivedAt: complaint.receivedAt,
    closedAt: complaint.closedAt,
    lastUpdatedAt: complaint.lastUpdatedAt,
  };
  return resolveComplaintEffectiveClosedAt(snapshot);
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
type MonthlyTrendAccumulator = {
  receivedCount: number;
  closedDuringMonthCount: number;
  openAtMonthEndCount: number;
  lateAtMonthEndCount: number;
};

function createMonthlyTrendAccumulator(): MonthlyTrendAccumulator {
  return {
    receivedCount: 0,
    closedDuringMonthCount: 0,
    openAtMonthEndCount: 0,
    lateAtMonthEndCount: 0,
  };
}

function wasReceivedDuringMonth(
  createdMs: number,
  monthStartMs: number,
  monthEndExclusiveMs: number
): boolean {
  return createdMs >= monthStartMs && createdMs < monthEndExclusiveMs;
}

function wasOpenAtMonthEnd(
  createdMs: number,
  trustedClosedAt: Date | null,
  monthEndExclusiveMs: number
): boolean {
  if (createdMs >= monthEndExclusiveMs) return false;
  if (trustedClosedAt !== null && trustedClosedAt.getTime() < monthEndExclusiveMs) {
    return false;
  }
  return true;
}

/** Late when exclusive month end is strictly after createdAt + 7 days. */
function wasLateAtMonthEnd(createdMs: number, monthEndExclusiveMs: number): boolean {
  const deadlineMs = createdMs + COMPLAINT_SLA_DURATION_MS;
  return monthEndExclusiveMs > deadlineMs;
}

function accumulateComplaintForMonth(
  accumulator: MonthlyTrendAccumulator,
  complaint: TrendComplaint,
  monthStartMs: number,
  monthEndExclusiveMs: number,
  facilityRegistry?: FacilityOperationalRegistry
): void {
  const createdAt = resolveTrendCreatedAt(complaint);
  if (!createdAt) return;
  const createdMs = createdAt.getTime();
  const trustedClosedAt = resolveTrustedClosedAt(complaint);

  if (
    wasReceivedDuringMonth(createdMs, monthStartMs, monthEndExclusiveMs)
    && (!facilityRegistry || isFacilityEventEligible(
      facilityRegistry,
      complaint.facility,
      createdAt
    ))
  ) {
    accumulator.receivedCount += 1;
  }
  const eligibleClosure = resolveComplaintClosureInstants({
    status: complaint.status,
    complaintDate: complaint.complaintDate,
    receivedAt: complaint.receivedAt,
    closedAt: complaint.closedAt,
    sourceUpdatedAt: complaint.lastUpdatedAt,
    statusHistory: complaint.statusHistory,
  }).some((instant) =>
    instant.getTime() >= monthStartMs
    && instant.getTime() < monthEndExclusiveMs
    && (!facilityRegistry || isFacilityEventEligible(
      facilityRegistry,
      complaint.facility,
      instant
    ))
  );
  if (eligibleClosure) {
    accumulator.closedDuringMonthCount += 1;
  }
  if (
    facilityRegistry
    && !isFacilityEligibleAt(facilityRegistry, complaint.facility, new Date(monthEndExclusiveMs))
  ) {
    return;
  }
  if (!wasOpenAtMonthEnd(createdMs, trustedClosedAt, monthEndExclusiveMs)) {
    return;
  }
  accumulator.openAtMonthEndCount += 1;
  if (wasLateAtMonthEnd(createdMs, monthEndExclusiveMs)) {
    accumulator.lateAtMonthEndCount += 1;
  }
}

/**
 * `reportEndExclusive`, when given, clamps the LAST bucket's effective end to
 * `min(bucket.toExclusive, reportEndExclusive)` — earlier (already-complete)
 * buckets are never touched. Without this, the last calendar month always
 * runs through its natural month boundary even when the report itself ends
 * mid-month, letting activity after the report's actual end date (a
 * complaint registered, closed, or newly late) leak into that month's counts.
 */
export function aggregateMonthlyComplaintTrend(
  complaints: readonly TrendComplaint[],
  buckets: readonly MonthBucket[],
  options: {
    reportEndExclusive?: Date;
    facilityRegistry?: FacilityOperationalRegistry;
  } = {}
): MonthlyComplaintTrendPoint[] {
  const lastIndex = buckets.length - 1;
  return buckets.map((bucket, index) => {
    const monthStartMs = bucket.from.getTime();
    const naturalEndMs = bucket.toExclusive.getTime();
    const monthEndExclusiveMs =
      index === lastIndex && options.reportEndExclusive
        ? Math.min(naturalEndMs, options.reportEndExclusive.getTime())
        : naturalEndMs;
    const accumulator = createMonthlyTrendAccumulator();
    for (const complaint of complaints) {
      accumulateComplaintForMonth(
        accumulator,
        complaint,
        monthStartMs,
        monthEndExclusiveMs,
        options.facilityRegistry
      );
    }
    return {
      monthKey: bucket.key,
      monthLabel: bucket.label,
      ...accumulator,
    };
  });
}

function findEarliestDate(candidates: readonly Date[]): Date | null {
  const firstCandidate = candidates[0];
  if (!firstCandidate) return null;
  return candidates.slice(1).reduce(
    (earliest, candidate) =>
      candidate.getTime() < earliest.getTime() ? candidate : earliest,
    firstCandidate
  );
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

  return findEarliestDate(candidates);
}

/**
 * Secondary probe: complaints with closedAt before creation (untrusted closedAt),
 * opened before windowFrom. Primary where cannot express closedAt < createdAt.
 * Parameterized raw SQL keeps this set tiny vs loading entire closed history.
 * lastUpdatedAt (sourceUpdatedAt) may still yield an effective close after mapping.
 */
async function fetchUntrustedClosedBeforeWindow(
  baseWhere: Prisma.ComplaintWhereInput,
  windowFrom: Date,
  windowToExclusive: Date
): Promise<Array<TrendComplaint & { id: string }>> {
  type IdRow = { id: string };
  // COALESCE(complaintDate, receivedAt) mirrors resolveTrendCreatedAt.
  // Only untrusted closures (closedAt before effective creation) are selected.
  const idRows = await db.$queryRaw<IdRow[]>`
    SELECT id
    FROM Complaint
    WHERE isDeleted = false
      AND closedAt IS NOT NULL
      AND closedAt < COALESCE(complaintDate, receivedAt)
      AND COALESCE(complaintDate, receivedAt) < ${windowFrom}
      AND COALESCE(complaintDate, receivedAt) < ${windowToExclusive}
  `;
  if (idRows.length === 0) return [];

  // Chunk IN lists; re-apply non-date filters via Prisma baseWhere.
  const ids = idRows.map((row) => row.id);
  const chunkSize = 400;
  const collected: Array<TrendComplaint & { id: string }> = [];
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const rows = await db.complaint.findMany({
      where: {
        ...baseWhere,
        id: { in: chunk },
      },
      select: TREND_COMPLAINT_SELECT,
    });
    collected.push(...rows.map(toTrendComplaint));
  }
  return collected;
}

async function fetchMonthlyTrendComplaints(
  baseWhere: Prisma.ComplaintWhereInput,
  windowFrom: Date,
  windowToExclusive: Date
): Promise<TrendComplaint[]> {
  const primaryRows = await db.complaint.findMany({
    where: buildMonthlyTrendPrimaryWhere(baseWhere, windowFrom, windowToExclusive),
    select: TREND_COMPLAINT_SELECT,
  });
  const primary = primaryRows.map(toTrendComplaint);

  const untrusted = await fetchUntrustedClosedBeforeWindow(
    baseWhere,
    windowFrom,
    windowToExclusive
  );

  const deduped = dedupeTrendComplaintsById([...primary, ...untrusted]);
  return deduped.filter((row) =>
    isComplaintAffectingMonthlyTrend(row, windowFrom, windowToExclusive)
  );
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

  const firstBucket = buckets[0];
  const lastBucket = buckets.at(-1);
  if (!firstBucket || !lastBucket) return [];

  const windowFrom = firstBucket.from;
  const windowToExclusive = lastBucket.toExclusive;
  const baseWhere = nonDateComplaintWhere(filters, now);

  // Trend is not limited by filters.from: history window drives the candidate set.
  // Only complaints that can affect chart series are loaded (not all-time history).
  const [complaints, facilityRegistry] = await Promise.all([
    fetchMonthlyTrendComplaints(baseWhere, windowFrom, windowToExclusive),
    loadFacilityOperationalRegistry(),
  ]);

  return aggregateMonthlyComplaintTrend(complaints, buckets, {
    reportEndExclusive: reportToExclusive,
    facilityRegistry,
  });
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
  const facilityWhere = await buildHistoricalOperationalFacilityWhere();
  return db.complaint.count({
    where: combineComplaintWhere({ ...baseWhere, isDeleted: false }, facilityWhere),
  });
}

// ---------------------------------------------------------------------------
// V2 public API
// ---------------------------------------------------------------------------

/**
 * classificationOpenLate is derived from `briefData.classificationSnapshotAtEnd`
 * (itself backed by {@link resolveComplaintOpenStateAt}) instead of a separate
 * query, so it can never disagree with the classification table or the
 * openAtEnd/lateAtEnd reconciliation totals — see spec section 14.
 */
/**
 * "عدد السجون المتأثرة" (spec §14): per classificationId, how many distinct
 * facilities have a CLASSIFICATION-scoped finding for it this period — i.e.
 * crossed the pattern engine's own significance threshold there, not merely
 * "has any complaint". Sourced entirely from `findings`, never a separate
 * raw-presence count.
 */
function computeClassificationAffectedFacilityCounts(
  findings: readonly AnalyticalFinding[]
): Record<string, number> {
  const byClassification = new Map<string, Set<string>>();
  for (const finding of findings) {
    if (finding.entityType !== "CLASSIFICATION") continue;
    const facility = facilityOfFinding(finding);
    if (!facility) continue;
    const key = classificationKey(finding.entityId);
    const set = byClassification.get(key) ?? new Set<string>();
    set.add(facility);
    byClassification.set(key, set);
  }
  const result: Record<string, number> = {};
  for (const [key, facilities] of byClassification) result[key] = facilities.size;
  return result;
}

function toClassificationOpenLate(
  rows: ClassificationSnapshotAtEndRow[]
): Record<string, { openAtEnd: number; lateAtEnd: number }> {
  const result: Record<string, { openAtEnd: number; lateAtEnd: number }> = {};
  for (const row of rows) {
    result[row.classificationId] = { openAtEnd: row.openAtEnd, lateAtEnd: row.lateAtEnd };
  }
  return result;
}

export async function buildExecutiveBriefV2Data(
  filters: ReportFilters,
  result: ComplaintKpiResult,
  comparison: ComparisonResult,
  previousResult?: ComplaintKpiResult,
  now: Date = new Date()
): Promise<ExecutiveBriefV2Data> {
  const [{ briefData }, allTimeTotal, monthlyStockFlow] = await Promise.all([
    buildExecutiveBriefDataWithSnapshot(filters, result, comparison, previousResult, now),
    fetchAllTimeTotal(filters, now),
    buildMonthlyStockFlow(filters, comparison, now),
  ]);

  const classificationOpenLate = toClassificationOpenLate(briefData.classificationSnapshotAtEnd ?? []);
  const patternFindings = briefData.patternAnalysis?.findings ?? [];
  const facilityCurrentPeriodTotals = briefData.patternAnalysis?.facilityCurrentPeriodTotals ?? {};

  // Unlimited pass first so the cover-page count (spec §6) reflects every
  // qualifying facility, not just the top FACILITY_ROWS_LIMIT shown on page 4.
  const allFacilityFollowUpRows = buildFacilitiesNeedingFollowUp(
    patternFindings,
    facilityCurrentPeriodTotals,
    Number.POSITIVE_INFINITY
  );
  const facilitiesNeedingFollowUp = allFacilityFollowUpRows.slice(0, FACILITY_ROWS_LIMIT);
  const highPriorityFacilityCount = allFacilityFollowUpRows.filter((r) => r.priorityBand === "مرتفعة").length;
  const continuedProblemFindingCount = computeContinuedProblemFindingCount(patternFindings);
  const facilitiesWithSustainedImprovement = buildFacilitiesWithSustainedImprovement(patternFindings);
  const classificationTrends = buildClassificationTrendRows(patternFindings);
  const classificationAffectedFacilityCounts = computeClassificationAffectedFacilityCounts(patternFindings);

  return {
    ...briefData,
    allTimeTotal,
    monthlyStockFlow,
    classificationOpenLate,
    classificationAffectedFacilityCounts,
    highPriorityFacilityCount,
    continuedProblemFindingCount,
    facilitiesNeedingFollowUp,
    facilitiesWithSustainedImprovement,
    classificationTrends,
    // V2-only: region-only conclusions stay the base, led by up to 3
    // high-priority pattern-analysis sentences (spec §10) — the engine's own
    // explanation text, never re-derived here.
    conclusions: [
      ...buildPatternAnalysisBriefConclusions(briefData.patternAnalysis, 3),
      ...buildRegionOnlyConclusions(comparison),
    ],
  };
}
