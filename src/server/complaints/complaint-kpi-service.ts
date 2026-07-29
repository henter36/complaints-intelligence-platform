import { ComplaintPriority, ComplaintStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { roundToTenth } from "@/lib/complaint-metrics";
import { buildComplaintTiming } from "./complaint-timing";
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
const UNCLASSIFIED_LABEL = "غير مصنف";
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
};

export type ComplaintKpiSummary = {
  totalComplaints: KpiValue;
  openComplaints: KpiValue;
  closedComplaints: KpiValue;
  cancelledComplaints: KpiValue;
  currentlyLateComplaints: KpiValue;
  closedLateComplaints: KpiValue;
  closedWithinDueDate: KpiValue;
  withoutDueDate: KpiValue;
  unclassifiedComplaints: KpiValue;
  highPriorityOpenComplaints: KpiValue;
  averageResolutionDays: KpiValue;
  medianResolutionDays: KpiValue;
  averageOpenAgeDays: KpiValue;
  dueDateComplianceRate: KpiValue;
  closureRate: KpiValue;
  reopenCount: KpiValue;
};

export type ComplaintGroupMetrics = {
  name: string;
  id?: string | null;
  count: number;
  total: number;
  open: number;
  closed: number;
  currentlyLate: number;
  closedLate: number;
  withinDueDate: number;
  complianceRate: number | null;
  averageResolutionDays: number;
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
    onTimeRate: number;
    lateRate: number;
    avgFirstResponseHours: number;
    avgProcessingHours: number;
    avgOpenAgeHours: number;
    averageResolutionDays: number;
    medianResolutionDays: number;
    overdueNoAction: number;
    overdueNoActionRate: number;
    reopenRate: number;
    validityRate: number;
    avgSatisfaction: number;
    satisfactionRate: number;
  };
  trend: {
    previousTotal: number | null;
    growthRate: number | null;
    trendData: { date: string; total: number; closed: number; open: number }[];
  };
  distributions: {
    byRegion: ComplaintGroupMetrics[];
    byFacility: ComplaintGroupMetrics[];
    byDepartment: ComplaintGroupMetrics[];
    byClassification: ComplaintGroupMetrics[];
    byCategory: ComplaintGroupMetrics[];
    byChannel: ComplaintGroupMetrics[];
    byStatus: { name: string; count: number }[];
    byPriority: { name: string; count: number }[];
    bySeverity: { name: string; count: number }[];
    byMonth: { name: string; count: number }[];
  };
  alerts: {
    criticalComplaints: number;
    lateCritical: number;
    missingFields: number;
    dataQualityRate: number;
  };
};

type RawMetrics = {
  totalComplaints: number;
  openComplaints: number;
  closedComplaints: number;
  cancelledComplaints: number;
  currentlyLateComplaints: number;
  closedLateComplaints: number;
  closedWithinDueDate: number;
  withoutDueDate: number;
  unclassifiedComplaints: number;
  highPriorityOpenComplaints: number;
  averageResolutionDays: number;
  medianResolutionDays: number;
  averageOpenAgeDays: number;
  dueDateComplianceRate: number;
  closureRate: number;
  reopenCount: number;
};

export async function getComplaintKpis(params: URLSearchParams, now = new Date()): Promise<ComplaintKpiResult> {
  const query = parseComplaintQuery(params);
  const currentWhere = buildComplaintWhere(query, now);
  const previousWhere = buildPreviousWhere(query, now);
  const [current, previous] = await Promise.all([
    db.complaint.findMany({ where: currentWhere, select: kpiSelect }),
    previousWhere ? db.complaint.findMany({ where: previousWhere, select: kpiSelect }) : Promise.resolve(null),
  ]);
  return buildKpiResult(current, previous, now);
}

function buildPreviousWhere(query: ComplaintQuery, now: Date): Prisma.ComplaintWhereInput | null {
  if (!query.from || !query.to) return null;
  const duration = query.to.getTime() - query.from.getTime();
  if (duration < 0) return null;
  const previousQuery = {
    ...query,
    from: new Date(query.from.getTime() - duration - DAY_MS),
    to: new Date(query.from.getTime() - DAY_MS),
  };
  return buildComplaintWhere(previousQuery, now);
}

