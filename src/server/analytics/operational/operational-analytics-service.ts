import type { ComplaintStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildComplaintWhere,
  parseComplaintQuery,
} from "@/server/complaints/complaint-query-service";
import {
  CLOSED_COMPLAINT_STATUSES,
  OPEN_COMPLAINT_STATUSES,
} from "@/server/complaints/status";
import {
  DAY_MS,
  FRESHNESS_BUCKET_LABELS,
  resolveFreshnessBucket,
} from "@/server/analytics/operational/operational-freshness";
import { loadAggregatedOperationalDimensions } from "./operational-aggregate-service";
import { loadWingOperationalMetrics } from "./operational-wing-aggregate-service";
import {
  DATA_FRESHNESS_BUCKETS,
  OPERATIONAL_UNSPECIFIED,
  OPERATIONAL_UNSPECIFIED_LABEL,
  type ActionTakenQuality,
  type DataFreshnessBucket,
  type DataFreshnessMetrics,
  type OperationalAnalyticsSummary,
  type OperationalDataQualitySignal,
  type StaffActorMetrics,
} from "./operational-analytics-types";

const LONG_ACTION_TAKEN_CHARS = 80;
const RARE_SHARE_THRESHOLD = 0.01;
const RIYADH_TZ = "Asia/Riyadh";

/** Residual metrics still computed in Node (freshness/actionTaken/dataQuality/staff). */
type SlimOperationalRow = {
  id: string;
  status: ComplaintStatus;
  sourceOrigin: string | null;
  sourceStatus: string | null;
  sourceActionStatus: string | null;
  wingCode: string | null;
  actionTaken: string | null;
  actionDescription: string | null;
  resolution: string | null;
  sourceUpdatedAt: Date | null;
  sourceModifiedAt: Date | null;
  sourceClosedBy: string | null;
  sourceUpdatedBy: string | null;
  complaintDate: Date | null;
  receivedAt: Date;
  dueDate: Date | null;
  closedAt: Date | null;
};

function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  return fn().then((value) => ({ ms: Math.round(performance.now() - t0), value }));
}

export function normalizeOperationalLabel(value: string | null | undefined): string {
  if (value == null) return OPERATIONAL_UNSPECIFIED_LABEL;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? OPERATIONAL_UNSPECIFIED_LABEL : trimmed;
}

