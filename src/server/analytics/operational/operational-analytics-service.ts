import type { ComplaintStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildComplaintWhere,
  parseComplaintQuery,
} from "@/server/complaints/complaint-query-service";
import { CLOSED_COMPLAINT_STATUSES } from "@/server/complaints/status";
import {
  DAY_MS,
  FRESHNESS_BUCKET_LABELS,
  RIYADH_TZ,
  formatInstantInRiyadh,
  resolveFreshnessBucket,
} from "@/server/analytics/operational/operational-freshness";
import { loadAggregatedFreshnessMetrics } from "./operational-freshness-aggregate-service";
import { loadAggregatedOperationalDimensions } from "./operational-aggregate-service";
import { loadWingOperationalMetrics } from "./operational-wing-aggregate-service";
import {
  buildAggregatedDataQualityCounts,
  loadClosedWithoutClosedAtCount,
  type AggregatedDataQualityCounts,
} from "./operational-data-quality-aggregate-service";
import {
  DATA_FRESHNESS_BUCKETS,
  OPERATIONAL_UNSPECIFIED,
  type ActionTakenQuality,
  type DataFreshnessBucket,
  type DataFreshnessMetrics,
  type OperationalAnalyticsSummary,
  type OperationalDataQualitySignal,
  type SourceStatusDistribution,
  type ActionStatusDistribution,
  type StaffActorMetrics,
} from "./operational-analytics-types";
import {
  buildCurrentOperationalFacilityWhere,
  combineComplaintWhere,
} from "@/server/facilities/facility-operational-scope-service";

const LONG_ACTION_TAKEN_CHARS = 80;
const RARE_SHARE_THRESHOLD = 0.01;

/**
 * Residual metrics still computed in Node: actionTakenQuality, the 3
 * data-quality signals that need per-row text fields
 * (closed_without_source_closed_by / action_taken_without_description /
 * resolution_without_closed), and staffActors. Every other data-quality
 * signal — including the 3 freshness-derived ones and the 7 migrated in
 * Issue #63 phase 4 — is now computed entirely from DB aggregates, so their
 * source columns (id, sourceOrigin, sourceStatus, sourceActionStatus,
 * wingCode, sourceUpdatedAt, sourceModifiedAt, complaintDate, receivedAt,
 * dueDate, closedAt) are deliberately not selected here.
 */
type SlimOperationalRow = {
  status: ComplaintStatus;
  actionTaken: string | null;
  actionDescription: string | null;
  resolution: string | null;
  sourceClosedBy: string | null;
  sourceUpdatedBy: string | null;
};

function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  return fn().then((value) => ({ ms: Math.round(performance.now() - t0), value }));
}

export function normalizeActionTakenKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export {
  resolveFreshnessBucket,
  FRESHNESS_BUCKET_LABELS,
  DAY_MS,
  formatInstantInRiyadh,
} from "./operational-freshness";

