import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  DAY_MS,
  FRESHNESS_BUCKET_LABELS,
  formatInstantInRiyadh,
  freshnessBucketWhere,
} from "@/server/analytics/operational/operational-freshness";
import {
  DATA_FRESHNESS_BUCKETS,
  type DataFreshnessBucket,
  type DataFreshnessMetrics,
} from "@/server/analytics/operational/operational-analytics-types";

const HOUR_MS = 60 * 60 * 1000;

/** Narrow client shape so tests can inject a query-instrumented PrismaClient without changing production callers. */
export type FreshnessDbClient = Pick<typeof db, "complaint">;

export type AggregatedFreshnessResult = {
  metrics: DataFreshnessMetrics;
  performanceMs: number;
  prismaQueries: number;
  /**
   * Diagnostics only — for the benchmark script and cardinality monitoring,
   * never surfaced through OperationalAnalyticsSummary. groupBy on
   * timestamps can, in the worst case, approach the row count; these counts
   * let a caller notice that before it becomes a memory/time regression.
   */
  updatedTimestampGroupCount: number;
  updatedModifiedPairGroupCount: number;
};

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Combines two where clauses via an explicit AND array. A naive
 * `{ ...baseWhere, ...condition }` spread can silently drop or overwrite an
 * existing top-level AND/OR/NOT on `baseWhere` — wrapping both as elements
 * of one AND array keeps every existing constraint (including filters
 * already applied by buildComplaintWhere, such as a `dataFreshnessBucket`
 * scoping the request itself) intact.
 */
function andWhere(
  baseWhere: Prisma.ComplaintWhereInput,
  condition: Prisma.ComplaintWhereInput
): Prisma.ComplaintWhereInput {
  return {
    AND: [baseWhere, condition],
  };
}

function calculateStaleCount(bucketCounts: Record<DataFreshnessBucket, number>): number {
  return bucketCounts.stale_1_3d + bucketCounts.stale_3_7d + bucketCounts.stale_7d_plus;
}

export function buildFreshnessBuckets(
  bucketCounts: Record<DataFreshnessBucket, number>,
  total: number
): DataFreshnessMetrics["buckets"] {
  return DATA_FRESHNESS_BUCKETS.map((bucket) => ({
    bucket,
    label: FRESHNESS_BUCKET_LABELS[bucket],
    count: bucketCounts[bucket],
    percentage: pct(bucketCounts[bucket], total),
    drillDownFilters: { dataFreshnessBucket: bucket },
  }));
}

type SourceUpdatedGroup = {
  sourceUpdatedAt: Date | null;
  _count: { _all: number };
};

/**
 * Weighted by actual complaint count per distinct timestamp — never an
 * unweighted average of group averages. Groups with an invalid Date (should
 * not occur from Prisma DateTime columns, but guarded for unit-test safety)
 * are skipped rather than allowed to poison the sum with NaN.
 */
export function calculateWeightedAverageAgeDays(
  groups: readonly SourceUpdatedGroup[],
  now: Date
): { averageAgeDays: number | null; latest: Date | null; oldest: Date | null } {
  let weightedAgeDaysSum = 0;
  let totalCount = 0;
  let latest: Date | null = null;
  let oldest: Date | null = null;

  for (const group of groups) {
    const value = group.sourceUpdatedAt;
    if (value === null) continue;
    const ageMs = now.getTime() - value.getTime();
    if (!Number.isFinite(ageMs)) continue;
    const count = group._count._all;

    weightedAgeDaysSum += (ageMs / DAY_MS) * count;
    totalCount += count;

    if (latest === null || value > latest) latest = value;
    if (oldest === null || value < oldest) oldest = value;
  }

  return {
    averageAgeDays: totalCount > 0 ? roundToOneDecimal(weightedAgeDaysSum / totalCount) : null,
    latest,
    oldest,
  };
}

type UpdatedModifiedPairGroup = {
  sourceUpdatedAt: Date | null;
  sourceModifiedAt: Date | null;
  _count: { _all: number };
};

/**
 * `modifiedBeforeUpdated` keeps its historical name for contract stability
 * (see DataFreshnessMetrics) even though it counts the opposite condition:
 * sourceModifiedAt > sourceUpdatedAt (the source was modified *after* the
 * update timestamp). Renaming it is out of scope for this performance-only
 * migration.
 */
export function calculateUpdatedModifiedDiagnostics(
  groups: readonly UpdatedModifiedPairGroup[]
): { modifiedBeforeUpdated: number; updatedVsModifiedDiffHoursAvg: number | null } {
  let modifiedBeforeUpdated = 0;
  let weightedDiffHoursSum = 0;
  let totalCount = 0;

  for (const group of groups) {
    const { sourceUpdatedAt, sourceModifiedAt } = group;
    if (sourceUpdatedAt === null || sourceModifiedAt === null) continue;
    const diffMs = sourceUpdatedAt.getTime() - sourceModifiedAt.getTime();
    if (!Number.isFinite(diffMs)) continue;
    const count = group._count._all;

    // Sign preserved deliberately — a negative average means sourceModifiedAt
    // trends newer than sourceUpdatedAt across the scope. Never abs()'d.
    weightedDiffHoursSum += (diffMs / HOUR_MS) * count;
    totalCount += count;

    if (sourceModifiedAt > sourceUpdatedAt) {
      modifiedBeforeUpdated += count;
    }
  }

  return {
    modifiedBeforeUpdated,
    updatedVsModifiedDiffHoursAvg:
      totalCount > 0 ? roundToOneDecimal(weightedDiffHoursSum / totalCount) : null,
  };
}

