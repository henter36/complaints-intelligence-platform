# Operational analytics — Phase 3 (freshness aggregates)

Refs: Issue #63, part 3 of N. Follows:

- PR #62 — `perf(analytics): aggregate operational dimensions in database`
- PR #64 — `perf(analytics): aggregate wing metrics in database`

This PR does **not** close Issue #63. Still on residual row scans after this PR:

- `actionTakenQuality`
- the rest of `dataQuality` (everything except the 3 signals precomputed below)
- `staffActors`
- final removal of `RESIDUAL_OPERATIONAL_SELECT` (it still exists, just narrower)

## Environment

| Field | Value |
| --- | --- |
| Baseline SHA (main) | `e922511a2375c07b4011b54ce0544cfb7d3be165` |
| After branch | `perf/operational-analytics-db-aggregates-freshness` (see PR commit for exact SHA) |
| Node | v24.18.1 |
| Prisma / @prisma/client | ^6.11.1 |
| DB | SQLite (temporary files, synthetic + a read-only snapshot pattern reused from prior phases) |
| Fixed `now` used for every benchmark run and every synthetic seed | `2026-08-05T12:00:00.000Z` |

Baseline was measured from a separate `git worktree --detach` checkout of the baseline SHA
(sharing this repo's `node_modules` via a symlink — package.json is unchanged between the two,
so this is a valid reuse, not a shortcut around a real dependency difference), running the
**unmodified** baseline `scripts/benchmark-operational-analytics.ts`. "After" was measured in
this repo's working tree with the updated script.

## What moved to the database

| Metric | Before (Node, in `buildFreshness`) | After |
| --- | --- | --- |
| Bucket counts (`fresh_1d`, `stale_1_3d`, `stale_3_7d`, `stale_7d_plus`, `missing`) | `for` loop over loaded rows, one `resolveFreshnessBucket` call per row | 5× `db.complaint.count` with `freshnessBucketWhere`, in parallel |
| `missingUpdatedAt` | counted in the same loop | `= bucketCounts.missing` (same definition, no extra query) |
| `missingModifiedAt` | counted in the same loop | 1× `db.complaint.count({ sourceModifiedAt: null })` |
| `lastSourceUpdatedAt` / `oldestSourceUpdatedAt` / `averageAgeDays` | running min/max/sum over loaded rows | 1× `groupBy(["sourceUpdatedAt"])` with `_count`, weighted in Node over the (small) group list |
| `modifiedBeforeUpdated` / `updatedVsModifiedDiffHoursAvg` | running sum/compare over loaded rows | 1× `groupBy(["sourceUpdatedAt", "sourceModifiedAt"])` with `_count`, weighted in Node over the group list |

Total: **8 fixed queries**, all issued via `Promise.all` inside
`loadAggregatedFreshnessMetrics` (`src/server/analytics/operational/operational-freshness-aggregate-service.ts`).
Query count does not depend on row count, region/department cardinality, or any dynamic
dimension — confirmed by an integration test that seeds 10 rows and 1,000 rows in the same
suite and asserts `prismaQueries === 8` for both.

`buildFreshness` (the old Node accumulator) is **kept, unchanged, as a test-only reference** —
it is no longer called from `getOperationalAnalytics`, but the existing frozen-object regression
test in `operational-analytics.test.ts` still exercises it directly, so that test's extensive
boundary coverage did not need to be rewritten or re-derived.

### Data Quality — 3 signals now precomputed

`missing_source_updated_at`, `missing_source_modified_at`, and `modified_after_updated` are the
only `dataQuality` signals that read `sourceUpdatedAt`/`sourceModifiedAt`. They now take their
`count` directly from the freshness aggregate result (`missingUpdatedAt`, `missingModifiedAt`,
`modifiedBeforeUpdated` respectively) via a new `PrecomputedDataQualityCounts` parameter on
`buildDataQuality`, instead of a `test: (row) => …` row scan. No extra query. Labels, severity,
explanation, `drillDownFilters`, and the signal ordering are all unchanged — verified by
`matches the three sourceUpdatedAt/sourceModifiedAt data-quality signal counts to the freshness
aggregate` in the parity integration test.

### Residual select

`sourceUpdatedAt` and `sourceModifiedAt` had no other production consumer (verified by
`grep -rn "SlimOperationalRow|RESIDUAL_OPERATIONAL_SELECT"` before removing them) and are now
dropped from both `SlimOperationalRow` and `RESIDUAL_OPERATIONAL_SELECT`.