function buildKpiResult(current: KpiComplaint[], previous: KpiComplaint[] | null, now: Date): ComplaintKpiResult {
  const currentRaw = calculateRawMetrics(current, now);
  const previousRaw = previous ? calculateRawMetrics(previous, now) : null;
  const kpis = buildKpiValues(currentRaw, previousRaw);
  const closed = current.filter((complaint) => isClosedComplaintStatus(complaint.status));
  const firstResponses = current
    .filter((complaint) => complaint.firstActionAt)
    .map((complaint) => hoursBetween(complaint.complaintDate ?? complaint.receivedAt, complaint.firstActionAt!));
  const processingHours = current
    .filter((complaint) => complaint.processingStartedAt && complaint.closedAt)
    .map((complaint) => hoursBetween(complaint.processingStartedAt!, complaint.closedAt!));
  const satisfaction = current.flatMap((complaint) =>
    complaint.beneficiarySatisfaction === null ? [] : [complaint.beneficiarySatisfaction]
  );

  return {
    kpis,
    volume: {
      total: currentRaw.totalComplaints,
      open: current.filter((complaint) => complaint.status === ComplaintStatus.NEW || complaint.status === ComplaintStatus.OPEN).length,
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
      onTimeRate: currentRaw.dueDateComplianceRate,
      lateRate: rate(currentRaw.currentlyLateComplaints, currentRaw.totalComplaints),
      avgFirstResponseHours: roundToTenth(average(firstResponses)),
      avgProcessingHours: roundToTenth(average(processingHours)),
      avgOpenAgeHours: roundToTenth(currentRaw.averageOpenAgeDays * 24),
      averageResolutionDays: currentRaw.averageResolutionDays,
      medianResolutionDays: currentRaw.medianResolutionDays,
      overdueNoAction: current.filter((complaint) => buildComplaintTiming(complaint, now).isCurrentlyLate && !complaint.firstActionAt).length,
      overdueNoActionRate: rate(
        current.filter((complaint) => buildComplaintTiming(complaint, now).isCurrentlyLate && !complaint.firstActionAt).length,
        currentRaw.totalComplaints
      ),
      reopenRate: rate(currentRaw.reopenCount, currentRaw.closedComplaints + currentRaw.reopenCount),
      validityRate: rate(current.filter((complaint) => complaint.isValidated).length, currentRaw.totalComplaints),
      avgSatisfaction: roundToTenth(average(satisfaction)),
      satisfactionRate: rate(satisfaction.filter((value) => value >= 4).length, satisfaction.length),
    },
    trend: {
      previousTotal: previousRaw?.totalComplaints ?? null,
      growthRate: previousRaw ? percentageChange(currentRaw.totalComplaints, previousRaw.totalComplaints) : null,
      trendData: buildTrend(current, now),
    },
    distributions: buildDistributions(current, now),
    alerts: {
      criticalComplaints: current.filter((complaint) =>
        complaint.priority === ComplaintPriority.CRITICAL || complaint.severity === ComplaintPriority.CRITICAL
      ).length,
      lateCritical: current.filter((complaint) =>
        buildComplaintTiming(complaint, now).isCurrentlyLate
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

function calculateRawMetrics(complaints: KpiComplaint[], now: Date): RawMetrics {
  const timing = complaints.map((complaint) => buildComplaintTiming(complaint, now));
  const resolutionDays = timing.flatMap((item) => item.resolutionDays === null ? [] : [item.resolutionDays]);
  const openAgeDays = timing.flatMap((item) => item.openAgeDays === null ? [] : [item.openAgeDays]);
  const dueClosedDenominator = complaints.filter((complaint) =>
    isClosedComplaintStatus(complaint.status) && complaint.dueDate && complaint.closedAt
  ).length;

  return {
    totalComplaints: complaints.length,
    openComplaints: complaints.filter((complaint) => isOpenComplaintStatus(complaint.status)).length,
    closedComplaints: complaints.filter((complaint) => isClosedComplaintStatus(complaint.status)).length,
    cancelledComplaints: complaints.filter((complaint) => complaint.status === ComplaintStatus.CANCELLED).length,
    currentlyLateComplaints: timing.filter((item) => item.isCurrentlyLate).length,
    closedLateComplaints: timing.filter((item) => item.wasClosedLate).length,
    closedWithinDueDate: timing.filter((item) => item.isClosedWithinDueDate).length,
    withoutDueDate: complaints.filter((complaint) => !complaint.dueDate).length,
    unclassifiedComplaints: complaints.filter((complaint) => !complaint.classificationId).length,
    highPriorityOpenComplaints: complaints.filter((complaint) =>
      isOpenComplaintStatus(complaint.status)
      && (complaint.priority === ComplaintPriority.HIGH || complaint.priority === ComplaintPriority.CRITICAL)
    ).length,
    averageResolutionDays: roundToTenth(average(resolutionDays)),
    medianResolutionDays: roundToTenth(median(resolutionDays)),
    averageOpenAgeDays: roundToTenth(average(openAgeDays)),
    dueDateComplianceRate: rate(timing.filter((item) => item.isClosedWithinDueDate).length, dueClosedDenominator),
    closureRate: rate(complaints.filter((complaint) => isClosedComplaintStatus(complaint.status)).length, complaints.length),
    reopenCount: countReopenTransitions(complaints),
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

function buildKpiValues(current: RawMetrics, previous: RawMetrics | null): ComplaintKpiSummary {
  return Object.fromEntries(
    (Object.keys(current) as Array<keyof RawMetrics>).map((key) => [
      key,
      compareMetric(current[key], previous?.[key] ?? null, negativeWhenHigher(key)),
    ])
  ) as ComplaintKpiSummary;
}

function compareMetric(current: number, previous: number | null, higherIsNegative: boolean): KpiValue {
  const absoluteChange = previous === null ? null : roundToTenth(current - previous);
  const pct = previous === null ? null : percentageChange(current, previous);
  const trend = absoluteChange === null ? "none" : absoluteChange > 0 ? "up" : absoluteChange < 0 ? "down" : "flat";
  const direction = trend === "flat" || trend === "none"
    ? "neutral"
    : (trend === "up") === !higherIsNegative ? "positive" : "negative";
  return { currentValue: current, previousValue: previous, absoluteChange, percentageChange: pct, trend, direction };
}

function negativeWhenHigher(key: keyof RawMetrics): boolean {
  return [
    "currentlyLateComplaints",
    "closedLateComplaints",
    "withoutDueDate",
    "unclassifiedComplaints",
    "averageResolutionDays",
    "medianResolutionDays",
    "averageOpenAgeDays",
  ].includes(key);
}

function buildDistributions(complaints: KpiComplaint[], now: Date): ComplaintKpiResult["distributions"] {
  return {
    byRegion: groupMetrics(complaints, now, (complaint) => ({ name: complaint.region ?? UNSPECIFIED_LABEL })),
    byFacility: groupMetrics(complaints, now, (complaint) => ({ name: complaint.facility ?? UNSPECIFIED_LABEL })),
    byDepartment: groupMetrics(complaints, now, (complaint) => ({ name: complaint.department ?? UNSPECIFIED_LABEL })),
    byClassification: groupMetrics(complaints, now, (complaint) => ({
      id: complaint.classification?.id ?? null,
      name: complaint.classification?.nameAr ?? UNCLASSIFIED_LABEL,
    })),
    byCategory: groupMetrics(complaints, now, (complaint) => ({
      id: complaint.category?.id ?? null,
      name: complaint.category?.nameAr ?? UNCLASSIFIED_LABEL,
    })),
    byChannel: groupMetrics(complaints, now, (complaint) => ({ name: complaint.channel ?? UNSPECIFIED_LABEL })),
    byStatus: groupCount(complaints, (complaint) => complaint.status),
    byPriority: groupCount(complaints, (complaint) => complaint.priority),
    bySeverity: groupCount(complaints, (complaint) => complaint.severity),
    byMonth: groupCount(complaints, (complaint) => monthKey(complaint.complaintDate ?? complaint.receivedAt)),
  };
}

function groupMetrics(
  complaints: KpiComplaint[],
  now: Date,
  keyFn: (complaint: KpiComplaint) => { name: string; id?: string | null }
): ComplaintGroupMetrics[] {
  const map = new Map<string, { id?: string | null; items: KpiComplaint[] }>();
  for (const complaint of complaints) {
    const key = keyFn(complaint);
    const current = map.get(key.name) ?? { id: key.id, items: [] };
    current.items.push(complaint);
    map.set(key.name, current);
  }

  return Array.from(map.entries())
    .map(([name, value]) => {
      const raw = calculateRawMetrics(value.items, now);
      return {
        name,
        id: value.id,
        count: raw.totalComplaints,
        total: raw.totalComplaints,
        open: raw.openComplaints,
        closed: raw.closedComplaints,
        currentlyLate: raw.currentlyLateComplaints,
        closedLate: raw.closedLateComplaints,
        withinDueDate: raw.closedWithinDueDate,
        complianceRate: raw.dueDateComplianceRate,
        averageResolutionDays: raw.averageResolutionDays,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ar"));
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

function buildTrend(complaints: KpiComplaint[], now: Date): { date: string; total: number; closed: number; open: number }[] {
  const start = new Date(now.getTime() - 29 * DAY_MS);
  const result: { date: string; total: number; closed: number; open: number }[] = [];
  for (let i = 0; i < 30; i += 1) {
    const day = new Date(start.getTime() + i * DAY_MS);
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

function hoursBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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