export function buildFreshnessMetricsFromAggregates(options: {
  bucketCounts: Record<DataFreshnessBucket, number>;
  total: number;
  latest: Date | null;
  oldest: Date | null;
  averageAgeDays: number | null;
  missingModifiedAt: number;
  modifiedBeforeUpdated: number;
  updatedVsModifiedDiffHoursAvg: number | null;
}): DataFreshnessMetrics {
  return {
    lastSourceUpdatedAt: options.latest?.toISOString() ?? null,
    lastSourceUpdatedAtRiyadh: formatInstantInRiyadh(options.latest),
    oldestSourceUpdatedAt: options.oldest?.toISOString() ?? null,
    oldestSourceUpdatedAtRiyadh: formatInstantInRiyadh(options.oldest),
    averageAgeDays: options.averageAgeDays,
    freshShare: pct(options.bucketCounts.fresh_1d, options.total),
    staleShare: pct(calculateStaleCount(options.bucketCounts), options.total),
    buckets: buildFreshnessBuckets(options.bucketCounts, options.total),
    missingUpdatedAt: options.bucketCounts.missing,
    missingModifiedAt: options.missingModifiedAt,
    modifiedBeforeUpdated: options.modifiedBeforeUpdated,
    updatedVsModifiedDiffHoursAvg: options.updatedVsModifiedDiffHoursAvg,
  };
}

/**
 * Loads DataFreshnessMetrics entirely from database aggregates — no
 * Complaint rows are ever loaded into Node for this computation. Query
 * shape is fixed regardless of row count: 5 bucket counts (one per
 * DATA_FRESHNESS_BUCKETS entry) + 1 missingModifiedAt count + 2 groupBy
 * queries (sourceUpdatedAt alone, and the sourceUpdatedAt/sourceModifiedAt
 * pair) = 8 queries, all issued in parallel.
 */
export async function loadAggregatedFreshnessMetrics(
  options: {
    where: Prisma.ComplaintWhereInput;
    now: Date;
    total: number;
  },
  client: FreshnessDbClient = db
): Promise<AggregatedFreshnessResult> {
  const t0 = performance.now();

  const bucketCountPromises = DATA_FRESHNESS_BUCKETS.map((bucket) =>
    client.complaint.count({
      where: andWhere(options.where, freshnessBucketWhere(bucket, options.now)),
    })
  );

  const missingModifiedAtPromise = client.complaint.count({
    where: andWhere(options.where, { sourceModifiedAt: null }),
  });

  const updatedGroupsPromise = client.complaint.groupBy({
    by: ["sourceUpdatedAt"],
    where: andWhere(options.where, { sourceUpdatedAt: { not: null } }),
    _count: { _all: true },
  });

  const pairGroupsPromise = client.complaint.groupBy({
    by: ["sourceUpdatedAt", "sourceModifiedAt"],
    where: andWhere(options.where, {
      AND: [{ sourceUpdatedAt: { not: null } }, { sourceModifiedAt: { not: null } }],
    }),
    _count: { _all: true },
  });

  const [bucketCountsArray, missingModifiedAt, updatedGroups, pairGroups] = await Promise.all([
    Promise.all(bucketCountPromises),
    missingModifiedAtPromise,
    updatedGroupsPromise,
    pairGroupsPromise,
  ]);

  // Fixed by construction: DATA_FRESHNESS_BUCKETS.length count queries, plus
  // missingModifiedAt, plus the two groupBy queries — never grows with rows,
  // regions, departments, or any other dynamic dimension.
  const prismaQueries = bucketCountPromises.length + 1 + 1 + 1;

  const bucketCounts = Object.fromEntries(
    DATA_FRESHNESS_BUCKETS.map((bucket, index) => [bucket, bucketCountsArray[index]])
  ) as Record<DataFreshnessBucket, number>;

  const { averageAgeDays, latest, oldest } = calculateWeightedAverageAgeDays(
    updatedGroups,
    options.now
  );
  const { modifiedBeforeUpdated, updatedVsModifiedDiffHoursAvg } =
    calculateUpdatedModifiedDiagnostics(pairGroups);

  const metrics = buildFreshnessMetricsFromAggregates({
    bucketCounts,
    total: options.total,
    latest,
    oldest,
    averageAgeDays,
    missingModifiedAt,
    modifiedBeforeUpdated,
    updatedVsModifiedDiffHoursAvg,
  });

  return {
    metrics,
    performanceMs: Math.round(performance.now() - t0),
    prismaQueries,
    updatedTimestampGroupCount: updatedGroups.length,
    updatedModifiedPairGroupCount: pairGroups.length,
  };
}
