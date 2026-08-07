/**
 * Pure, testable seed-generation helpers for the operational-analytics
 * freshness benchmark (Issue #63 phase 3). Extracted out of
 * scripts/benchmark-operational-analytics.ts so cardinality behavior can be
 * regression-tested without importing the CLI script.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** Fixed "now" for both seeding math and the benchmarked getOperationalAnalytics call, so
 *  freshness bucket distribution is deterministic regardless of when the script runs. */
export const BENCHMARK_NOW = new Date("2026-08-05T12:00:00.000Z");

export type Cardinality = "normal" | "high";

/**
 * Deterministically places row `i` in one of the 5 freshness buckets
 * (i % 5) and returns a sourceUpdatedAt landing in that bucket. Bucket 4 is
 * always "missing" (null).
 *
 *   - normal cardinality: timestamps repeat in ~100 groups per bucket
 *     (simulates realistic import batches sharing an update run) —
 *     regardless of total row count.
 *   - high cardinality: every non-missing row gets its own unique
 *     timestamp, via a per-bucket sequence number (`Math.floor(i / 5)`,
 *     the row's 0-based position within its own bucket's row sequence — NOT
 *     a modulo, so it never wraps around and re-collides distinct rows onto
 *     the same timestamp regardless of dataset size). This stresses
 *     groupBy(sourceUpdatedAt) cardinality for the Issue #63 phase 3
 *     stop-condition check — see
 *     docs/performance/operational-analytics-phase3-freshness.md.
 *
 * Offset bound: at 500,000 rows the per-bucket sequence tops out around
 * 100,000, so offsetMs tops out around 10,000,000ms (~2.78h) in high mode —
 * safely under the tightest bucket margin (fresh_1d's 12h base sits 12h
 * from its 24h boundary), so an offset can never push a row into the next,
 * older bucket regardless of dataset size up to (and beyond) 500k.
 */
export function sourceUpdatedAtForRow(i: number, cardinality: Cardinality): Date | null {
  const bucket = i % 5;
  if (bucket === 4) return null; // missing

  const offsetMs =
    cardinality === "high"
      ? Math.floor(i / 5) * 100 // unique per row within its bucket, no wraparound
      : (Math.floor(i / 200) % 100) * 300_000; // ~100 repeated groups, 5 minutes apart

  if (bucket === 0) return new Date(BENCHMARK_NOW.getTime() - 12 * HOUR_MS - offsetMs); // fresh_1d
  if (bucket === 1) return new Date(BENCHMARK_NOW.getTime() - 2 * DAY_MS - offsetMs); // stale_1_3d
  if (bucket === 2) return new Date(BENCHMARK_NOW.getTime() - 5 * DAY_MS - offsetMs); // stale_3_7d
  return new Date(BENCHMARK_NOW.getTime() - 10 * DAY_MS - offsetMs); // stale_7d_plus
}

/**
 * sourceModifiedAt variety: ~30% missing, ~10% modified after updated
 * (exercises modifiedBeforeUpdated), ~60% modified before/at updated.
 * (Rows with sourceUpdatedAt === null always get sourceModifiedAt === null.)
 */
export function sourceModifiedAtForRow(i: number, sourceUpdatedAt: Date | null): Date | null {
  if (sourceUpdatedAt === null) return null;
  const bucket = i % 10;
  if (bucket < 3) return null; // ~30% missing
  if (bucket < 4) return new Date(sourceUpdatedAt.getTime() + 2 * HOUR_MS); // ~10% modified after updated
  return new Date(sourceUpdatedAt.getTime() - ((i % 5) + 1) * HOUR_MS); // ~60% modified before updated
}
