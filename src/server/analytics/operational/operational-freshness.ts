import type { Prisma } from "@prisma/client";
import type { DataFreshnessBucket } from "@/server/analytics/operational/operational-analytics-types";

export const DAY_MS = 24 * 60 * 60 * 1000;

export const RIYADH_TZ = "Asia/Riyadh";

/** Display-only formatting; storage stays ISO UTC (see DataFreshnessMetrics). */
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

export const FRESHNESS_BUCKET_LABELS: Record<DataFreshnessBucket, string> = {
  fresh_1d: "خلال يوم",
  stale_1_3d: "1–3 أيام",
  stale_3_7d: "3–7 أيام",
  stale_7d_plus: "أكثر من 7 أيام",
  missing: "بلا تاريخ تحديث",
};

export type FreshnessDateBounds = {
  oneDayAgo: Date;
  threeDaysAgo: Date;
  sevenDaysAgo: Date;
};

export function buildFreshnessDateBounds(now: Date): FreshnessDateBounds {
  return {
    oneDayAgo: new Date(now.getTime() - DAY_MS),
    threeDaysAgo: new Date(now.getTime() - 3 * DAY_MS),
    sevenDaysAgo: new Date(now.getTime() - 7 * DAY_MS),
  };
}

/**
 * Age semantics aligned with Prisma filters from freshnessBucketWhere:
 * - fresh_1d: age < 1 day (includes future timestamps) → sourceUpdatedAt > oneDayAgo
 * - stale_1_3d: 1 day <= age < 3 days → gt threeDaysAgo, lte oneDayAgo
 * - stale_3_7d: 3 days <= age < 7 days → gt sevenDaysAgo, lte threeDaysAgo
 * - stale_7d_plus: age >= 7 days → lte sevenDaysAgo
 *
 * Note: fresh uses `gt` (not `gte`) so the exact 1-day boundary is exclusive to stale_1_3d.
 */
export function resolveFreshnessBucket(
  sourceUpdatedAt: Date | null,
  now: Date
): DataFreshnessBucket {
  if (sourceUpdatedAt === null) return "missing";
  const ageMs = now.getTime() - sourceUpdatedAt.getTime();
  if (ageMs < DAY_MS) return "fresh_1d";
  if (ageMs < 3 * DAY_MS) return "stale_1_3d";
  if (ageMs < 7 * DAY_MS) return "stale_3_7d";
  return "stale_7d_plus";
}

export function freshnessBucketWhere(
  bucket: DataFreshnessBucket,
  now: Date
): Prisma.ComplaintWhereInput {
  if (bucket === "missing") {
    return { sourceUpdatedAt: null };
  }

  const { oneDayAgo, threeDaysAgo, sevenDaysAgo } = buildFreshnessDateBounds(now);

  if (bucket === "fresh_1d") {
    // Strictly newer than oneDayAgo so the exact 1-day boundary belongs to stale_1_3d
    // (non-overlapping with `{ lte: oneDayAgo }` below). Age semantics: age < 1 day.
    return { sourceUpdatedAt: { gt: oneDayAgo } };
  }
  if (bucket === "stale_1_3d") {
    return { sourceUpdatedAt: { gt: threeDaysAgo, lte: oneDayAgo } };
  }
  if (bucket === "stale_3_7d") {
    return { sourceUpdatedAt: { gt: sevenDaysAgo, lte: threeDaysAgo } };
  }
  return { sourceUpdatedAt: { lte: sevenDaysAgo } };
}

/** True when `value` would be selected by the Prisma where for this bucket. */
export function matchesFreshnessBucketWhere(
  sourceUpdatedAt: Date | null,
  bucket: DataFreshnessBucket,
  now: Date
): boolean {
  if (bucket === "missing") return sourceUpdatedAt === null;
  if (sourceUpdatedAt === null) return false;

  const { oneDayAgo, threeDaysAgo, sevenDaysAgo } = buildFreshnessDateBounds(now);
  const t = sourceUpdatedAt.getTime();

  if (bucket === "fresh_1d") return t > oneDayAgo.getTime();
  if (bucket === "stale_1_3d") return t > threeDaysAgo.getTime() && t <= oneDayAgo.getTime();
  if (bucket === "stale_3_7d") return t > sevenDaysAgo.getTime() && t <= threeDaysAgo.getTime();
  return t <= sevenDaysAgo.getTime();
}
