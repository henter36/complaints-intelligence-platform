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
 * Upper bound on synthetic dataset size for `--cardinality=high`, chosen so
 * `sourceUpdatedAtForRow`'s per-bucket sequence offset can never cross a
 * freshness bucket boundary (see the derivation below and
 * `assertSupportedSyntheticCardinality`). This is a limit of the *synthetic
 * benchmark generator only* — it does not bound the database, the freshness
 * aggregate service, or any production data. Currently-run benchmarks top
 * out at 500,000 rows (Issue #63 phase 3), far below this limit.
 *
 * Derivation: the tightest bucket margin is fresh_1d's — its base is
 * `NOW - 12h`, and the next-older bucket (stale_1_3d) begins at exactly
 * `NOW - 24h`, a 12h = 43,200,000ms window. In high-cardinality mode,
 * `offsetMs = Math.floor(i / 5) * 100`. Solving
 * `Math.floor(i / 5) * 100 >= 43_200_000` for the smallest breaking `i`:
 * `Math.floor(i / 5) >= 432_000` ⇒ `i >= 2_160_000`. A dataset of exactly
 * `MAX_HIGH_CARDINALITY_ROWS` rows uses indices `0..2_159_999` — the largest
 * index, `2_159_999`, gives `Math.floor(2_159_999 / 5) = 431_999`, safely
 * under `432_000`. A dataset of `MAX_HIGH_CARDINALITY_ROWS + 1` rows
 * additionally uses index `2_160_000`, which breaks the boundary.
 */
export const MAX_HIGH_CARDINALITY_ROWS = 2_160_000;

/**
 * Throws if `cardinality === "high"` and `size` would push
 * `sourceUpdatedAtForRow`'s offset past a freshness bucket boundary (see
 * `MAX_HIGH_CARDINALITY_ROWS`). Call this once, before seeding — not per
 * row. `normal` cardinality is unaffected by this limit at any size.
 */
export function assertSupportedSyntheticCardinality(size: number, cardinality: Cardinality): void {
  if (cardinality === "high" && size > MAX_HIGH_CARDINALITY_ROWS) {
    throw new Error(
      `high-cardinality synthetic benchmark supports at most ${MAX_HIGH_CARDINALITY_ROWS} rows to preserve freshness bucket boundaries`
    );
  }
}

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
 *     a modulo, so uniqueness never wraps around and re-collides distinct
 *     rows onto the same timestamp, up to the enforced
 *     `MAX_HIGH_CARDINALITY_ROWS` limit (see `assertSupportedSyntheticCardinality`,
 *     which callers must invoke before seeding). This stresses
 *     groupBy(sourceUpdatedAt) cardinality for the Issue #63 phase 3
 *     stop-condition check — see
 *     docs/performance/operational-analytics-phase3-freshness.md.
 *
 * Offset bound: currently-run benchmarks top out at 500,000 rows, where the
 * per-bucket sequence tops out around 100,000 (offsetMs ≈ 10,000,000ms,
 * ~2.78h) — well under the `MAX_HIGH_CARDINALITY_ROWS` ceiling above.
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
