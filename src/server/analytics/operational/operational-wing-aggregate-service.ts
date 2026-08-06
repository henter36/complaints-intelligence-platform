import type { ComplaintStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildCurrentlyLateWhere } from "@/server/complaints/complaint-query-service";
import {
  CLOSED_COMPLAINT_STATUSES,
  OPEN_COMPLAINT_STATUSES,
} from "@/server/complaints/status";
import {
  categoricalKey,
  categoricalLabel,
} from "./operational-aggregate-service";
import {
  OPERATIONAL_UNSPECIFIED,
  type WingOperationalMetrics,
} from "./operational-analytics-types";

const WING_ITEMS_LIMIT = 40;

type WingStatusGroup = {
  wingCode: string | null;
  status: ComplaintStatus;
  count: number;
};

type WingLateGroup = {
  wingCode: string | null;
  count: number;
};

type WingClassificationGroup = {
  wingCode: string | null;
  classificationId: string | null;
  count: number;
};

type WingBucketAccumulator = {
  key: string;
  count: number;
  open: number;
  closed: number;
  currentlyLate: number;
  classificationCounts: Map<string, number>;
};

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function emptyWingBucket(key: string): WingBucketAccumulator {
  return {
    key,
    count: 0,
    open: 0,
    closed: 0,
    currentlyLate: 0,
    classificationCounts: new Map(),
  };
}

export function mergeWingStatusGroups(
  groups: readonly WingStatusGroup[]
): Map<string, WingBucketAccumulator> {
  const byKey = new Map<string, WingBucketAccumulator>();
  for (const group of groups) {
    const key = categoricalKey(group.wingCode);
    const row = byKey.get(key) ?? emptyWingBucket(key);
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

export function applyWingLateGroups(
  buckets: Map<string, WingBucketAccumulator>,
  lateGroups: readonly WingLateGroup[]
): Map<string, WingBucketAccumulator> {
  for (const group of lateGroups) {
    const key = categoricalKey(group.wingCode);
    const row = buckets.get(key) ?? emptyWingBucket(key);
    row.currentlyLate += group.count;
    buckets.set(key, row);
  }
  return buckets;
}

export function applyWingClassificationGroups(
  buckets: Map<string, WingBucketAccumulator>,
  classificationGroups: readonly WingClassificationGroup[]
): Set<string> {
  const classificationIds = new Set<string>();
  for (const group of classificationGroups) {
    if (group.classificationId == null) continue;
    classificationIds.add(group.classificationId);
    const key = categoricalKey(group.wingCode);
    const row = buckets.get(key) ?? emptyWingBucket(key);
    row.classificationCounts.set(
      group.classificationId,
      (row.classificationCounts.get(group.classificationId) ?? 0) + group.count
    );
    buckets.set(key, row);
  }
  return classificationIds;
}

export function pickTopClassification(options: {
  classificationCounts: ReadonlyMap<string, number>;
  namesById: ReadonlyMap<string, string>;
}): { topClassification: string | null; topClassificationCount: number } {
  let bestId: string | null = null;
  let bestCount = 0;
  let bestName = "";

  for (const [classificationId, count] of options.classificationCounts.entries()) {
    const nameAr = options.namesById.get(classificationId);
    if (!nameAr) continue;

    if (
      bestId == null
      || count > bestCount
      || (count === bestCount && nameAr.localeCompare(bestName, "ar") < 0)
      || (count === bestCount
        && nameAr.localeCompare(bestName, "ar") === 0
        && classificationId.localeCompare(bestId) < 0)
    ) {
      bestId = classificationId;
      bestCount = count;
      bestName = nameAr;
    }
  }

  if (bestId == null) {
    return { topClassification: null, topClassificationCount: 0 };
  }
  return { topClassification: bestName, topClassificationCount: bestCount };
}

export function buildWingMetricsFromAggregates(options: {
  buckets: ReadonlyMap<string, WingBucketAccumulator>;
  namesById: ReadonlyMap<string, string>;
  total: number;
}): WingOperationalMetrics {
  const unspecifiedCount = options.buckets.get(OPERATIONAL_UNSPECIFIED)?.count ?? 0;

  const items = Array.from(options.buckets.entries())
    .filter(([key]) => key !== OPERATIONAL_UNSPECIFIED)
    .map(([key, bucket]) => {
      const top = pickTopClassification({
        classificationCounts: bucket.classificationCounts,
        namesById: options.namesById,
      });
      return {
        key,
        label: categoricalLabel(key),
        count: bucket.count,
        percentage: pct(bucket.count, options.total),
        open: bucket.open,
        closed: bucket.closed,
        currentlyLate: bucket.currentlyLate,
        topClassification: top.topClassification,
        topClassificationCount: top.topClassificationCount,
        drillDownFilters: { wingCode: key },
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ar"))
    .slice(0, WING_ITEMS_LIMIT);

  return {
    items,
    unspecifiedCount,
    total: options.total,
  };
}

export async function loadWingOperationalMetrics(options: {
  where: Prisma.ComplaintWhereInput;
  now: Date;
  total: number;
}): Promise<{
  metrics: WingOperationalMetrics;
  performanceMs: number;
}> {
  const t0 = performance.now();

  const [statusGroupsRaw, lateGroupsRaw, classificationGroupsRaw] = await Promise.all([
    db.complaint.groupBy({
      by: ["wingCode", "status"],
      where: options.where,
      _count: { _all: true },
    }),
    db.complaint.groupBy({
      by: ["wingCode"],
      where: {
        AND: [options.where, buildCurrentlyLateWhere(options.now)],
      },
      _count: { _all: true },
    }),
    db.complaint.groupBy({
      by: ["wingCode", "classificationId"],
      where: options.where,
      _count: { _all: true },
    }),
  ]);

  const statusGroups: WingStatusGroup[] = statusGroupsRaw.map((row) => ({
    wingCode: row.wingCode,
    status: row.status,
    count: row._count._all,
  }));
  const lateGroups: WingLateGroup[] = lateGroupsRaw.map((row) => ({
    wingCode: row.wingCode,
    count: row._count._all,
  }));
  const classificationGroups: WingClassificationGroup[] = classificationGroupsRaw.map((row) => ({
    wingCode: row.wingCode,
    classificationId: row.classificationId,
    count: row._count._all,
  }));

  const buckets = applyWingLateGroups(mergeWingStatusGroups(statusGroups), lateGroups);
  const classificationIds = applyWingClassificationGroups(buckets, classificationGroups);

  const namesById = new Map<string, string>();
  if (classificationIds.size > 0) {
    const classifications = await db.classification.findMany({
      where: { id: { in: [...classificationIds] } },
      select: { id: true, nameAr: true },
    });
    for (const classification of classifications) {
      namesById.set(classification.id, classification.nameAr);
    }
  }

  const metrics = buildWingMetricsFromAggregates({
    buckets,
    namesById,
    total: options.total,
  });

  return {
    metrics,
    performanceMs: Math.round(performance.now() - t0),
  };
}
