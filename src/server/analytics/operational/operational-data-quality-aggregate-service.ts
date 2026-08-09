import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { CLOSED_COMPLAINT_STATUSES } from "@/server/complaints/status";
import {
  OPERATIONAL_UNSPECIFIED,
  type ActionStatusDistribution,
  type OperationalBucketMetrics,
  type SourceStatusDistribution,
  type WingOperationalMetrics,
} from "./operational-analytics-types";

/** No global flag — reused across many independent .test() calls via plain RegExp.prototype.test, never .exec/.matchAll. */
const SOURCE_STATUS_CLOSED_PATTERN = /مغلق|مغلقة|closed/i;
const SOURCE_STATUS_OPEN_PATTERN = /مبدئي|جديد|مفتوح|open|progress|إرسال/i;

const CLOSED_STATUS_VALUES = Array.from(CLOSED_COMPLAINT_STATUSES);

/**
 * Full precomputed count bag consumed by buildDataQuality in
 * operational-analytics-service.ts. The 3 freshness-derived fields
 * (missingSourceUpdatedAt/missingSourceModifiedAt/modifiedAfterUpdated) are
 * populated by the caller from loadAggregatedFreshnessMetrics's own result —
 * this service never re-queries freshness data.
 */
export type AggregatedDataQualityCounts = {
  missingSourceOrigin: number;
  missingSourceStatus: number;
  missingSourceActionStatus: number;
  missingWingCode: number;
  missingSourceUpdatedAt: number;
  missingSourceModifiedAt: number;
  modifiedAfterUpdated: number;
  closedWithoutClosedAt: number;
  sourceStatusVsInternalMismatch: number;
  actionStatusVsClosureMismatch: number;
};

type FreshnessDerivedKeys = "missingSourceUpdatedAt" | "missingSourceModifiedAt" | "modifiedAfterUpdated";

/**
 * Same condition as the historical `sourceStatus vs internal status` row
 * scan, re-expressed over already-aggregated per-sourceStatus open/closed
 * counts instead of iterating every row. A label matching both patterns
 * (unusual, but not excluded by the original regexes) contributes to both
 * counts — not an else-if — mirroring the original per-row test exactly:
 * an open row under that label was counted via looksClosed, and a closed
 * row under the same label was counted via looksOpen.
 */
export function countSourceStatusInternalMismatch(
  items: readonly OperationalBucketMetrics[]
): number {
  let count = 0;
  for (const item of items) {
    if (item.key === OPERATIONAL_UNSPECIFIED) continue;
    const sourceStatus = item.key.trim();
    const looksClosed = SOURCE_STATUS_CLOSED_PATTERN.test(sourceStatus);
    const looksOpen = SOURCE_STATUS_OPEN_PATTERN.test(sourceStatus);
    if (looksClosed) count += item.open;
    if (looksOpen) count += item.closed;
  }
  return count;
}

/**
 * `categoricalKey` (used to build `sourceActionStatus.items`) trims the same
 * way `normalizeOperationalLabel` does for a single-word label like "جديد" —
 * both collapse null/empty/whitespace-only to OPERATIONAL_UNSPECIFIED and
 * both trim leading/trailing whitespace — so matching the aggregated item's
 * key against the literal label reproduces the historical per-row
 * `normalizeOperationalLabel(row.sourceActionStatus) === "جديد"` check
 * exactly, without a second normalization pass.
 */
export function countActionStatusClosureMismatch(
  items: readonly OperationalBucketMetrics[]
): number {
  return items.find((item) => item.key === "جديد")?.closed ?? 0;
}

function countMissingSourceOrigin(items: readonly OperationalBucketMetrics[]): number {
  return items.find((item) => item.key === OPERATIONAL_UNSPECIFIED)?.count ?? 0;
}

/**
 * The only genuinely new query this migration adds. Depends only on `where`
 * — callers should start this immediately, in parallel with the dimension
 * aggregates, rather than waiting for them to resolve first.
 */
export async function loadClosedWithoutClosedAtCount(
  where: Prisma.ComplaintWhereInput
): Promise<number> {
  return db.complaint.count({
    where: {
      AND: [where, { status: { in: CLOSED_STATUS_VALUES }, closedAt: null }],
    },
  });
}

/** Pure — combines already-resolved aggregates and an already-resolved closedWithoutClosedAt count. No I/O. */
export function buildAggregatedDataQualityCounts(options: {
  sourceOrigin: readonly OperationalBucketMetrics[];
  sourceStatus: SourceStatusDistribution;
  sourceActionStatus: ActionStatusDistribution;
  wing: WingOperationalMetrics;
  closedWithoutClosedAt: number;
}): Omit<AggregatedDataQualityCounts, FreshnessDerivedKeys> {
  return {
    missingSourceOrigin: countMissingSourceOrigin(options.sourceOrigin),
    missingSourceStatus: options.sourceStatus.unspecifiedCount,
    missingSourceActionStatus: options.sourceActionStatus.unspecifiedCount,
    missingWingCode: options.wing.unspecifiedCount,
    closedWithoutClosedAt: options.closedWithoutClosedAt,
    sourceStatusVsInternalMismatch: countSourceStatusInternalMismatch(options.sourceStatus.items),
    actionStatusVsClosureMismatch: countActionStatusClosureMismatch(options.sourceActionStatus.items),
  };
}

/**
 * Convenience wrapper for callers that don't need manual control over when
 * the closedWithoutClosedAt query starts (e.g. tests). Production code in
 * getOperationalAnalytics calls loadClosedWithoutClosedAtCount directly and
 * starts it in parallel with the dimension aggregates instead of using this.
 */
export async function loadAggregatedDataQualityCounts(options: {
  where: Prisma.ComplaintWhereInput;
  sourceOrigin: readonly OperationalBucketMetrics[];
  sourceStatus: SourceStatusDistribution;
  sourceActionStatus: ActionStatusDistribution;
  wing: WingOperationalMetrics;
}): Promise<Omit<AggregatedDataQualityCounts, FreshnessDerivedKeys>> {
  const closedWithoutClosedAt = await loadClosedWithoutClosedAtCount(options.where);
  return buildAggregatedDataQualityCounts({ ...options, closedWithoutClosedAt });
}
