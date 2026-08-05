import type { ComplaintStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildComplaintWhere,
  parseComplaintQuery,
} from "@/server/complaints/complaint-query-service";
import { buildComplaintTiming } from "@/server/complaints/complaint-timing";
import {
  CLOSED_COMPLAINT_STATUSES,
  OPEN_COMPLAINT_STATUSES,
} from "@/server/complaints/status";
import {
  DATA_FRESHNESS_BUCKETS,
  OPERATIONAL_UNSPECIFIED,
  OPERATIONAL_UNSPECIFIED_LABEL,
  type ActionTakenQuality,
  type DataFreshnessBucket,
  type DataFreshnessMetrics,
  type OperationalAnalyticsSummary,
  type OperationalBucketMetrics,
  type OperationalDataQualitySignal,
  type StaffActorMetrics,
  type WingOperationalMetrics,
} from "./operational-analytics-types";

const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_ACTION_TAKEN_CHARS = 80;
const RARE_SHARE_THRESHOLD = 0.01;
const RIYADH_TZ = "Asia/Riyadh";

type SlimOperationalRow = {
  id: string;
  status: ComplaintStatus;
  channel: string | null;
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
  classification: { nameAr: string } | null;
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

export function resolveFreshnessBucket(
  sourceUpdatedAt: Date | null,
  now: Date
): DataFreshnessBucket {
  if (!sourceUpdatedAt) return "missing";
  const ageMs = now.getTime() - sourceUpdatedAt.getTime();
  if (ageMs < DAY_MS) return "fresh_1d";
  if (ageMs < 3 * DAY_MS) return "stale_1_3d";
  if (ageMs < 7 * DAY_MS) return "stale_3_7d";
  return "stale_7d_plus";
}

export const FRESHNESS_BUCKET_LABELS: Record<DataFreshnessBucket, string> = {
  fresh_1d: "خلال يوم",
  stale_1_3d: "1–3 أيام",
  stale_3_7d: "3–7 أيام",
  stale_7d_plus: "أكثر من 7 أيام",
  missing: "بلا تاريخ تحديث",
};

function emptyStringOrNull(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function categoricalKey(value: string | null | undefined): string {
  return emptyStringOrNull(value) ? OPERATIONAL_UNSPECIFIED : value!.trim();
}

function categoricalLabel(key: string): string {
  return key === OPERATIONAL_UNSPECIFIED ? OPERATIONAL_UNSPECIFIED_LABEL : key;
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

/** Select excludes description/sourceDetail long complaint body text. */
const OPERATIONAL_SELECT = {
  id: true,
  status: true,
  channel: true,
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
  classification: { select: { nameAr: true } },
} satisfies Prisma.ComplaintSelect;

function buildBucketMetrics(
  rows: SlimOperationalRow[],
  now: Date,
  keyFn: (row: SlimOperationalRow) => string,
  filterKey: string,
  previousByKey: Map<string, number> | null,
  total: number
): OperationalBucketMetrics[] {
  const groups = new Map<string, SlimOperationalRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, items]) => {
      let open = 0;
      let closed = 0;
      let currentlyLate = 0;
      let resolutionSum = 0;
      let resolutionN = 0;
      for (const item of items) {
        if (OPEN_COMPLAINT_STATUSES.has(item.status)) open += 1;
        if (CLOSED_COMPLAINT_STATUSES.has(item.status)) closed += 1;
        const timing = buildComplaintTiming(item, now);
        if (timing.isCurrentlyLate) currentlyLate += 1;
        if (timing.resolutionDays != null) {
          resolutionSum += timing.resolutionDays;
          resolutionN += 1;
        }
      }
      const previousCount = previousByKey?.get(key) ?? null;
      const count = items.length;
      return {
        key,
        label: categoricalLabel(key),
        count,
        percentage: pct(count, total),
        open,
        closed,
        currentlyLate,
        averageResolutionDays: resolutionN > 0 ? Math.round((resolutionSum / resolutionN) * 10) / 10 : null,
        previousCount,
        change: previousCount == null ? null : count - previousCount,
        drillDownFilters: { [filterKey]: key },
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ar"));
}

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

function buildWingMetrics(rows: SlimOperationalRow[], now: Date, total: number): WingOperationalMetrics {
  const byWing = new Map<string, SlimOperationalRow[]>();
  for (const row of rows) {
    const key = categoricalKey(row.wingCode);
    const list = byWing.get(key) ?? [];
    list.push(row);
    byWing.set(key, list);
  }

  const items = Array.from(byWing.entries())
    .filter(([key]) => key !== OPERATIONAL_UNSPECIFIED)
    .map(([key, itemsForWing]) => {
      let open = 0;
      let closed = 0;
      let currentlyLate = 0;
      const classCounts = new Map<string, number>();
      for (const row of itemsForWing) {
        if (OPEN_COMPLAINT_STATUSES.has(row.status)) open += 1;
        if (CLOSED_COMPLAINT_STATUSES.has(row.status)) closed += 1;
        if (buildComplaintTiming(row, now).isCurrentlyLate) currentlyLate += 1;
        const className = row.classification?.nameAr;
        if (className) classCounts.set(className, (classCounts.get(className) ?? 0) + 1);
      }
      const top = Array.from(classCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
      return {
        key,
        label: categoricalLabel(key),
        count: itemsForWing.length,
        percentage: pct(itemsForWing.length, total),
        open,
        closed,
        currentlyLate,
        topClassification: top?.[0] ?? null,
        topClassificationCount: top?.[1] ?? 0,
        drillDownFilters: { wingCode: key },
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ar"))
    .slice(0, 40);

  return {
    items,
    unspecifiedCount: byWing.get(OPERATIONAL_UNSPECIFIED)?.length ?? 0,
    total,
  };
}

function buildFreshness(rows: SlimOperationalRow[], now: Date): DataFreshnessMetrics {
  const bucketCounts = Object.fromEntries(DATA_FRESHNESS_BUCKETS.map((b) => [b, 0])) as Record<
    DataFreshnessBucket,
    number
  >;
  let ageSum = 0;
  let ageN = 0;
  let missingUpdatedAt = 0;
  let missingModifiedAt = 0;
  let modifiedAfterUpdated = 0;
  let diffSum = 0;
  let diffN = 0;
  let last: Date | null = null;
  let oldest: Date | null = null;

  for (const row of rows) {
    const bucket = resolveFreshnessBucket(row.sourceUpdatedAt, now);
    bucketCounts[bucket] += 1;
    if (!row.sourceUpdatedAt) missingUpdatedAt += 1;
    if (!row.sourceModifiedAt) missingModifiedAt += 1;
    if (row.sourceUpdatedAt) {
      ageSum += (now.getTime() - row.sourceUpdatedAt.getTime()) / DAY_MS;
      ageN += 1;
      if (!last || row.sourceUpdatedAt > last) last = row.sourceUpdatedAt;
      if (!oldest || row.sourceUpdatedAt < oldest) oldest = row.sourceUpdatedAt;
    }
    if (row.sourceUpdatedAt && row.sourceModifiedAt) {
      diffSum += (row.sourceUpdatedAt.getTime() - row.sourceModifiedAt.getTime()) / (60 * 60 * 1000);
      diffN += 1;
      if (row.sourceModifiedAt > row.sourceUpdatedAt) modifiedAfterUpdated += 1;
    }
  }

  const total = rows.length;
  const freshCount = bucketCounts.fresh_1d;
  const staleCount = bucketCounts.stale_1_3d + bucketCounts.stale_3_7d + bucketCounts.stale_7d_plus;

  return {
    lastSourceUpdatedAt: last?.toISOString() ?? null,
    lastSourceUpdatedAtRiyadh: formatInstantInRiyadh(last),
    oldestSourceUpdatedAt: oldest?.toISOString() ?? null,
    oldestSourceUpdatedAtRiyadh: formatInstantInRiyadh(oldest),
    averageAgeDays: ageN > 0 ? Math.round((ageSum / ageN) * 10) / 10 : null,
    freshShare: pct(freshCount, total),
    staleShare: pct(staleCount, total),
    buckets: DATA_FRESHNESS_BUCKETS.map((bucket) => ({
      bucket,
      label: FRESHNESS_BUCKET_LABELS[bucket],
      count: bucketCounts[bucket],
      percentage: pct(bucketCounts[bucket], total),
      drillDownFilters: { dataFreshnessBucket: bucket },
    })),
    missingUpdatedAt,
    missingModifiedAt,
    modifiedBeforeUpdated: modifiedAfterUpdated,
    updatedVsModifiedDiffHoursAvg: diffN > 0 ? Math.round((diffSum / diffN) * 10) / 10 : null,
  };
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
  const includeStaffActors =
    options.includeStaffActors === true || params.get("includeStaffActors") === "true";

  const query = parseComplaintQuery(params);
  const where = buildComplaintWhere(query, now);

  const loadCurrent = await timed(() =>
    db.complaint.findMany({
      where,
      select: OPERATIONAL_SELECT,
    })
  );
  const rows = loadCurrent.value as SlimOperationalRow[];
  const total = rows.length;

  const prevParams = previousPeriodParams(params);
  let previousByOrigin: Map<string, number> | null = null;
  let prevMs = 0;
  if (prevParams) {
    const prevWhere = buildComplaintWhere(parseComplaintQuery(prevParams), now);
    const prevLoad = await timed(() =>
      db.complaint.groupBy({
        by: ["sourceOrigin"],
        where: prevWhere,
        _count: { _all: true },
      })
    );
    prevMs = prevLoad.ms;
    previousByOrigin = new Map(
      prevLoad.value.map((row) => [categoricalKey(row.sourceOrigin), row._count._all])
    );
  }

  const originTimed = await timed(async () =>
    buildBucketMetrics(rows, now, (r) => categoricalKey(r.sourceOrigin), "sourceOrigin", previousByOrigin, total)
  );
  const statusTimed = await timed(async () =>
    buildBucketMetrics(rows, now, (r) => categoricalKey(r.sourceStatus), "sourceStatus", null, total)
  );
  const actionStatusTimed = await timed(async () =>
    buildBucketMetrics(
      rows,
      now,
      (r) => categoricalKey(r.sourceActionStatus),
      "sourceActionStatus",
      null,
      total
    )
  );
  const wingTimed = await timed(async () => buildWingMetrics(rows, now, total));
  const freshnessTimed = await timed(async () => buildFreshness(rows, now));
  const actionQualityTimed = await timed(async () => buildActionTakenQuality(rows));
  const qualityTimed = await timed(async () => buildDataQuality(rows, total));

  const channelKeys = new Set(rows.map((r) => categoricalKey(r.channel))).size;
  const originKeys = new Set(rows.map((r) => categoricalKey(r.sourceOrigin))).size;
  const staff = buildStaffActors(rows, includeStaffActors);

  return {
    totalInScope: total,
    generatedAt: now.toISOString(),
    timezoneDisplay: RIYADH_TZ,
    sourceOrigin: { items: originTimed.value, total },
    sourceStatus: {
      items: statusTimed.value,
      total,
      unspecifiedCount: statusTimed.value.find((i) => i.key === OPERATIONAL_UNSPECIFIED)?.count ?? 0,
    },
    sourceActionStatus: {
      items: actionStatusTimed.value,
      total,
      unspecifiedCount:
        actionStatusTimed.value.find((i) => i.key === OPERATIONAL_UNSPECIFIED)?.count ?? 0,
    },
    channelIndependentCheck: {
      sourceOriginKeys: originKeys,
      channelKeys,
      note: "sourceOrigin and channel are independent dimensions; do not merge.",
    },
    actionTakenQuality: actionQualityTimed.value,
    wing: wingTimed.value,
    freshness: freshnessTimed.value,
    dataQuality: qualityTimed.value,
    staffActors: staff,
    performanceMs: {
      loadRows: loadCurrent.ms,
      previousPeriod: prevMs,
      sourceOrigin: originTimed.ms,
      sourceStatus: statusTimed.ms,
      sourceActionStatus: actionStatusTimed.ms,
      wingCode: wingTimed.ms,
      freshness: freshnessTimed.ms,
      actionTakenQuality: actionQualityTimed.ms,
      dataQuality: qualityTimed.ms,
    },
  };
}