| | Field count |
| --- | --- |
| Before | 17 |
| After | 15 |

### Boundary semantics (unchanged, verified)

`fresh_1d`, `stale_1_3d`, `stale_3_7d`, `stale_7d_plus`, `missing` — definitions and the single
source of truth (`operational-freshness.ts`: `buildFreshnessDateBounds`, `freshnessBucketWhere`,
`resolveFreshnessBucket`, `FRESHNESS_BUCKET_LABELS`) are untouched. Boundary integration test
(`operational-freshness-aggregate-service.test.ts`) seeds rows at `now+1h`, `now`,
`now-(1d-1ms)`, `now-1d` exactly, `now-1d-1ms`, `now-3d` exactly, `now-3d-1ms`, `now-7d` exactly,
`now-7d-1ms`, and `null`, and asserts each lands in the bucket `resolveFreshnessBucket` predicts
— i.e. the exact-boundary instants (`1d`, `3d`, `7d`) fall into the **older** bucket, matching
the existing `gt`/`lte` semantics.

### `modifiedBeforeUpdated` naming

Kept as-is per the task scope (renaming is a contract change, out of scope for a performance-only
migration). A comment in `operational-freshness-aggregate-service.ts` documents that it counts
`sourceModifiedAt > sourceUpdatedAt` despite the name.

## Parity

All of the following are asserted by tests, not just inspected manually:

- **Bucket counts**: `operational-freshness-aggregate-service.test.ts` — boundary dataset, each
  bucket count matches an independent `resolveFreshnessBucket`-based tally; `sum(buckets) ===
  totalInScope`.
- **Drill-down**: for every bucket in both the dedicated test and the parity integration test,
  `listComplaints` with `dataFreshnessBucket=<bucket>` (plus the same base filters) returns a
  `pagination.total` equal to that bucket's `count`.
- **Weighted average age**: dataset `A (age=1d) / B (age=3d) / C (age=3d) / D (null)` — asserts
  `averageAgeDays === 2.3` (weighted: `(1+3+3)/3`), explicitly **not** `2.0`
  (`(1+3)/2`, the wrong unweighted-average-of-distinct-values result). `D` (null) is excluded
  from the denominator.
- **Updated/modified diagnostics**: signed diff-hours average (no `abs()`), `modifiedBeforeUpdated`
  legacy semantics, rows missing either timestamp excluded from the average. A 100-row group
  sharing one `(updated, modified)` pair plus 1 row with a different pair asserts
  `modifiedBeforeUpdated` reflects **all 101 rows**, not "1 row per distinct group" — this is the
  test that would catch a groupBy-weighting bug (using group count instead of `_count._all`).
- **Self-scoping invariant**: when the base query itself already filters
  `dataFreshnessBucket=stale_7d_plus`, the resulting `freshness.buckets` show `stale_7d_plus ===
  totalInScope` and every other bucket `=== 0` — verified both directly against
  `loadAggregatedFreshnessMetrics` and through the full `getOperationalAnalytics` path with 6
  other filters combined (`region`, `facility`, `department`, `channel`, `status`,
  `dataFreshnessBucket`).
- **Data Quality count parity**: the 3 precomputed signal counts equal the corresponding
  freshness fields exactly (same aggregate result, not recomputed).

## Query count

| Path | Queries |
| --- | --- |
| `loadAggregatedFreshnessMetrics` alone | 8 (fixed: 5 bucket counts + 1 missingModifiedAt + 2 groupBy) |
| Full `getOperationalAnalytics`, no previous period | 23 (was 15 before this PR — the +8 is exactly the new freshness queries; nothing else changed query-wise) |

Confirmed fixed at both 10 and 1,000 seeded rows in the same integration test run.

## Benchmark methodology

`scripts/benchmark-operational-analytics.ts --mode=synthetic`, extended in this PR with:

- `--cardinality=normal|high` (default `normal`) — `normal` repeats `sourceUpdatedAt`/
  `sourceModifiedAt` in realistic-sized groups (≈100 distinct timestamps per bucket, regardless
  of total row count); `high` spreads timestamps to stress the `groupBy` result-set size (see
  the stop-condition section below).
- A standalone, isolated `loadAggregatedFreshnessMetrics` call (own query counter, own
  before/after heap snapshot) reported under `freshnessDiagnostics` in the script's JSON output
  — **benchmark output only**, never added to `OperationalAnalyticsSummary` or
  `DataFreshnessMetrics`. `AggregatedFreshnessResult` gained two diagnostic-only fields
  (`updatedTimestampGroupCount`, `updatedModifiedPairGroupCount`) for exactly this purpose.
