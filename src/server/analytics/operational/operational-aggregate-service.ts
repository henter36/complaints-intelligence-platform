import type { ComplaintStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildCurrentlyLateWhere } from "@/server/complaints/complaint-query-service";
import {
  CLOSED_COMPLAINT_STATUSES,
  OPEN_COMPLAINT_STATUSES,
} from "@/server/complaints/status";
import { DAY_MS } from "@/server/analytics/operational/operational-freshness";
import {
  OPERATIONAL_UNSPECIFIED,
  OPERATIONAL_UNSPECIFIED_LABEL,
  type OperationalBucketMetrics,
} from "./operational-analytics-types";

export type OperationalDimension =
  | "sourceOrigin"
  | "sourceStatus"
  | "sourceActionStatus";

export type AggregateDimensionRow = {
  key: string;
  count: number;
  open: number;
  closed: number;
  currentlyLate: number;
};

export type ResolutionAggregateInput = {
  sourceOrigin: string | null;
  sourceStatus: string | null;
  sourceActionStatus: string | null;
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date;
};

type StatusGroupRow = {
  dimensionValue: string | null;
  status: ComplaintStatus;
  count: number;
};

type LateGroupRow = {
  dimensionValue: string | null;
  count: number;
};

function emptyStringOrNull(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

export function categoricalKey(value: string | null | undefined): string {
  return emptyStringOrNull(value) ? OPERATIONAL_UNSPECIFIED : value!.trim();
}

export function categoricalLabel(key: string): string {
  return key === OPERATIONAL_UNSPECIFIED ? OPERATIONAL_UNSPECIFIED_LABEL : key;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Matches buildComplaintTiming resolutionDays when closedAt is present:
 * start = complaintDate ?? receivedAt; ceil days floored at 0.
 */
export function resolutionDaysFromDates(
  complaintDate: Date | null,
  receivedAt: Date,
  closedAt: Date
): number {
  const start = complaintDate ?? receivedAt;
  return Math.max(0, Math.ceil((closedAt.getTime() - start.getTime()) / DAY_MS));
}

function emptyAggregate(key: string): AggregateDimensionRow {
  return { key, count: 0, open: 0, closed: 0, currentlyLate: 0 };
}

export function mergeStatusGroupsIntoAggregates(
  groups: readonly StatusGroupRow[]
): Map<string, AggregateDimensionRow> {
  const byKey = new Map<string, AggregateDimensionRow>();
  for (const group of groups) {
    const key = categoricalKey(group.dimensionValue);
    const row = byKey.get(key) ?? emptyAggregate(key);
    row.count += group.count;
    if (OPEN_COMPLAINT_STATUSES.has(group.status)) {
      row.open += group.count;
    }
    if (CLOSED_COMPLAINT_STATUSES.has(group.status)) {
      row.closed += group.count;
    }
    byKey.set(key, row);
  }
  return byKey;
}

export function mergeLateGroupsIntoAggregates(
  aggregates: Map<string, AggregateDimensionRow>,
  lateGroups: readonly LateGroupRow[]
): Map<string, AggregateDimensionRow> {
  for (const group of lateGroups) {
    const key = categoricalKey(group.dimensionValue);
    const row = aggregates.get(key) ?? emptyAggregate(key);
    row.currentlyLate += group.count;
    aggregates.set(key, row);
  }
  return aggregates;
}

export function buildResolutionAverageByDimensions(rows: readonly ResolutionAggregateInput[]): {
  sourceOrigin: Map<string, number>;
  sourceStatus: Map<string, number>;
  sourceActionStatus: Map<string, number>;
} {
  const sums = {
    sourceOrigin: new Map<string, { sum: number; n: number }>(),
    sourceStatus: new Map<string, { sum: number; n: number }>(),
    sourceActionStatus: new Map<string, { sum: number; n: number }>(),
  };

  const add = (
    map: Map<string, { sum: number; n: number }>,
    rawKey: string | null,
    days: number
  ) => {
    const key = categoricalKey(rawKey);
    const entry = map.get(key) ?? { sum: 0, n: 0 };
    entry.sum += days;
    entry.n += 1;
    map.set(key, entry);
  };

  for (const row of rows) {
    const days = resolutionDaysFromDates(row.complaintDate, row.receivedAt, row.closedAt);
    add(sums.sourceOrigin, row.sourceOrigin, days);
    add(sums.sourceStatus, row.sourceStatus, days);
    add(sums.sourceActionStatus, row.sourceActionStatus, days);
  }

  const toAverageMap = (map: Map<string, { sum: number; n: number }>) => {
    const out = new Map<string, number>();
    for (const [key, entry] of map.entries()) {
      if (entry.n <= 0) continue;
      out.set(key, Math.round((entry.sum / entry.n) * 10) / 10);
    }
    return out;
  };

  return {
    sourceOrigin: toAverageMap(sums.sourceOrigin),
    sourceStatus: toAverageMap(sums.sourceStatus),
    sourceActionStatus: toAverageMap(sums.sourceActionStatus),
  };
}

export function buildBucketMetricsFromAggregates(options: {
  dimensionRows: ReadonlyMap<string, AggregateDimensionRow>;
  lateByKey?: ReadonlyMap<string, number>;
  resolutionAverageByKey: ReadonlyMap<string, number>;
  previousByKey: ReadonlyMap<string, number> | null;
  filterKey: string;
  total: number;
}): OperationalBucketMetrics[] {
  const items: OperationalBucketMetrics[] = [];
  for (const [key, row] of options.dimensionRows.entries()) {
    const count = row.count;
    const previousCount = options.previousByKey?.get(key) ?? null;
    const currentlyLate = options.lateByKey?.get(key) ?? row.currentlyLate;
    items.push({
      key,
      label: categoricalLabel(key),
      count,
      percentage: pct(count, options.total),
      open: row.open,
      closed: row.closed,
      currentlyLate,
      averageResolutionDays: options.resolutionAverageByKey.get(key) ?? null,
      previousCount,
      change: previousCount == null ? null : count - previousCount,
      drillDownFilters: { [options.filterKey]: key },
    });
  }
  return items.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ar"));
}

export function countDistinctCategoricalKeys(
  values: ReadonlyArray<string | null>
): number {
  const keys = new Set<string>();
  for (const value of values) {
    keys.add(categoricalKey(value));
  }
  return keys.size;
}

type DimensionField = "sourceOrigin" | "sourceStatus" | "sourceActionStatus";

async function groupByDimensionAndStatus(options: {
  where: Prisma.ComplaintWhereInput;
  field: DimensionField;
}): Promise<StatusGroupRow[]> {
  const groups = await db.complaint.groupBy({
    by: [options.field, "status"],
    where: options.where,
    _count: { _all: true },
  });
  return groups.map((group) => ({
    dimensionValue: group[options.field],
    status: group.status,
    count: group._count._all,
  }));
}

async function groupByDimensionLate(options: {
  where: Prisma.ComplaintWhereInput;
  field: DimensionField;
  now: Date;
}): Promise<LateGroupRow[]> {
  const lateWhere: Prisma.ComplaintWhereInput = {
    AND: [options.where, buildCurrentlyLateWhere(options.now)],
  };
  const groups = await db.complaint.groupBy({
    by: [options.field],
    where: lateWhere,
    _count: { _all: true },
  });
  return groups.map((group) => ({
    dimensionValue: group[options.field],
    count: group._count._all,
  }));
}

function applyLateCounts(
  aggregates: Map<string, AggregateDimensionRow>,
  lateGroups: readonly LateGroupRow[]
): Map<string, AggregateDimensionRow> {
  return mergeLateGroupsIntoAggregates(aggregates, lateGroups);
}

export type AggregatedOperationalDimensions = {
  totalInScope: number;
  sourceOrigin: OperationalBucketMetrics[];
  sourceStatus: OperationalBucketMetrics[];
  sourceActionStatus: OperationalBucketMetrics[];
  channelIndependentCheck: {
    sourceOriginKeys: number;
    channelKeys: number;
    note: string;
  };
  performanceMs: {
    aggregateDimensions: number;
    resolutionRows: number;
    previousPeriod: number;
    sourceOrigin: number;
    sourceStatus: number;
    sourceActionStatus: number;
  };
};

export async function loadAggregatedOperationalDimensions(options: {
  where: Prisma.ComplaintWhereInput;
  previousWhere: Prisma.ComplaintWhereInput | null;
  now: Date;
}): Promise<AggregatedOperationalDimensions> {
  const t0 = performance.now();
  const lateWhereBase = options.where;
  const now = options.now;

  let previousPeriodMs = 0;
  const previousOriginPromise = options.previousWhere
    ? (async () => {
        const started = performance.now();
        const groups = await db.complaint.groupBy({
          by: ["sourceOrigin"],
          where: options.previousWhere!,
          _count: { _all: true },
        });
        previousPeriodMs = Math.round(performance.now() - started);
        return groups;
      })()
    : Promise.resolve([] as Array<{ sourceOrigin: string | null; _count: { _all: number } }>);

  const [
    totalInScope,
    originStatusGroups,
    sourceStatusGroups,
    actionStatusGroups,
    originLateGroups,
    statusLateGroups,
    actionLateGroups,
    channelGroups,
    originKeyGroups,
    previousOriginGroups,
  ] = await Promise.all([
    db.complaint.count({ where: options.where }),
    groupByDimensionAndStatus({ where: options.where, field: "sourceOrigin" }),
    groupByDimensionAndStatus({ where: options.where, field: "sourceStatus" }),
    groupByDimensionAndStatus({ where: options.where, field: "sourceActionStatus" }),
    groupByDimensionLate({ where: lateWhereBase, field: "sourceOrigin", now }),
    groupByDimensionLate({ where: lateWhereBase, field: "sourceStatus", now }),
    groupByDimensionLate({ where: lateWhereBase, field: "sourceActionStatus", now }),
    db.complaint.groupBy({ by: ["channel"], where: options.where, _count: { _all: true } }),
    db.complaint.groupBy({ by: ["sourceOrigin"], where: options.where, _count: { _all: true } }),
    previousOriginPromise,
  ]);
  const aggregateMs = Math.round(performance.now() - t0);

  const tRes0 = performance.now();
  const resolutionRows = await db.complaint.findMany({
    where: {
      AND: [options.where, { closedAt: { not: null } }],
    },
    select: {
      sourceOrigin: true,
      sourceStatus: true,
      sourceActionStatus: true,
      complaintDate: true,
      receivedAt: true,
      closedAt: true,
    },
  });
  const resolutionMs = Math.round(performance.now() - tRes0);

  const resolutionAverages = buildResolutionAverageByDimensions(
    resolutionRows.map((row) => ({
      sourceOrigin: row.sourceOrigin,
      sourceStatus: row.sourceStatus,
      sourceActionStatus: row.sourceActionStatus,
      complaintDate: row.complaintDate,
      receivedAt: row.receivedAt,
      closedAt: row.closedAt as Date,
    }))
  );

  const previousByOrigin = new Map<string, number>();
  for (const row of previousOriginGroups) {
    const key = categoricalKey(row.sourceOrigin);
    previousByOrigin.set(key, (previousByOrigin.get(key) ?? 0) + row._count._all);
  }

  const originAggregates = applyLateCounts(
    mergeStatusGroupsIntoAggregates(originStatusGroups),
    originLateGroups
  );
  const statusAggregates = applyLateCounts(
    mergeStatusGroupsIntoAggregates(sourceStatusGroups),
    statusLateGroups
  );
  const actionAggregates = applyLateCounts(
    mergeStatusGroupsIntoAggregates(actionStatusGroups),
    actionLateGroups
  );

  const tOrigin0 = performance.now();
  const sourceOrigin = buildBucketMetricsFromAggregates({
    dimensionRows: originAggregates,
    resolutionAverageByKey: resolutionAverages.sourceOrigin,
    previousByKey: previousByOrigin.size > 0 ? previousByOrigin : null,
    filterKey: "sourceOrigin",
    total: totalInScope,
  });
  const originMs = Math.round(performance.now() - tOrigin0);

  const tStatus0 = performance.now();
  const sourceStatus = buildBucketMetricsFromAggregates({
    dimensionRows: statusAggregates,
    resolutionAverageByKey: resolutionAverages.sourceStatus,
    previousByKey: null,
    filterKey: "sourceStatus",
    total: totalInScope,
  });
  const statusMs = Math.round(performance.now() - tStatus0);

  const tAction0 = performance.now();
  const sourceActionStatus = buildBucketMetricsFromAggregates({
    dimensionRows: actionAggregates,
    resolutionAverageByKey: resolutionAverages.sourceActionStatus,
    previousByKey: null,
    filterKey: "sourceActionStatus",
    total: totalInScope,
  });
  const actionMs = Math.round(performance.now() - tAction0);

  return {
    totalInScope,
    sourceOrigin,
    sourceStatus,
    sourceActionStatus,
    channelIndependentCheck: {
      sourceOriginKeys: countDistinctCategoricalKeys(
        originKeyGroups.map((row) => row.sourceOrigin)
      ),
      channelKeys: countDistinctCategoricalKeys(channelGroups.map((row) => row.channel)),
      note: "sourceOrigin and channel are independent dimensions; do not merge.",
    },
    performanceMs: {
      aggregateDimensions: aggregateMs,
      resolutionRows: resolutionMs,
      previousPeriod: previousPeriodMs,
      sourceOrigin: originMs,
      sourceStatus: statusMs,
      sourceActionStatus: actionMs,
    },
  };
}