function emptyStringOrNull(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function maskActor(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 2) return "**";
  return `${trimmed.slice(0, 1)}***${trimmed.slice(-1)}`;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Narrow select for residual (non-aggregated) metrics only.
 * Migrated dimensions use Prisma groupBy/count — do not interpret loadRows as full analytics I/O.
 */
/** Exported for benchmark/diagnostic field-count reporting only — not a public analytics contract. */
export const RESIDUAL_OPERATIONAL_SELECT = {
  status: true,
  actionTaken: true,
  actionDescription: true,
  resolution: true,
  sourceClosedBy: true,
  sourceUpdatedBy: true,
} satisfies Prisma.ComplaintSelect;

function buildActionTakenQuality(rows: SlimOperationalRow[]): ActionTakenQuality {
  let emptyCount = 0;
  const rawCounts = new Map<string, number>();
  const normalizedToVariants = new Map<string, Map<string, number>>();
  let longText = 0;
  let nonEmpty = 0;

  for (const row of rows) {
    if (emptyStringOrNull(row.actionTaken)) {
      emptyCount += 1;
      continue;
    }
    nonEmpty += 1;
    const raw = row.actionTaken!.trim();
    rawCounts.set(raw, (rawCounts.get(raw) ?? 0) + 1);
    if (raw.length >= LONG_ACTION_TAKEN_CHARS) longText += 1;
    const norm = normalizeActionTakenKey(raw);
    const variants = normalizedToVariants.get(norm) ?? new Map<string, number>();
    variants.set(raw, (variants.get(raw) ?? 0) + 1);
    normalizedToVariants.set(norm, variants);
  }

  const topNormalized = Array.from(normalizedToVariants.entries())
    .map(([normalized, variants]) => {
      const count = Array.from(variants.values()).reduce((s, n) => s + n, 0);
      const label = Array.from(variants.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? normalized;
      return { label, count, percentage: pct(count, nonEmpty || 1) };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const rareCount = Array.from(rawCounts.values()).filter(
    (c) => c / (nonEmpty || 1) < RARE_SHARE_THRESHOLD
  ).length;

  const spellingVariantHints = Array.from(normalizedToVariants.entries())
    .filter(([, variants]) => variants.size > 1)
    .map(([normalized, variants]) => ({
      normalized,
      variants: Array.from(variants.keys()).slice(0, 5),
      totalCount: Array.from(variants.values()).reduce((s, n) => s + n, 0),
    }))
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, 10);

  return {
    nonEmptyCount: nonEmpty,
    emptyCount,
    uniqueCount: rawCounts.size,
    topNormalized,
    rareValueShare: pct(rareCount, rawCounts.size || 1),
    longTextShare: pct(longText, nonEmpty || 1),
    spellingVariantHints,
  };
}

type FreshnessRow = {
  sourceUpdatedAt: Date | null;
  sourceModifiedAt: Date | null;
};

type FreshnessAccumulator = {
  bucketCounts: Record<DataFreshnessBucket, number>;
  ageDaysSum: number;
  ageCount: number;
  missingUpdatedAt: number;
  missingModifiedAt: number;
  modifiedAfterUpdated: number;
  diffHoursSum: number;
  diffCount: number;
  latestUpdatedAt: Date | null;
  oldestUpdatedAt: Date | null;
};

function createFreshnessAccumulator(): FreshnessAccumulator {
  return {
    bucketCounts: Object.fromEntries(DATA_FRESHNESS_BUCKETS.map((bucket) => [bucket, 0])) as Record<
      DataFreshnessBucket,
      number
    >,
    ageDaysSum: 0,
    ageCount: 0,
    missingUpdatedAt: 0,
    missingModifiedAt: 0,
    modifiedAfterUpdated: 0,
    diffHoursSum: 0,
    diffCount: 0,
    latestUpdatedAt: null,
    oldestUpdatedAt: null,
  };
}

function updateUpdatedAtBounds(accumulator: FreshnessAccumulator, value: Date): void {
  if (accumulator.latestUpdatedAt === null || value > accumulator.latestUpdatedAt) {
    accumulator.latestUpdatedAt = value;
  }
  if (accumulator.oldestUpdatedAt === null || value < accumulator.oldestUpdatedAt) {
    accumulator.oldestUpdatedAt = value;
  }
}

function accumulateSourceUpdatedAt(
  accumulator: FreshnessAccumulator,
  sourceUpdatedAt: Date | null,
  now: Date
): void {
  accumulator.bucketCounts[resolveFreshnessBucket(sourceUpdatedAt, now)] += 1;
  if (sourceUpdatedAt === null) {
    accumulator.missingUpdatedAt += 1;
    return;
  }
  accumulator.ageDaysSum += (now.getTime() - sourceUpdatedAt.getTime()) / DAY_MS;
  accumulator.ageCount += 1;
  updateUpdatedAtBounds(accumulator, sourceUpdatedAt);
}

function accumulateSourceModification(
  accumulator: FreshnessAccumulator,
  sourceUpdatedAt: Date | null,
  sourceModifiedAt: Date | null
): void {
  if (sourceModifiedAt === null) {
    accumulator.missingModifiedAt += 1;
    return;
  }
  if (sourceUpdatedAt === null) {
    return;
  }
  accumulator.diffHoursSum +=
    (sourceUpdatedAt.getTime() - sourceModifiedAt.getTime()) / (60 * 60 * 1000);
  accumulator.diffCount += 1;
  if (sourceModifiedAt > sourceUpdatedAt) {
    accumulator.modifiedAfterUpdated += 1;
  }
}

function accumulateFreshnessRow(
  accumulator: FreshnessAccumulator,
  row: FreshnessRow,
  now: Date
): void {
  accumulateSourceUpdatedAt(accumulator, row.sourceUpdatedAt, now);
  accumulateSourceModification(accumulator, row.sourceUpdatedAt, row.sourceModifiedAt);
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function averageOrNull(sum: number, count: number): number | null {
  if (count <= 0) return null;
  return roundToOneDecimal(sum / count);
}

function calculateStaleCount(bucketCounts: Record<DataFreshnessBucket, number>): number {
  return bucketCounts.stale_1_3d + bucketCounts.stale_3_7d + bucketCounts.stale_7d_plus;
}

function buildFreshnessBuckets(
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

function buildFreshnessMetrics(
  accumulator: FreshnessAccumulator,
  total: number
): DataFreshnessMetrics {
  return {
    lastSourceUpdatedAt: accumulator.latestUpdatedAt?.toISOString() ?? null,
    lastSourceUpdatedAtRiyadh: formatInstantInRiyadh(accumulator.latestUpdatedAt),
    oldestSourceUpdatedAt: accumulator.oldestUpdatedAt?.toISOString() ?? null,
    oldestSourceUpdatedAtRiyadh: formatInstantInRiyadh(accumulator.oldestUpdatedAt),
    averageAgeDays: averageOrNull(accumulator.ageDaysSum, accumulator.ageCount),
    freshShare: pct(accumulator.bucketCounts.fresh_1d, total),
    staleShare: pct(calculateStaleCount(accumulator.bucketCounts), total),
    buckets: buildFreshnessBuckets(accumulator.bucketCounts, total),
    missingUpdatedAt: accumulator.missingUpdatedAt,
    missingModifiedAt: accumulator.missingModifiedAt,
    modifiedBeforeUpdated: accumulator.modifiedAfterUpdated,
    updatedVsModifiedDiffHoursAvg: averageOrNull(accumulator.diffHoursSum, accumulator.diffCount),
  };
}

export function buildFreshness(rows: FreshnessRow[], now: Date): DataFreshnessMetrics {
  const accumulator = createFreshnessAccumulator();

  for (const row of rows) {
    accumulateFreshnessRow(accumulator, row, now);
  }

  return buildFreshnessMetrics(accumulator, rows.length);
}

const DATA_QUALITY_SIGNAL_IDS = [
  "missing_source_origin",
  "missing_source_status",
  "missing_source_action_status",
  "missing_wing_code",
  "missing_source_updated_at",
  "missing_source_modified_at",
  "closed_without_closed_at",
  "closed_without_source_closed_by",
  "source_status_vs_internal_mismatch",
  "action_status_vs_closure_mismatch",
  "modified_after_updated",
  "action_taken_without_description",
  "resolution_without_closed",
] as const;

type DataQualitySignalId = (typeof DATA_QUALITY_SIGNAL_IDS)[number];

type DataQualitySignalDefinition = {
  id: DataQualitySignalId;
  label: string;
  severity: OperationalDataQualitySignal["severity"];
  explanation: string;
  drillDownFilters: Record<string, string>;
};

/** Order here is the public, contractual order of OperationalAnalyticsSummary.dataQuality — see the id/order regression test. */
const DATA_QUALITY_SIGNAL_DEFINITIONS: readonly DataQualitySignalDefinition[] = [
  {
    id: "missing_source_origin",
    label: "بلا مصدر ورود",
    severity: "warning",
    explanation: "السجل بلا sourceOrigin بعد الاستيراد.",
    drillDownFilters: { sourceOrigin: OPERATIONAL_UNSPECIFIED },
  },
  {
    id: "missing_source_status",
    label: "بلا حالة مصدرية",
    severity: "warning",
    explanation: "السجل بلا sourceStatus.",
    drillDownFilters: { sourceStatus: OPERATIONAL_UNSPECIFIED },
  },
  {
    id: "missing_source_action_status",
    label: "بلا حالة إجراء مصدرية",
    severity: "info",
    explanation: "السجل بلا sourceActionStatus.",
    drillDownFilters: { sourceActionStatus: OPERATIONAL_UNSPECIFIED },
  },
  {
    id: "missing_wing_code",
    label: "بلا جناح",
    severity: "info",
    explanation: "السجل بلا wingCode.",
    drillDownFilters: { wingCode: OPERATIONAL_UNSPECIFIED },
  },
  {
    id: "missing_source_updated_at",
    label: "بلا تاريخ تحديث مصدر",
    severity: "warning",
    explanation: "السجل بلا sourceUpdatedAt.",
    drillDownFilters: { dataFreshnessBucket: "missing" },
  },
  {
    id: "missing_source_modified_at",
    label: "بلا تاريخ تعديل مصدر",
    severity: "info",
    explanation: "السجل بلا sourceModifiedAt.",
    drillDownFilters: { hasSourceModifiedAt: "false" },
  },
  {
    id: "closed_without_closed_at",
    label: "مغلقة بلا closedAt",
    severity: "critical",
    explanation: "الحالة الداخلية مغلقة دون طابع إغلاق موثوق.",
    drillDownFilters: { isClosed: "true", hasClosedAt: "false" },
  },
  {
    id: "closed_without_source_closed_by",
    label: "مغلقة بلا مصدر إغلاق",
    severity: "warning",
    explanation: "إغلاق داخلي دون sourceClosedBy (لا تُعرض هويات المستخدمين).",
    drillDownFilters: { isClosed: "true" },
  },
  {
    id: "source_status_vs_internal_mismatch",
    label: "تعارض حالة مصدرية/داخلية",
    severity: "warning",
    explanation: "sourceStatus يشير للإغلاق بينما الحالة الداخلية مفتوحة، أو العكس.",
    drillDownFilters: {},
  },
  {
    id: "action_status_vs_closure_mismatch",
    label: "تعارض حالة الإجراء مع الإغلاق",
    severity: "info",
    explanation: "sourceActionStatus ما زال «جديد» رغم الإغلاق الداخلي.",
    drillDownFilters: { sourceActionStatus: "جديد", isClosed: "true" },
  },
  {
    id: "modified_after_updated",
    label: "تعديل مصدر بعد التحديث",
    severity: "warning",
    explanation: "sourceModifiedAt أحدث من sourceUpdatedAt بصورة غير متوقعة.",
    drillDownFilters: {},
  },
  {
    id: "action_taken_without_description",
    label: "إجراء دون وصف",
    severity: "info",
    explanation: "actionTaken موجود بينما actionDescription فارغ.",
    drillDownFilters: { hasActionTaken: "true", hasActionDescription: "false" },
  },
  {
    id: "resolution_without_closed",
    label: "نتيجة دون إغلاق",
    severity: "warning",
    explanation: "resolution موجود والحالة الداخلية غير مغلقة.",
    drillDownFilters: { hasResolution: "true", isClosed: "false" },
  },
];

function buildDataQualitySignal(
  definition: DataQualitySignalDefinition,
  count: number,
  total: number
): OperationalDataQualitySignal {
  return { ...definition, count, percentage: pct(count, total) };
}

/**
 * Row shape needed for the 3 data-quality signals that still require a
 * per-row text-field scan (closed_without_source_closed_by depends on
 * status + sourceClosedBy; the other two on actionTaken/actionDescription/
 * resolution + status). Every other signal is DB-aggregated — see
 * operational-data-quality-aggregate-service.ts.
 */
type ResidualDataQualityRow = {
  status: ComplaintStatus;
  actionTaken: string | null;
  actionDescription: string | null;
  resolution: string | null;
  sourceClosedBy: string | null;
};

type ResidualDataQualityCounts = {
  closedWithoutSourceClosedBy: number;
  actionTakenWithoutDescription: number;
  resolutionWithoutClosed: number;
};

function buildResidualDataQualityCounts(
  rows: readonly ResidualDataQualityRow[]
): ResidualDataQualityCounts {
  let closedWithoutSourceClosedBy = 0;
  let actionTakenWithoutDescription = 0;
  let resolutionWithoutClosed = 0;

  for (const row of rows) {
    const closed = CLOSED_COMPLAINT_STATUSES.has(row.status);
    if (closed && emptyStringOrNull(row.sourceClosedBy)) closedWithoutSourceClosedBy += 1;
    if (!emptyStringOrNull(row.actionTaken) && emptyStringOrNull(row.actionDescription)) {
      actionTakenWithoutDescription += 1;
    }
    if (!emptyStringOrNull(row.resolution) && !closed) resolutionWithoutClosed += 1;
  }

  return { closedWithoutSourceClosedBy, actionTakenWithoutDescription, resolutionWithoutClosed };
}

function dataQualityCountsById(
  aggregated: AggregatedDataQualityCounts,
  residual: ResidualDataQualityCounts
): Record<DataQualitySignalId, number> {
  return {
    missing_source_origin: aggregated.missingSourceOrigin,
    missing_source_status: aggregated.missingSourceStatus,
    missing_source_action_status: aggregated.missingSourceActionStatus,
    missing_wing_code: aggregated.missingWingCode,
    missing_source_updated_at: aggregated.missingSourceUpdatedAt,
    missing_source_modified_at: aggregated.missingSourceModifiedAt,
    closed_without_closed_at: aggregated.closedWithoutClosedAt,
    closed_without_source_closed_by: residual.closedWithoutSourceClosedBy,
    source_status_vs_internal_mismatch: aggregated.sourceStatusVsInternalMismatch,
    action_status_vs_closure_mismatch: aggregated.actionStatusVsClosureMismatch,
    modified_after_updated: aggregated.modifiedAfterUpdated,
    action_taken_without_description: residual.actionTakenWithoutDescription,
    resolution_without_closed: residual.resolutionWithoutClosed,
  };
}

function buildDataQuality(
  aggregated: AggregatedDataQualityCounts,
  residual: ResidualDataQualityCounts,
  total: number
): OperationalDataQualitySignal[] {
  const counts = dataQualityCountsById(aggregated, residual);
  return DATA_QUALITY_SIGNAL_DEFINITIONS.map((definition) =>
    buildDataQualitySignal(definition, counts[definition.id], total)
  );
}

function buildStaffActors(rows: SlimOperationalRow[], enabled: boolean): StaffActorMetrics {
  const emptyClosedBy = rows.filter((r) => emptyStringOrNull(r.sourceClosedBy)).length;
  const emptyUpdatedBy = rows.filter((r) => emptyStringOrNull(r.sourceUpdatedBy)).length;
  if (!enabled) {
    return {
      enabled: false,
      reason: "عرض المستخدمين التشغيليين معطّل افتراضيًا بانتظار صلاحية مصرّحة",
      emptyClosedBy,
      emptyUpdatedBy,
    };
  }

  const closers = new Map<string, number>();
  const updaters = new Map<string, number>();
  for (const row of rows) {
    if (!emptyStringOrNull(row.sourceClosedBy)) {
      const id = row.sourceClosedBy!.trim();
      closers.set(id, (closers.get(id) ?? 0) + 1);
    }
    if (!emptyStringOrNull(row.sourceUpdatedBy)) {
      const id = row.sourceUpdatedBy!.trim();
      updaters.set(id, (updaters.get(id) ?? 0) + 1);
    }
  }

  return {
    enabled: true,
    closers: Array.from(closers.entries())
      .map(([id, closeCount]) => ({ maskedId: maskActor(id), closeCount }))
      .sort((a, b) => b.closeCount - a.closeCount)
      .slice(0, 20),
    updaters: Array.from(updaters.entries())
      .map(([id, updateCount]) => ({ maskedId: maskActor(id), updateCount }))
      .sort((a, b) => b.updateCount - a.updateCount)
      .slice(0, 20),
    emptyClosedBy,
    emptyUpdatedBy,
  };
}

function previousPeriodParams(params: URLSearchParams): URLSearchParams | null {
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) return null;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return null;
  const duration = startOfNextUtcDay(toDate).getTime() - fromDate.getTime();
  const prevToExclusive = fromDate;
  const prevFrom = new Date(prevToExclusive.getTime() - duration);
  const prevToInclusive = new Date(prevToExclusive.getTime() - DAY_MS);
  const next = new URLSearchParams(params);
  next.set("from", prevFrom.toISOString().slice(0, 10));
  next.set("to", prevToInclusive.toISOString().slice(0, 10));
  return next;
}

function startOfNextUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

export async function getOperationalAnalytics(
  params: URLSearchParams,
  options: { now?: Date; includeStaffActors?: boolean } = {}
): Promise<OperationalAnalyticsSummary> {
  const now = options.now ?? new Date();
  const includeStaffActors = options.includeStaffActors === true;

  const query = parseComplaintQuery(params);
  const facilityWhere = await buildCurrentOperationalFacilityWhere();
  const where = combineComplaintWhere(buildComplaintWhere(query, now), facilityWhere);
  const prevParams = previousPeriodParams(params);
  const previousWhere = prevParams
    ? combineComplaintWhere(
        buildComplaintWhere(parseComplaintQuery(prevParams), now),
        facilityWhere
      )
    : null;

  const aggregatedPromise = loadAggregatedOperationalDimensions({ where, previousWhere, now });
  const residualPromise = timed(() =>
    db.complaint.findMany({
      where,
      select: RESIDUAL_OPERATIONAL_SELECT,
    })
  );
  const wingPromise = aggregatedPromise.then((aggregated) =>
    loadWingOperationalMetrics({
      where,
      now,
      total: aggregated.totalInScope,
    })
  );
  // Depends only on totalInScope (for percentages), not on residual rows —
  // starts as soon as aggregatedPromise resolves, in parallel with wing and
  // the residual findMany, never waiting on the latter.
  const freshnessPromise = aggregatedPromise.then((aggregated) =>
    loadAggregatedFreshnessMetrics({
      where,
      now,
      total: aggregated.totalInScope,
    })
  );
  // Depends only on `where` — starts immediately, in parallel with
  // aggregatedPromise/residualPromise, not after dimension aggregation.
  const closedWithoutClosedAtPromise = timed(() => loadClosedWithoutClosedAtCount(where));

  const [aggregated, wingAggregated, freshnessAggregated, residualLoad, closedWithoutClosedAtLoad] =
    await Promise.all([
      aggregatedPromise,
      wingPromise,
      freshnessPromise,
      residualPromise,
      closedWithoutClosedAtPromise,
    ]);

  const rows = residualLoad.value as SlimOperationalRow[];
  const total = aggregated.totalInScope;

  const sourceStatusDistribution: SourceStatusDistribution = {
    items: aggregated.sourceStatus,
    total,
    unspecifiedCount:
      aggregated.sourceStatus.find((i) => i.key === OPERATIONAL_UNSPECIFIED)?.count ?? 0,
  };
  const sourceActionStatusDistribution: ActionStatusDistribution = {
    items: aggregated.sourceActionStatus,
    total,
    unspecifiedCount:
      aggregated.sourceActionStatus.find((i) => i.key === OPERATIONAL_UNSPECIFIED)?.count ?? 0,
  };

  const dataQualityAggregated: AggregatedDataQualityCounts = {
    ...buildAggregatedDataQualityCounts({
      sourceOrigin: aggregated.sourceOrigin,
      sourceStatus: sourceStatusDistribution,
      sourceActionStatus: sourceActionStatusDistribution,
      wing: wingAggregated.metrics,
      closedWithoutClosedAt: closedWithoutClosedAtLoad.value,
    }),
    missingSourceUpdatedAt: freshnessAggregated.metrics.missingUpdatedAt,
    missingSourceModifiedAt: freshnessAggregated.metrics.missingModifiedAt,
    modifiedAfterUpdated: freshnessAggregated.metrics.modifiedBeforeUpdated,
  };

  const actionQualityTimed = await timed(async () => buildActionTakenQuality(rows));
  const qualityTimed = await timed(async () =>
    buildDataQuality(dataQualityAggregated, buildResidualDataQualityCounts(rows), total)
  );
  const staff = buildStaffActors(rows, includeStaffActors);

  return {
    totalInScope: total,
    generatedAt: now.toISOString(),
    timezoneDisplay: RIYADH_TZ,
    sourceOrigin: { items: aggregated.sourceOrigin, total },
    sourceStatus: sourceStatusDistribution,
    sourceActionStatus: sourceActionStatusDistribution,
    channelIndependentCheck: aggregated.channelIndependentCheck,
    actionTakenQuality: actionQualityTimed.value,
    wing: wingAggregated.metrics,
    freshness: freshnessAggregated.metrics,
    dataQuality: qualityTimed.value,
    staffActors: staff,
    performanceMs: {
      // Time to load residual rows only (actionTaken/quality/staff) — not full analytics I/O.
      loadRows: residualLoad.ms,
      previousPeriod: aggregated.performanceMs.previousPeriod,
      sourceOrigin: aggregated.performanceMs.sourceOrigin,
      sourceStatus: aggregated.performanceMs.sourceStatus,
      sourceActionStatus: aggregated.performanceMs.sourceActionStatus,
      // Wing and freshness metrics now come from DB aggregates (not residual row scan).
      wingCode: wingAggregated.performanceMs,
      freshness: freshnessAggregated.performanceMs,
      actionTakenQuality: actionQualityTimed.ms,
      // Pure in-memory signal building only — the one new DB query's own
      // time is reported separately as dataQualityAggregate.
      dataQuality: qualityTimed.ms,
      dataQualityAggregate: closedWithoutClosedAtLoad.ms,
      aggregateDimensions: aggregated.performanceMs.aggregateDimensions,
      resolutionRows: aggregated.performanceMs.resolutionRows,
      residualRows: residualLoad.ms,
      wingAggregate: wingAggregated.performanceMs,
    },
  };
}