- `residualSelectFieldCount` (`Object.keys(RESIDUAL_OPERATIONAL_SELECT).length`) in the report,
  so the 17→15 change is asserted from the running code, not just claimed.

Each size was run **3 times**, back-to-back, nothing else running concurrently, and the numbers
below are the **per-field median of the 3 runs** — not a single run's output. One baseline
500k run (`baseline-500k-2.json`) overlapped with an unrelated `npm test` run on this machine and
took 24 minutes instead of ~27 seconds; it is *not* excluded from the raw data, but the median is
what's reported precisely because it is robust to exactly this kind of contamination (the other
two runs were ~27s and ~26.8s; the median of the three is ~27.3s, matching the two clean runs).

## Results

### 20,000 rows

| Field | Baseline (median of 3) | After (median of 3) |
| --- | --- | --- |
| `totalMs` | 826 | 767 |
| `performanceMs.loadRows` (residual `findMany`) | 759 | 739 |
| `performanceMs.freshness` | 32 | 104 |
| Heap before → after (MB) | 39 → 80 | 33 → 68 |
| RSS before → after (MB) | 189 → 305 | 199 → 302 |
| `prismaQueries` | 15 | 23 |

### 100,000 rows

| Field | Baseline (median of 3) | After (median of 3) |
| --- | --- | --- |
| `totalMs` | 4,495 | 3,836 |
| `performanceMs.loadRows` | 4,330 | 3,746 |
| `performanceMs.freshness` | 77 | 319 |
| Heap before → after (MB) | 30 → 289 | 65 → 232 |
| RSS before → after (MB) | 285 → 852 | 292 → 729 |
| `prismaQueries` | 15 | 23 |

### 500,000 rows

| Field | Baseline (median of 3) | After (median of 3) |
| --- | --- | --- |
| `totalMs` | 27,308 | 25,189 |
| `performanceMs.loadRows` | 26,539 | 24,833 |
| `performanceMs.freshness` | 385 | 1,527 |
| Heap before → after (MB) | 28 → 1,216 | 27 → 1,049 |
| RSS before → after (MB) | 293 → 3,078 | 303 → 2,802 |
| `prismaQueries` | 15 | 23 |

Raw per-run JSON for all 18 runs (3 sizes × baseline/after × 3 repeats) plus the 2 high-cardinality
runs are preserved as artifacts of this benchmark session (not committed to the repo — regenerable
via the commands in "Reproducing" below).

## Honest interpretation

- **`performanceMs.freshness` got *slower* in absolute terms at every size** (32→104ms at 20k,
  77→319ms at 100k, 385→1,527ms at 500k). This is expected and explained by one specific,
  documented cause: **`sourceUpdatedAt`/`sourceModifiedAt` have no database index**
  (confirmed by inspecting `prisma/schema.prisma` — `@@index` is declared for `status`, `dueDate`,
  `createdAt`, `region`, `department`, `classificationId`, etc., but not these two columns).
  Every one of the 8 new queries is a full table scan. Adding an index is a schema change and is
  explicitly out of scope for this phase; it is the natural next optimization if freshness
  latency (not memory) becomes the bottleneck.
- **Despite that, overall `totalMs` is lower after this PR at every size** (826→767 at 20k,
  4,495→3,836 at 100k, 27,308→25,189 at 500k) because (a) freshness now runs in parallel with
  wing/residual/dimension aggregation instead of after loading rows, and (b) `loadRows` itself
  got faster from selecting 2 fewer columns per residual row — and that saving is larger than the
  new freshness queries cost, at every tested size.
- **Heap and RSS medians (3 runs each) are lower after this PR at every size** — most clearly at
  100k (heap 289→232 MB, ~20% less; RSS 852→729 MB, ~14% less) and 500k (heap 1,216→1,049 MB,
  ~14% less; RSS 3,078→2,802 MB, ~9% less). Per the same caution as the phase-2 wing document:
  `process.memoryUsage()` is a point-in-time sample taken once immediately before and once
  immediately after `getOperationalAnalytics()`, not a peak-memory measurement, and single
  snapshots are noisy (see the high-cardinality section below, where one isolated
  `freshnessDiagnostics.heapDeltaMB` reading came back at `-960` from GC timing, not a real
  memory saving). The claim here is limited to what 3-run medians support: a **repeatable
  reduction in the memory footprint sampled around the call**, consistent with loading 2 fewer
  columns × up to 500,000 rows. It is not a peak-memory or GC-behavior claim.