export function normalizeActionTakenKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function formatInstantInRiyadh(value: Date | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: RIYADH_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

export { resolveFreshnessBucket, FRESHNESS_BUCKET_LABELS, DAY_MS } from "./operational-freshness";

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
const RESIDUAL_OPERATIONAL_SELECT = {
  id: true,
  status: true,
  sourceOrigin: true,
  sourceStatus: true,
  sourceActionStatus: true,
  wingCode: true,
  actionTaken: true,
  actionDescription: true,
  resolution: true,
  sourceUpdatedAt: true,
  sourceModifiedAt: true,
  sourceClosedBy: true,
  sourceUpdatedBy: true,
  complaintDate: true,
  receivedAt: true,
  dueDate: true,
  closedAt: true,
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

function buildDataQuality(rows: SlimOperationalRow[], total: number): OperationalDataQualitySignal[] {
  const closed = (r: SlimOperationalRow) => CLOSED_COMPLAINT_STATUSES.has(r.status);
  type SignalDef = Omit<OperationalDataQualitySignal, "percentage" | "count"> & {
    test: (r: SlimOperationalRow) => boolean;
    count: number;
  };

  const signals: SignalDef[] = [
    {
      id: "missing_source_origin",
      label: "بلا مصدر ورود",
      severity: "warning",
      explanation: "السجل بلا sourceOrigin بعد الاستيراد.",
      drillDownFilters: { sourceOrigin: OPERATIONAL_UNSPECIFIED },
      test: (r) => emptyStringOrNull(r.sourceOrigin),
      count: 0,
    },
    {
      id: "missing_source_status",
      label: "بلا حالة مصدرية",
      severity: "warning",
      explanation: "السجل بلا sourceStatus.",
      drillDownFilters: { sourceStatus: OPERATIONAL_UNSPECIFIED },
      test: (r) => emptyStringOrNull(r.sourceStatus),
      count: 0,
    },
    {
      id: "missing_source_action_status",
      label: "بلا حالة إجراء مصدرية",
      severity: "info",
      explanation: "السجل بلا sourceActionStatus.",
      drillDownFilters: { sourceActionStatus: OPERATIONAL_UNSPECIFIED },
      test: (r) => emptyStringOrNull(r.sourceActionStatus),
      count: 0,
    },
    {
      id: "missing_wing_code",
      label: "بلا جناح",
      severity: "info",
      explanation: "السجل بلا wingCode.",
      drillDownFilters: { wingCode: OPERATIONAL_UNSPECIFIED },
      test: (r) => emptyStringOrNull(r.wingCode),
      count: 0,
    },
    {
      id: "missing_source_updated_at",
      label: "بلا تاريخ تحديث مصدر",
      severity: "warning",
      explanation: "السجل بلا sourceUpdatedAt.",
      drillDownFilters: { dataFreshnessBucket: "missing" },
      test: (r) => r.sourceUpdatedAt == null,
      count: 0,
    },
    {
      id: "missing_source_modified_at",
      label: "بلا تاريخ تعديل مصدر",
      severity: "info",
      explanation: "السجل بلا sourceModifiedAt.",
      drillDownFilters: { hasSourceModifiedAt: "false" },
      test: (r) => r.sourceModifiedAt == null,
      count: 0,
    },
    {
      id: "closed_without_closed_at",
      label: "مغلقة بلا closedAt",
      severity: "critical",
      explanation: "الحالة الداخلية مغلقة دون طابع إغلاق موثوق.",
      drillDownFilters: { isClosed: "true", hasClosedAt: "false" },
      test: (r) => closed(r) && r.closedAt == null,
      count: 0,
    },
    {
      id: "closed_without_source_closed_by",
      label: "مغلقة بلا مصدر إغلاق",
      severity: "warning",
      explanation: "إغلاق داخلي دون sourceClosedBy (لا تُعرض هويات المستخدمين).",
      drillDownFilters: { isClosed: "true" },
      test: (r) => closed(r) && emptyStringOrNull(r.sourceClosedBy),
      count: 0,
    },
    {
      id: "source_status_vs_internal_mismatch",
      label: "تعارض حالة مصدرية/داخلية",
      severity: "warning",
      explanation: "sourceStatus يشير للإغلاق بينما الحالة الداخلية مفتوحة، أو العكس.",
      drillDownFilters: {},
      test: (r) => {
        if (emptyStringOrNull(r.sourceStatus)) return false;
        const src = r.sourceStatus!.trim();
        const looksClosed = /مغلق|مغلقة|closed/i.test(src);
        const looksOpen = /مبدئي|جديد|مفتوح|open|progress|إرسال/i.test(src);
        if (looksClosed && OPEN_COMPLAINT_STATUSES.has(r.status)) return true;
        if (looksOpen && CLOSED_COMPLAINT_STATUSES.has(r.status)) return true;
        return false;
      },
      count: 0,
    },
    {
      id: "action_status_vs_closure_mismatch",
      label: "تعارض حالة الإجراء مع الإغلاق",
      severity: "info",
      explanation: "sourceActionStatus ما زال «جديد» رغم الإغلاق الداخلي.",
      drillDownFilters: { sourceActionStatus: "جديد", isClosed: "true" },
      test: (r) => closed(r) && normalizeOperationalLabel(r.sourceActionStatus) === "جديد",
      count: 0,
    },
    {
      id: "modified_after_updated",
      label: "تعديل مصدر بعد التحديث",
      severity: "warning",
      explanation: "sourceModifiedAt أحدث من sourceUpdatedAt بصورة غير متوقعة.",
      drillDownFilters: {},
      test: (r) =>
        Boolean(r.sourceUpdatedAt && r.sourceModifiedAt && r.sourceModifiedAt > r.sourceUpdatedAt),
      count: 0,
    },
    {
      id: "action_taken_without_description",
      label: "إجراء دون وصف",
      severity: "info",
      explanation: "actionTaken موجود بينما actionDescription فارغ.",
      drillDownFilters: { hasActionTaken: "true", hasActionDescription: "false" },
      test: (r) => !emptyStringOrNull(r.actionTaken) && emptyStringOrNull(r.actionDescription),
      count: 0,
    },
    {
      id: "resolution_without_closed",
      label: "نتيجة دون إغلاق",
      severity: "warning",
      explanation: "resolution موجود والحالة الداخلية غير مغلقة.",
      drillDownFilters: { hasResolution: "true", isClosed: "false" },
      test: (r) => !emptyStringOrNull(r.resolution) && !closed(r),
      count: 0,
    },
  ];

  for (const row of rows) {
    for (const signal of signals) {
      if (signal.test(row)) signal.count += 1;
    }
  }

  return signals.map(({ test: _test, ...rest }) => ({
    ...rest,
    percentage: pct(rest.count, total),
  }));
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
  const where = buildComplaintWhere(query, now);
  const prevParams = previousPeriodParams(params);
  const previousWhere = prevParams
    ? buildComplaintWhere(parseComplaintQuery(prevParams), now)
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

  const [aggregated, wingAggregated, residualLoad] = await Promise.all([
    aggregatedPromise,
    wingPromise,
    residualPromise,
  ]);

  const rows = residualLoad.value as SlimOperationalRow[];
  const total = aggregated.totalInScope;

  const freshnessTimed = await timed(async () => buildFreshness(rows, now));
  const actionQualityTimed = await timed(async () => buildActionTakenQuality(rows));
  const qualityTimed = await timed(async () => buildDataQuality(rows, total));
  const staff = buildStaffActors(rows, includeStaffActors);

  return {
    totalInScope: total,
    generatedAt: now.toISOString(),
    timezoneDisplay: RIYADH_TZ,
    sourceOrigin: { items: aggregated.sourceOrigin, total },
    sourceStatus: {
      items: aggregated.sourceStatus,
      total,
      unspecifiedCount:
        aggregated.sourceStatus.find((i) => i.key === OPERATIONAL_UNSPECIFIED)?.count ?? 0,
    },
    sourceActionStatus: {
      items: aggregated.sourceActionStatus,
      total,
      unspecifiedCount:
        aggregated.sourceActionStatus.find((i) => i.key === OPERATIONAL_UNSPECIFIED)?.count ?? 0,
    },
    channelIndependentCheck: aggregated.channelIndependentCheck,
    actionTakenQuality: actionQualityTimed.value,
    wing: wingAggregated.metrics,
    freshness: freshnessTimed.value,
    dataQuality: qualityTimed.value,
    staffActors: staff,
    performanceMs: {
      // Time to load residual rows only (freshness/quality/staff) — not full analytics I/O.
      loadRows: residualLoad.ms,
      previousPeriod: aggregated.performanceMs.previousPeriod,
      sourceOrigin: aggregated.performanceMs.sourceOrigin,
      sourceStatus: aggregated.performanceMs.sourceStatus,
      sourceActionStatus: aggregated.performanceMs.sourceActionStatus,
      // Wing metrics now come from DB aggregates (not residual row scan).
      wingCode: wingAggregated.performanceMs,
      freshness: freshnessTimed.ms,
      actionTakenQuality: actionQualityTimed.ms,
      dataQuality: qualityTimed.ms,
      aggregateDimensions: aggregated.performanceMs.aggregateDimensions,
      resolutionRows: aggregated.performanceMs.resolutionRows,
      residualRows: residualLoad.ms,
      wingAggregate: wingAggregated.performanceMs,
    },
  };
}
