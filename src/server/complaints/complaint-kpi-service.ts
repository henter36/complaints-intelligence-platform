import { ComplaintPriority, ComplaintStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { roundToTenth } from "@/lib/complaint-metrics";
import {
  buildComplaintSlaMetrics,
  type ComplaintSlaMetrics,
} from "./complaint-sla-metrics";
import { buildComplaintSlaTiming, resolveComplaintEffectiveClosedAt } from "./complaint-sla-timing";
import {
  buildClassificationPath,
  classificationDisplayName,
  UNCLASSIFIED_CLASSIFICATION_LABEL,
} from "@/lib/reports/classification-keys";
import { displayRegionName, normalizeRegionName } from "@/lib/reports/region-normalization";
import { previousInclusivePeriod } from "@/lib/reports/period-range";
import type { ComparisonMode } from "@/lib/reports/report-contract";
import {
  buildComplaintWhere,
  parseComplaintQuery,
  type ComplaintQuery,
} from "./complaint-query-service";
import {
  CLOSED_COMPLAINT_STATUSES,
  isClosedComplaintStatus,
  isOpenComplaintStatus,
  isReopenTransition,
} from "./status";

const DAY_MS = 24 * 60 * 60 * 1000;
const UNSPECIFIED_LABEL = "غير محدد";

const kpiSelect = {
  id: true,
  status: true,
  priority: true,
  severity: true,
  complaintDate: true,
  receivedAt: true,
  dueDate: true,
  closedAt: true,
  sourceUpdatedAt: true,
  firstActionAt: true,
  processingStartedAt: true,
  delayReason: true,
  isRepeated: true,
  isValidated: true,
  isPotentialDuplicate: true,
  beneficiarySatisfaction: true,
  region: true,
  facility: true,
  department: true,
  classificationId: true,
  categoryId: true,
  channel: true,
  subject: true,
  classification: { select: { id: true, nameAr: true } },
  category: { select: { id: true, nameAr: true } },
  statusHistory: {
    select: {
      fromStatus: true,
      toStatus: true,
    },
  },
} satisfies Prisma.ComplaintSelect;

type KpiComplaint = Prisma.ComplaintGetPayload<{ select: typeof kpiSelect }>;

export type KpiValue = {
  currentValue: number;
  previousValue: number | null;
  absoluteChange: number | null;
  percentageChange: number | null;
  trend: "up" | "down" | "flat" | "none";
  direction: "positive" | "negative" | "neutral";
  available?: boolean;
};

type MetricTrend = KpiValue["trend"];
type MetricDirection = KpiValue["direction"];

export type ComplaintKpiSummary = {
  totalComplaints: KpiValue;
  openComplaints: KpiValue;
  closedComplaints: KpiValue;
  cancelledComplaints: KpiValue;
  currentlyLateComplaints: KpiValue;
  closedLateComplaints: KpiValue;
  // Canonical SLA KPI fields
  slaComplianceRate: KpiValue;
  closedWithinSlaCount: KpiValue;
  closedWithoutTrustedDateCount: KpiValue;
  unclassifiedComplaints: KpiValue;
  highPriorityOpenComplaints: KpiValue;
  averageResolutionDays: KpiValue;
  medianResolutionDays: KpiValue;
  averageOpenAgeDays: KpiValue;
  closureRate: KpiValue;
  reopenCount: KpiValue;
  // Backward-compatibility aliases — mirrors of the canonical SLA fields above.
  // Kept at the output boundary only; not used in internal calculations.
  /** @deprecated use slaComplianceRate */
  dueDateComplianceRate: KpiValue;
  /** @deprecated use closedWithinSlaCount */
  closedWithinDueDate: KpiValue;
  /** @deprecated use closedWithoutTrustedDateCount */
  withoutDueDate: KpiValue;
};

export type ComplaintGroupMetrics = {
  name: string;
  id?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  classificationName?: string | null;
  count: number;
  total: number;
  open: number;
  closed: number;
  currentlyLate: number;
  closedLate: number;
  withinDueDate: number;
  complianceRate: number | null;
  averageResolutionDays: number;
  averageResolutionEligibleCount: number;
  slaEligibleCount: number;
  closedWithoutTrustedDateCount: number;
  highPriorityOpen: number;
  unclassified: number;
};

export type RegionPriorityBreakdownRow = {
  region: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
};

export type ComplaintDistributions = {
  byRegion: ComplaintGroupMetrics[];
  byFacility: ComplaintGroupMetrics[];
  byDepartment: ComplaintGroupMetrics[];
  byClassification: ComplaintGroupMetrics[];
  byCategory: ComplaintGroupMetrics[];
  byChannel: ComplaintGroupMetrics[];
  byStatus: { name: string; count: number }[];
  byPriority: { name: string; count: number }[];
  bySeverity: { name: string; count: number }[];
  byDelayReason: { name: string; count: number }[];
  bySubject: { name: string; count: number }[];
  byMonth: { name: string; count: number }[];
  byRegionPriority: RegionPriorityBreakdownRow[];
};

export type ComplaintKpiResult = {
  kpis: ComplaintKpiSummary;
  volume: {
    total: number;
    open: number;
    inProgress: number;
    closed: number;
    reopened: number;
    rejected: number;
    late: number;
    repeated: number;
    validated: number;
    notValidated: number;
    potentialDuplicates: number;
  };
  performance: {
    closureRate: number;
    onTimeRate: number | null;
    /** @deprecated alias — use slaEligibleCount */
    onTimeEligibleClosed: number;
    lateRate: number;
    avgFirstResponseHours: number;
    avgProcessingHours: number;
    avgOpenAgeHours: number;
    averageResolutionDays: number | null;
    medianResolutionDays: number | null;
    overdueNoAction: number;
    overdueNoActionRate: number;
    reopenRate: number;
    validityRate: number;
    avgSatisfaction: number;
    satisfactionRate: number;
    // Seven-day SLA metrics
    slaEligibleCount: number;
    slaCompliantCount: number;
    slaNonCompliantCount: number;
    openWithinSlaCount: number;
    closedWithinSlaCount: number;
    closedLateCount: number;
    closedWithoutTrustedDateCount: number;
    averageResolutionEligibleCount: number;
  };
  trend: {
    previousTotal: number | null;
    growthRate: number | null;
    trendData: { date: string; total: number; closed: number; open: number }[];
  };
  distributions: ComplaintDistributions;
  crossTabs: {
    classificationByRegion: CrossTabRow[];
    classificationByDepartment: CrossTabRow[];
  };
  alerts: {
    criticalComplaints: number;
    lateCritical: number;
    missingFields: number;
    dataQualityRate: number;
  };
  previousDistributions: ComplaintDistributions | null;
};

export type CrossTabRow = {
  classificationId?: string | null;
  classification: string;
  groupId?: string | null;
  group: string;
  count: number;
};

type RawMetrics = {
  totalComplaints: number;
  openComplaints: number;
  closedComplaints: number;
  cancelledComplaints: number;
  currentlyLateComplaints: number;
  closedLateComplaints: number;
  // Canonical SLA fields — used in KPI_METRIC_KEYS and all internal calculations
  slaComplianceRate: number;
  closedWithinSlaCount: number;
  closedWithoutTrustedDateCount: number;
  unclassifiedComplaints: number;
  highPriorityOpenComplaints: number;
  averageResolutionDays: number;
  medianResolutionDays: number;
  averageOpenAgeDays: number;
  closureRate: number;
  reopenCount: number;
  // SLA fields used internally but not surfaced as individual KpiValue entries
  slaEligibleCount: number;
  slaCompliantCount: number;
  slaNonCompliantCount: number;
  openWithinSlaCount: number;
  closedLateCount: number;
  averageResolutionEligibleCount: number;
  averageResolutionDaysNullable: number | null;
  medianResolutionDaysNullable: number | null;
};

const KPI_METRIC_KEYS = [
  "totalComplaints",
  "openComplaints",
  "closedComplaints",
  "cancelledComplaints",
  "currentlyLateComplaints",
  "closedLateComplaints",
  "slaComplianceRate",
  "closedWithinSlaCount",
  "closedWithoutTrustedDateCount",
  "unclassifiedComplaints",
  "highPriorityOpenComplaints",
  "averageResolutionDays",
  "medianResolutionDays",
  "averageOpenAgeDays",
  "closureRate",
  "reopenCount",
] as const satisfies readonly (keyof RawMetrics & keyof ComplaintKpiSummary)[];

type ComplaintKpiOptions = {
  comparisonMode?: ComparisonMode;
  includeComparison?: boolean;
};

export async function getComplaintKpis(
  params: URLSearchParams,
  now = new Date(),
  options: ComplaintKpiOptions = {}
): Promise<ComplaintKpiResult> {
  const query = parseComplaintQuery(params);
  const currentWhere = buildComplaintWhere(query, now);
  const previousWhere = options.includeComparison === false
    ? null
    : buildPreviousWhere(query, now, options.comparisonMode);
  const [current, previous] = await Promise.all([
    db.complaint.findMany({ where: currentWhere, select: kpiSelect }),
    previousWhere ? db.complaint.findMany({ where: previousWhere, select: kpiSelect }) : Promise.resolve(null),
  ]);
  return buildKpiResult(current, previous, now, query);
}

export function getPreviousPeriodRange(
  from: Date,
  to: Date,
  mode: ComparisonMode = "PREVIOUS_EQUIVALENT_PERIOD"
): { from: Date; to: Date } | null {
  return previousInclusivePeriod(from, to, mode);
}

function buildPreviousWhere(
  query: ComplaintQuery,
  now: Date,
  mode: ComparisonMode = "PREVIOUS_EQUIVALENT_PERIOD"
): Prisma.ComplaintWhereInput | null {
  if (!query.from || !query.to) return null;
  const previousRange = getPreviousPeriodRange(query.from, query.to, mode);
  if (!previousRange) return null;
  const previousQuery = { ...query, from: previousRange.from, to: previousRange.to };
  return buildComplaintWhere(previousQuery, now);
}

function buildKpiResult(
  current: KpiComplaint[],
  previous: KpiComplaint[] | null,
  now: Date,
  query: ComplaintQuery
): ComplaintKpiResult {
  const currentRaw = calculateRawMetrics(current, now);
  const previousRaw = previous ? calculateRawMetrics(previous, now) : null;
  const canonical = buildKpiValues(currentRaw, previousRaw);
  canonical.slaComplianceRate.available = currentRaw.slaEligibleCount > 0;
  canonical.averageResolutionDays.available = currentRaw.averageResolutionEligibleCount > 0;
  canonical.medianResolutionDays.available = currentRaw.averageResolutionEligibleCount > 0;
  const kpis = addLegacyKpiAliases(canonical);
  const firstResponses = current
    .filter((complaint) => complaint.firstActionAt)
    .map((complaint) => hoursBetween(complaint.complaintDate ?? complaint.receivedAt, complaint.firstActionAt!));
  const processingHours = current
    .filter((complaint) => {
      if (!complaint.processingStartedAt) return false;
      return resolveComplaintEffectiveClosedAt(toSlaSnapshot(complaint)) !== null;
    })
    .map((complaint) => {
      const closedAt = resolveComplaintEffectiveClosedAt(toSlaSnapshot(complaint))!;
      return hoursBetween(complaint.processingStartedAt!, closedAt);
    });
  const satisfaction = current.flatMap((complaint) =>
    complaint.beneficiarySatisfaction === null ? [] : [complaint.beneficiarySatisfaction]
  );
  const overdueNoActionCount = current.filter((complaint) =>
    buildComplaintSlaTiming(toSlaSnapshot(complaint), now).isCurrentlyLate && !complaint.firstActionAt
  ).length;

  return {
    kpis,
    volume: {
      total: currentRaw.totalComplaints,
      open: currentRaw.openComplaints,
      inProgress: current.filter((complaint) =>
        complaint.status === ComplaintStatus.IN_PROGRESS || complaint.status === ComplaintStatus.AWAITING_RESPONSE
      ).length,
      closed: currentRaw.closedComplaints,
      reopened: currentRaw.reopenCount,
      rejected: currentRaw.cancelledComplaints,
      late: currentRaw.currentlyLateComplaints,
      repeated: current.filter((complaint) => complaint.isRepeated).length,
      validated: current.filter((complaint) => complaint.isValidated).length,
      notValidated: current.filter((complaint) => !complaint.isValidated && complaint.status !== ComplaintStatus.CANCELLED).length,
      potentialDuplicates: current.filter((complaint) => complaint.isPotentialDuplicate).length,
    },
    performance: {
      closureRate: currentRaw.closureRate,
      onTimeRate: currentRaw.slaEligibleCount > 0 ? currentRaw.slaComplianceRate : null,
      onTimeEligibleClosed: currentRaw.slaEligibleCount,
      lateRate: rate(currentRaw.currentlyLateComplaints, currentRaw.totalComplaints),
      avgFirstResponseHours: roundToTenth(averageNumbers(firstResponses)),
      avgProcessingHours: roundToTenth(averageNumbers(processingHours)),
      avgOpenAgeHours: roundToTenth(currentRaw.averageOpenAgeDays * 24),
      averageResolutionDays: currentRaw.averageResolutionDaysNullable,
      medianResolutionDays: currentRaw.medianResolutionDaysNullable,
      overdueNoAction: overdueNoActionCount,
      overdueNoActionRate: rate(overdueNoActionCount, currentRaw.totalComplaints),
      reopenRate: rate(currentRaw.reopenCount, currentRaw.closedComplaints + currentRaw.reopenCount),
      validityRate: rate(current.filter((complaint) => complaint.isValidated).length, currentRaw.totalComplaints),
      avgSatisfaction: roundToTenth(averageNumbers(satisfaction)),
      satisfactionRate: rate(satisfaction.filter((value) => value >= 4).length, satisfaction.length),
      slaEligibleCount: currentRaw.slaEligibleCount,
      slaCompliantCount: currentRaw.slaCompliantCount,
      slaNonCompliantCount: currentRaw.slaNonCompliantCount,
      openWithinSlaCount: currentRaw.openWithinSlaCount,
      closedWithinSlaCount: currentRaw.closedWithinSlaCount,
      closedLateCount: currentRaw.closedLateCount,
      closedWithoutTrustedDateCount: currentRaw.closedWithoutTrustedDateCount,
      averageResolutionEligibleCount: currentRaw.averageResolutionEligibleCount,
    },
    trend: {
      previousTotal: previousRaw?.totalComplaints ?? null,
      growthRate: previousRaw ? percentageChange(currentRaw.totalComplaints, previousRaw.totalComplaints) : null,
      trendData: buildTrend(current, now, query.from, query.to),
    },
    distributions: buildDistributions(current, now),
    crossTabs: buildCrossTabs(current),
    previousDistributions: previous ? buildDistributions(previous, now) : null,
    alerts: {
      criticalComplaints: current.filter((complaint) =>
        complaint.priority === ComplaintPriority.CRITICAL || complaint.severity === ComplaintPriority.CRITICAL
      ).length,
      lateCritical: current.filter((complaint) =>
        buildComplaintSlaTiming(toSlaSnapshot(complaint), now).isCurrentlyLate
        && (complaint.priority === ComplaintPriority.CRITICAL || complaint.severity === ComplaintPriority.CRITICAL)
      ).length,
      missingFields: current.filter((complaint) => !complaint.region || !complaint.department || !complaint.classificationId).length,
      dataQualityRate: rate(
        current.filter((complaint) => complaint.region && complaint.department && complaint.classificationId).length,
        currentRaw.totalComplaints
      ),
    },
  };
}

function toSlaSnapshot(c: KpiComplaint) {
  return {
    status: c.status,
    complaintDate: c.complaintDate,
    receivedAt: c.receivedAt,
    closedAt: c.closedAt,
    lastUpdatedAt: c.sourceUpdatedAt ?? null,
  };
}

function calculateRawMetrics(complaints: KpiComplaint[], now: Date): RawMetrics {
  const sla: ComplaintSlaMetrics = buildComplaintSlaMetrics(complaints.map(toSlaSnapshot), now);
  const openAgeDays = complaints.flatMap((c) => {
    const timing = buildComplaintSlaTiming(toSlaSnapshot(c), now);
    return timing.openAgeDays === null ? [] : [timing.openAgeDays];
  });

  return {
    totalComplaints: complaints.length,
    openComplaints: complaints.filter((c) => isOpenComplaintStatus(c.status)).length,
    closedComplaints: complaints.filter((c) => isClosedComplaintStatus(c.status)).length,
    cancelledComplaints: complaints.filter((c) => c.status === ComplaintStatus.CANCELLED).length,
    // SLA-derived timing fields (canonical names only)
    currentlyLateComplaints: sla.openLateCount,
    closedLateComplaints: sla.closedLateCount,
    slaComplianceRate: sla.complianceRate ?? 0,
    closedWithinSlaCount: sla.closedWithinSlaCount,
    closedWithoutTrustedDateCount: sla.closedWithoutTrustedDateCount,
    unclassifiedComplaints: complaints.filter((c) => !c.classificationId).length,
    highPriorityOpenComplaints: complaints.filter((c) =>
      isOpenComplaintStatus(c.status)
      && (c.priority === ComplaintPriority.HIGH || c.priority === ComplaintPriority.CRITICAL)
    ).length,
    // averageResolutionDays/medianResolutionDays: 0 for KpiValue compat (see *Nullable variants)
    averageResolutionDays: sla.averageResolutionDays ?? 0,
    medianResolutionDays: sla.medianResolutionDays ?? 0,
    averageOpenAgeDays: roundToTenth(averageNumbers(openAgeDays)),
    closureRate: rate(complaints.filter((c) => isClosedComplaintStatus(c.status)).length, complaints.length),
    reopenCount: countReopenTransitions(complaints),
    // SLA fields used internally but not surfaced as individual KpiValue entries
    slaEligibleCount: sla.eligibleCount,
    slaCompliantCount: sla.compliantCount,
    slaNonCompliantCount: sla.nonCompliantCount,
    openWithinSlaCount: sla.openWithinSlaCount,
    closedLateCount: sla.closedLateCount,
    averageResolutionEligibleCount: sla.averageResolutionEligibleCount,
    averageResolutionDaysNullable: sla.averageResolutionDays,
    medianResolutionDaysNullable: sla.medianResolutionDays,
  };
}

function countReopenTransitions(complaints: KpiComplaint[]): number {
  return complaints.reduce((total, complaint) => {
    const statusHistory = complaint.statusHistory ?? [];
    return total + statusHistory.filter((history) =>
      history.fromStatus !== null && isReopenTransition(history.fromStatus, history.toStatus)
    ).length;
  }, 0);
}

type CanonicalKpiSummary = Omit<ComplaintKpiSummary, "dueDateComplianceRate" | "closedWithinDueDate" | "withoutDueDate">;

function buildKpiValues(current: RawMetrics, previous: RawMetrics | null): CanonicalKpiSummary {
  return Object.fromEntries(
    KPI_METRIC_KEYS.map((key) => [
      key,
      compareMetric(current[key], previous?.[key] ?? null, negativeWhenHigher(key)),
    ])
  ) as CanonicalKpiSummary;
}

function addLegacyKpiAliases(canonical: CanonicalKpiSummary): ComplaintKpiSummary {
  return {
    ...canonical,
    dueDateComplianceRate: canonical.slaComplianceRate,
    closedWithinDueDate: canonical.closedWithinSlaCount,
    withoutDueDate: canonical.closedWithoutTrustedDateCount,
  };
}

function compareMetric(current: number, previous: number | null, higherIsNegative: boolean): KpiValue {
  const absoluteChange = previous === null ? null : roundToTenth(current - previous);
  const trend = resolveTrend(current, previous);
  return {
    currentValue: current,
    previousValue: previous,
    absoluteChange,
    percentageChange: resolvePercentageChange(current, previous),
    trend,
    direction: resolveDirection(trend, higherIsNegative),
  };
}

function resolveTrend(current: number, previous: number | null): MetricTrend {
  if (previous === null) return "none";
  if (current === previous) return "flat";
  return current > previous ? "up" : "down";
}

function resolveDirection(trend: MetricTrend, higherIsNegative: boolean): MetricDirection {
  if (trend === "flat" || trend === "none") return "neutral";
  const increased = trend === "up";
  if (higherIsNegative) return increased ? "negative" : "positive";
  return increased ? "positive" : "negative";
}

function resolvePercentageChange(current: number, previous: number | null): number | null {
  if (previous === null) return null;
  return percentageChange(current, previous);
}

function negativeWhenHigher(key: string): boolean {
  return [
    "currentlyLateComplaints",
    "closedLateComplaints",
    "closedWithoutTrustedDateCount",
    "unclassifiedComplaints",
    "averageResolutionDays",
    "medianResolutionDays",
    "averageOpenAgeDays",
    "reopenCount",
  ].includes(key);
}

function buildDistributions(complaints: KpiComplaint[], now: Date): ComplaintDistributions {
  return {
    byRegion: groupMetrics(complaints, now, (complaint) => ({
      name: displayRegionName(normalizeRegionName(complaint.region)),
    })),
    byFacility: groupMetrics(complaints, now, (complaint) => ({ name: complaint.facility ?? UNSPECIFIED_LABEL })),
    byDepartment: groupMetrics(complaints, now, (complaint) => ({ name: complaint.department ?? UNSPECIFIED_LABEL })),
    byClassification: groupMetrics(complaints, now, (complaint) => {
      const leafName = complaint.classification?.nameAr?.trim() || null;
      const isClassified = Boolean(
        leafName || complaint.classification?.id || complaint.classificationId
      );
      const categoryName = isClassified ? (complaint.category?.nameAr ?? null) : null;
      return {
        id: complaint.classification?.id ?? complaint.classificationId ?? null,
        name: isClassified
          ? buildClassificationPath(categoryName, leafName)
          : UNCLASSIFIED_CLASSIFICATION_LABEL,
        categoryId: isClassified ? (complaint.category?.id ?? complaint.categoryId) : null,
        categoryName,
        classificationName: isClassified
          ? classificationDisplayName(leafName)
          : UNCLASSIFIED_CLASSIFICATION_LABEL,
      };
    }),
    byCategory: groupMetrics(complaints, now, (complaint) => ({
      id: complaint.category?.id ?? null,
      name: complaint.category?.nameAr ?? UNCLASSIFIED_CLASSIFICATION_LABEL,
    })),
    byChannel: groupMetrics(complaints, now, (complaint) => ({ name: complaint.channel ?? UNSPECIFIED_LABEL })),
    byStatus: groupCount(complaints, (complaint) => complaint.status),
    byPriority: groupCount(complaints, (complaint) => complaint.priority),
    bySeverity: groupCount(complaints, (complaint) => complaint.severity),
    byDelayReason: groupCount(complaints.filter((complaint) => complaint.delayReason), (complaint) => complaint.delayReason ?? UNSPECIFIED_LABEL),
    bySubject: groupCount(complaints, (complaint) => complaint.subject),
    byMonth: groupCount(complaints, (complaint) => monthKey(complaint.complaintDate ?? complaint.receivedAt)),
    byRegionPriority: buildRegionPriorityBreakdown(complaints),
  };
}

function buildRegionPriorityBreakdown(complaints: KpiComplaint[]): RegionPriorityBreakdownRow[] {
  const map = new Map<string, RegionPriorityBreakdownRow>();
  for (const c of complaints) {
    const region = displayRegionName(normalizeRegionName(c.region));
    const row = map.get(region) ?? { region, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0 };
    if (c.priority === ComplaintPriority.CRITICAL) row.critical++;
    else if (c.priority === ComplaintPriority.HIGH) row.high++;
    else if (c.priority === ComplaintPriority.MEDIUM) row.medium++;
    else if (c.priority === ComplaintPriority.LOW) row.low++;
    else row.unknown++;
    row.total++;
    map.set(region, row);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total || a.region.localeCompare(b.region, "ar"));
}

function groupMetrics(
  complaints: KpiComplaint[],
  now: Date,
  keyFn: (complaint: KpiComplaint) => {
    name: string;
    id?: string | null;
    categoryId?: string | null;
    categoryName?: string | null;
    classificationName?: string | null;
  }
): ComplaintGroupMetrics[] {
  const map = new Map<string, { id?: string | null; items: KpiComplaint[] }>();
  for (const complaint of complaints) {
    const key = keyFn(complaint);
    const mapKey = groupKey(key);
    const current = map.get(mapKey) ?? { id: key.id, items: [] };
    current.items.push(complaint);
    map.set(mapKey, current);
  }

  return Array.from(map.values())
    .map((value) => {
      const raw = calculateRawMetrics(value.items, now);
      const representative = keyFn(value.items[0]!);
      return {
        name: representative.name,
        id: value.id,
        categoryId: representative.categoryId ?? null,
        categoryName: representative.categoryName ?? null,
        classificationName: representative.classificationName ?? null,
        count: raw.totalComplaints,
        total: raw.totalComplaints,
        open: raw.openComplaints,
        closed: raw.closedComplaints,
        currentlyLate: raw.currentlyLateComplaints,
        closedLate: raw.closedLateComplaints,
        withinDueDate: raw.closedWithinSlaCount,
        complianceRate: raw.slaEligibleCount > 0 ? raw.slaComplianceRate : null,
        averageResolutionDays: raw.averageResolutionDays,
        averageResolutionEligibleCount: raw.averageResolutionEligibleCount,
        slaEligibleCount: raw.slaEligibleCount,
        closedWithoutTrustedDateCount: raw.closedWithoutTrustedDateCount,
        highPriorityOpen: raw.highPriorityOpenComplaints,
        unclassified: raw.unclassifiedComplaints,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ar"));
}

function groupKey(key: { name: string; id?: string | null }): string {
  return key.id ? `id:${key.id}` : `name:${key.name}`;
}

function groupCount<T>(items: T[], keyFn: (item: T) => string): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item) || UNSPECIFIED_LABEL;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ar"));
}

function buildTrend(
  complaints: KpiComplaint[],
  now: Date,
  from?: Date,
  to?: Date
): { date: string; total: number; closed: number; open: number }[] {
  const { start, end } = resolveTrendRange(now, from, to);
  const result: { date: string; total: number; closed: number; open: number }[] = [];
  for (let day = start; day <= end; day = new Date(day.getTime() + DAY_MS)) {
    const key = dayKey(day);
    const items = complaints.filter((complaint) => dayKey(complaint.complaintDate ?? complaint.receivedAt) === key);
    result.push({
      date: key,
      total: items.length,
      closed: items.filter((complaint) => CLOSED_COMPLAINT_STATUSES.has(complaint.status)).length,
      open: items.filter((complaint) => isOpenComplaintStatus(complaint.status)).length,
    });
  }
  return result;
}

function resolveTrendRange(now: Date, from?: Date, to?: Date): { start: Date; end: Date } {
  const fallbackStart = new Date(now.getTime() - 29 * DAY_MS);
  const start = startOfUtcDay(from ?? fallbackStart);
  const end = startOfUtcDay(to ?? now);
  if (start <= end) {
    return { start, end };
  }
  return { start: end, end };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function buildCrossTabs(complaints: KpiComplaint[]): ComplaintKpiResult["crossTabs"] {
  return {
    classificationByRegion: buildClassificationCrossTab(complaints, (complaint) => complaint.region ?? UNSPECIFIED_LABEL),
    classificationByDepartment: buildClassificationCrossTab(complaints, (complaint) => complaint.department ?? UNSPECIFIED_LABEL),
  };
}

function buildClassificationCrossTab(
  complaints: KpiComplaint[],
  groupName: (complaint: KpiComplaint) => string
): CrossTabRow[] {
  const map = new Map<string, CrossTabRow>();
  for (const complaint of complaints) {
    const leafName = complaint.classification?.nameAr ?? null;
    const categoryName = complaint.category?.nameAr ?? null;
    const classification = leafName
      ? buildClassificationPath(categoryName, leafName)
      : UNCLASSIFIED_CLASSIFICATION_LABEL;
    const classificationId = complaint.classification?.id ?? null;
    const group = groupName(complaint);
    const key = `${classificationId ?? classification}:${group}`;
    const current = map.get(key) ?? { classificationId, classification, group, count: 0 };
    current.count += 1;
    map.set(key, current);
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification, "ar") || a.group.localeCompare(b.group, "ar"));
}

function hoursBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60);
}

function averageNumbers(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundToTenth((numerator / denominator) * 100) : 0;
}

function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return roundToTenth(((current - previous) / previous) * 100);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