- **`prismaQueries` moved from 15 to 23** — a deliberate, fixed +8, not a regression: it replaces
  an unbounded, row-count-scaling Node loop with 8 queries whose count never grows.

## Stop-condition check: groupBy cardinality (Issue #63 §38)

Ran a `--cardinality=high` synthetic seed designed to push `groupBy(sourceUpdatedAt)` and
`groupBy(sourceUpdatedAt, sourceModifiedAt)` toward their worst case, at both 100k and 500k rows.

| | 100k, normal | 100k, high | 500k, normal | 500k, high |
| --- | --- | --- | --- | --- |
| `updatedTimestampGroupCount` | 400 | 80,000 | 400 | 80,000 |
| `updatedModifiedPairGroupCount` | 500 | 50,000 | 500 | 50,000 |
| `updatedGroupToRowRatio` | 0.004 | 0.8 | 0.0008 | 0.16 |
| `freshnessDiagnostics.ms` (isolated) | 272 | 1,086 | 1,070 | 2,008 |
| `performanceMs.freshness` (in-pipeline) | 319 | 2,056 | 1,527 | 3,310 |

**Reading this table**: the synthetic `--cardinality=high` generator caps distinct timestamps at
~100,000 total (a deliberate safety bound so offsets never cross a bucket boundary — see the
generator's comment in the benchmark script), so `updatedTimestampGroupCount` plateaus at 80,000
once row count passes that cap, rather than continuing to scale linearly with row count. That
means the 500k/high ratio (0.16) *understates* how bad a truly one-distinct-timestamp-per-row
scenario would be at 500k — this benchmark does not claim to have reproduced that exact
worst case.

What it does show, honestly:

- At the ratio actually reached (cardinality approaching 80% of rows, at 100k), freshness cost
  roughly **4×** its normal-cardinality time (272ms → 1,086ms isolated; 319ms → 2,056ms
  in-pipeline) and its isolated heap delta went from a wash to +64MB.
- At 500k with the same absolute group count (a *lower* ratio, 16%), isolated freshness time
  still roughly doubled (1,070ms → 2,008ms).
- Neither of these is a "memory regression" or "unacceptable time" by this PR's own numbers —
  `totalMs` for the full `getOperationalAnalytics` call under `--cardinality=high` at 500k was
  **25,059ms**, in the same range as the normal-cardinality after-runs (21,300–25,400ms), because
  freshness runs in parallel with the (much larger) residual row load and wing/dimension
  aggregation rather than on the critical path alone.
- **We are not claiming this generalizes to arbitrarily higher cardinality.** Real
  `sourceUpdatedAt` values come from the source system's own update-batch cadence, which is why
  the `normal` scenario (repeats in realistic-sized groups) is the one representative of expected
  production data. If a future dataset is observed with `groupToRowRatio` genuinely approaching 1
  at production scale (every complaint updated at its own unique instant, no batching at all),
  this design would need re-evaluation.

**Per the task's explicit instruction, this is not being silently forced past**: this document
records the cardinality, timing, and heap numbers above precisely so a future reader can see
where the ceiling was actually measured. If it is ever hit in production, the recommended next
step is **not** an ad hoc SQLite-specific raw-SQL query, but a dedicated follow-up phase adding a
small provider-adapter layer (SQLite today, Postgres-compatible later) for expression-based
aggregates (e.g. `date_trunc`/bucket-expression `GROUP BY` pushed fully into the database) —
scoped and reviewed separately from this PR.

## Source database integrity

This PR's benchmarks used only synthetic temporary SQLite databases (`--mode=synthetic`);
`prisma/dev.db` was never written to. No `prisma db push` / `migrate reset` / `updateMany` /
`deleteMany` / `VACUUM` was run against `prisma/dev.db` at any point in this phase.

## Reproducing

```bash
# Baseline (run from a separate worktree at e922511a2375c07b4011b54ce0544cfb7d3be165)
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=20000
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=100000
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=500000

# After (this branch)
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=20000 --cardinality=normal
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=100000 --cardinality=normal
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=500000 --cardinality=normal

# Stop-condition / cardinality stress
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=100000 --cardinality=high
npx tsx scripts/benchmark-operational-analytics.ts --mode=synthetic --size=500000 --cardinality=high
```

## Why Issue #63 stays open

Freshness (and the 3 date-derived Data Quality signals) moved to DB aggregates. `actionTakenQuality`,
the remaining `dataQuality` signals, `staffActors`, and the eventual full removal of the residual
row scan are still outstanding.
