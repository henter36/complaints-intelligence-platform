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
  test that would catch a groupBy-weighting bug (using group count instead of `_count._all`). A
  separate net-*negative*-average scope (`(-2 + -2 + 1) / 3 = -1.0`) specifically catches an
  accidental `Math.abs()`, which a positive-leaning scope alone cannot (`abs()` of a positive
  number is unchanged — the original version of this test used only a positive-leaning scope and
  has since been replaced).
- **Self-scoping invariant**: when the base query itself already filters
  `dataFreshnessBucket=stale_7d_plus`, the resulting `freshness.buckets` show `stale_7d_plus ===
  totalInScope` and every other bucket `=== 0` — verified both directly against
  `loadAggregatedFreshnessMetrics` and through the full `getOperationalAnalytics` path with 6
  other filters combined (`region`, `facility`, `department`, `channel`, `status`,
  `dataFreshnessBucket`). Exactly 2 seeded rows match all 6 filters simultaneously
  (`parity-6` and `parity-prev-1`) — asserted explicitly (`totalInScope === 2`), not just
  cross-checked against `listComplaints`.
- **Data Quality count parity**: the 3 precomputed signal counts equal the corresponding
  freshness fields exactly, **and** both sides are asserted against explicit expected values from
  the fixture (`missingModifiedAt === 10`, `modifiedBeforeUpdated === 1`) — not just compared to
  each other, since a hard-coded-zero implementation would otherwise pass a same-value comparison
  undetected. The parity fixture was extended with 2 rows specifically to make
  `modifiedBeforeUpdated` genuinely non-zero (every other seeded row leaves `sourceModifiedAt`
  unset).
- **Actual SQL query count, not just self-reported metadata**: a dedicated integration test opens
  a second, query-event-instrumented `PrismaClient` against the same test database and counts real
  Prisma `"query"` events fired by `loadAggregatedFreshnessMetrics` — 8 at both 10 rows and 1,000
  rows — independently of the service's own `result.prismaQueries` field (also 8, and now proven
  to match reality rather than just being consistent arithmetic).

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
- The row generator (`sourceUpdatedAtForRow` / `sourceModifiedAtForRow` / `BENCHMARK_NOW`) is
  extracted into `scripts/lib/benchmark-operational-freshness-seed.ts`, a pure module with its own
  regression test (`scripts/lib/benchmark-operational-freshness-seed.test.ts`) asserting exact
  cardinality at 100k/500k for both modes — see the high-cardinality correction below.
- `cardinality` in the report reflects what was **actually applied to seeded data**
  (`prepared.cardinality ?? "not-applicable"`), not the raw `--cardinality` CLI flag — passing
  `--cardinality` together with `--mode=read-only-current` (which never seeds synthetic data at
  all) now reports `"not-applicable"` instead of falsely claiming the flag took effect.
- `loadAggregatedFreshnessMetrics` now accepts an optional second `client` parameter
  (`FreshnessDbClient`, defaulting to `db`) purely so integration tests can inject a
  query-event-instrumented `PrismaClient` and count *actual* SQL queries fired, rather than trust
  only the service's self-reported `prismaQueries` field. Production call sites are unaffected
  (they call it with one argument and get the default client).

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

## High-cardinality generator correction (post-CodeRabbit review)

The first version of the `--cardinality=high` synthetic seed generator computed each row's
`sourceUpdatedAt` offset as `(i * 400) % 40_000_000` — a **modulo**. At row counts above roughly
100,000 total (≈20,000 per freshness bucket, since the offset space is shared across all
non-missing buckets), that modulo started **wrapping around and reusing offsets that earlier rows
had already used**, so distinct-timestamp cardinality silently *stopped growing* past ~80,000
groups no matter how many more rows were added. The 500k/high row in the original version of this
table (80,000 groups, 0.16 ratio) was consequently not a 500k-row worst case at all — it was the
*same* ~100k-row worst case diluted across a larger denominator, understating the stop-condition
risk exactly as flagged in review.

**Fix**: the offset is now `Math.floor(i / 5) * 100` — the row's own 0-based sequence number
*within its bucket* (no modulo, so it never wraps around and never re-collides two distinct rows
onto the same timestamp, at any dataset size). See
`scripts/lib/benchmark-operational-freshness-seed.ts::sourceUpdatedAtForRow` for the implementation
and `scripts/lib/benchmark-operational-freshness-seed.test.ts` for a regression test that fails
if a capping modulo is ever reintroduced (it asserts distinct-timestamp cardinality scales
linearly with row count up to 500,000).

The numbers below **supersede** the earlier (capped) 100k/500k high-cardinality measurements in
prior revisions of this document and in the original PR benchmark run.

## Normal-cardinality pair-group count: 500, not 800 (CodeRabbit comment not applied)

CodeRabbit suggested the documented `normal`-mode `updatedModifiedPairGroupCount` should be 800,
not 500 (and 80,000 instead of 50,000 for `high`, addressed by the correction above). Verified
by hand against the actual (unchanged) `normal`-mode generator logic and reconfirmed by the fresh
measurements above (500 exactly, at both 100k and 500k):

For each of the 100 repeated `sourceUpdatedAt` groups, `sourceModifiedAt` depends on `i % 10`,
which — for a fixed bucket `b = i % 5` — takes exactly 2 values as `i` varies (`b` and `b + 5`):

- `b ∈ {0, 1, 2}`: one of those two `i % 10` values produces `sourceModifiedAt = null` (excluded
  from the pair `groupBy`, which filters `sourceModifiedAt: { not: null }`); the other produces
  exactly **one** non-null value. → 1 pair per group.
- `b = 3`: **both** `i % 10` values (`3` and `8`) produce a non-null `sourceModifiedAt`, and they
  differ (`+2h` vs `-4h`). → 2 pairs per group.
- `b = 4`: `sourceUpdatedAt` itself is null (missing bucket), so `sourceModifiedAt` is always null. → 0 pairs.

Per repeated group: `1 + 1 + 1 + 2 = 5` pairs. × 100 groups = **500**, not 800 (800 would require
every bucket to contribute 2 pair variants; only `b = 3` does). This is unchanged by the
high-cardinality generator fix, since the `normal`-mode logic was not touched.

## Stop-condition check: groupBy cardinality (Issue #63 §38)

Ran the corrected `--cardinality=high` synthetic seed — every non-missing row gets a genuinely
unique `sourceUpdatedAt` — at both 100k and 500k rows, 3 runs each, median reported. `normal`
mode (realistic import-batch-style repeats) is unaffected by the generator fix and is included
for direct comparison from the same measurement session (avoiding cross-session machine-variance
noise in the ratio comparisons below).

| | 100k, normal | 100k, high | 500k, normal | 500k, high |
| --- | --- | --- | --- | --- |
| `updatedTimestampGroupCount` | 400 | **80,000** | 400 | **400,000** |
| `updatedModifiedPairGroupCount` | 500 | **50,000** | 500 | **250,000** |
| `updatedGroupToRowRatio` | 0.004 | 0.8 | 0.0008 | **0.8** |
| `pairGroupToRowRatio` | 0.005 | 0.5 | 0.0005 | **0.5** |
| `freshnessDiagnostics.ms` (isolated, median of 3) | 401 | 1,570 | 986 | **4,976** |
| `performanceMs.freshness` (in-pipeline, median of 3) | 423 | 1,875 | 2,933 | **12,452** |
| `totalMs` (full `getOperationalAnalytics`, median of 3) | 7,034 | 6,018 | 32,059 | **42,702** |
| Heap after (MB, median of 3) | 321 | 378 | 1,050 | 1,049 |
| RSS after (MB, median of 3) | 905 | 915 | 2,340 | 2,361 |
| `prismaQueries` | 23 | 23 | 23 | 23 |

`updatedTimestampGroupCount = 400,000` / `updatedModifiedPairGroupCount = 250,000` at 500k/high
means **80% of all rows have a distinct `sourceUpdatedAt`, and 50% of all rows have a distinct
`(sourceUpdatedAt, sourceModifiedAt)` pair** — this is now a genuine near-worst-case for this
synthetic distribution (every non-missing row unique), not a diluted/capped one.

> Note on `pairGroupToRowRatio`: pair-group cardinality only counts rows where **both**
> `sourceUpdatedAt` and `sourceModifiedAt` are non-null (per the generator's own ~50%/~30% split
> across missing-updated / missing-modified / modified-after / modified-before), so it is not
> automatically equal to, or a fixed multiple of, `updatedTimestampGroupCount` — the two ratios
> happen to both read 0.8/0.5 here because both scale with total row count at the same rate once
> the generator has no cap, not because they are the same computation.

**Reading these numbers, honestly**:

- At true near-worst-case cardinality (400,000 distinct timestamp groups out of 500,000 rows),
  isolated freshness time went from 986ms (normal) to 4,976ms (high) — **~5×**. In-pipeline,
  423ms → 12,452ms — the in-pipeline number is larger than the isolated one at high cardinality
  because it now runs concurrently with the (also SQLite-single-writer-contended) residual row
  load and dimension/wing aggregation, not because the freshness query itself got slower for a
  different reason.
- `totalMs` for the complete `getOperationalAnalytics` call went from 32,059ms (normal) to
  42,702ms (high) at 500k — **+33%**, not a multiplier, because freshness is one of several
  parallel branches, not the whole request.
- **Heap-after and RSS-after are essentially unchanged between normal and high cardinality**
  (1,050MB vs 1,049MB heap; 2,340MB vs 2,361MB RSS, at 500k). This is the single most important
  finding for the stop-condition question: even 400,000 groupBy result rows do not meaningfully
  grow the process footprint relative to 400, because each group is a small, fixed-shape object
  (`{ sourceUpdatedAt, _count: { _all } }`) — fundamentally cheaper to hold than the full
  `Complaint` rows this migration removed from the residual load. No OOM, no crash, at any tested
  size or cardinality.
- `prismaQueries` stayed at 23 in every cell of the table above — cardinality affects the *size*
  of two query results, never the *number* of queries issued.

## Stop-condition decision: Case A — groupBy is kept, no Raw SQL introduced

Per the task's own Case A / Case B framing: this PR's design proceeds **unchanged** (Case A), not
Case B, because none of the Case B triggers were observed even at true near-worst-case
cardinality (400,000 groups / 500,000 rows):

- No OOM, no crash.
- No material memory regression (heap/RSS after are within ~1% of the normal-cardinality run at
  the same size).
- Time increased (+33% `totalMs` at 500k under an artificially adversarial 80%-unique-timestamp
  distribution) but stayed in the tens-of-seconds range for a 500,000-row background analytics
  summary — not an unacceptable multiplier, and not on a user-facing low-latency path.

Also documented for the record (Issue #63 §38 asks these be recorded regardless of the decision):

- **groupBy cardinality risk is real and now correctly measured**, not hidden: up to 400,000
  distinct `sourceUpdatedAt` values and 250,000 distinct pairs were exercised at 500k rows.
- **The result reported is exact, not an approximation** — `loadAggregatedFreshnessMetrics` never
  samples, pages, or truncates; every group in the `groupBy` result is weighted by its real
  `_count._all` (see the 100-row-vs-1-row weighted test in
  `operational-freshness-aggregate-service.test.ts`).
- **A portable, fixed-size Prisma aggregate for the weighted-average computations does not
  currently exist** (see Feasibility check below) — the groupBy is the only portable way to get
  `averageAgeDays` / `updatedVsModifiedDiffHoursAvg` without Raw SQL.
- **This benchmark exercised up to ~400,000 timestamp groups and ~250,000 pair groups** — real
  production `sourceUpdatedAt` values are expected to cluster by the source system's own
  update-batch cadence (the `normal` scenario), not be unique per row; if a future production
  dataset is ever observed with cardinality genuinely approaching row count, this design should be
  re-evaluated against real numbers rather than assumed safe from this synthetic benchmark alone.
- **If it is ever hit in production**, the recommended next step remains a dedicated, separately
  reviewed follow-up: a small provider-adapter layer (SQLite today, Postgres-compatible later) for
  expression-based aggregates — not an ad hoc SQLite-specific Raw SQL query added directly to this
  service.

## Feasibility check: portable Prisma aggregates for DateTime (Issue #63 §38 / CodeRabbit groupBy comment)

Tested directly against a real Prisma Client / SQLite database (not guessed):

| Question | Finding |
| --- | --- |
| `db.complaint.aggregate({ _min: { sourceUpdatedAt }, _max: { sourceUpdatedAt } })` | **Supported.** Portable, returns correct min/max. |
| `db.complaint.aggregate({ _avg: { sourceUpdatedAt } })` | **Not supported.** Rejected at the TypeScript level (no valid overload) and throws `Invalid invocation` at runtime — Prisma's `_avg`/`_sum` only operate on numeric fields (Int/Float/Decimal), never DateTime, on any connector. |
| Field-reference comparison (`sourceModifiedAt: { gt: prisma.complaint.fields.sourceUpdatedAt } }`) | **Supported.** Portable; confirmed a correct count against a 3-row fixture. |
| Portable `AVG(sourceUpdatedAt)` or `AVG(sourceUpdatedAt - sourceModifiedAt)` | **Does not exist** in Prisma's query API on any connector. Only reachable via `$queryRaw` with provider-specific date-diff syntax (confirmed SQLite's `julianday()` works as a reference point; PostgreSQL would need different syntax — `EXTRACT(EPOCH FROM ...)` — so this is exactly the portability problem the task warned against introducing). |

**Conclusion**: the field-reference finding means `modifiedBeforeUpdated` alone *could* be
computed via a single fixed-size `count()` instead of being derived from the pair `groupBy`
result. **This PR does not make that change**, because the pair `groupBy` is still required
regardless — `updatedVsModifiedDiffHoursAvg` has no portable non-groupBy computation (per the
`_avg` finding above), and `modifiedBeforeUpdated` is already obtained "for free" as a side effect
of reducing that same `groupBy` result in Node. Switching would add a 9th query while the groupBy
stays mandatory anyway — a net loss, not a net improvement, so it is not implemented here per the
task's own guidance ("لا تفعل ذلك إذا سيضيف Query بلا فائدة… إلا إذا Benchmark يثبت تحسنًا").
Likewise, `_min`/`_max` aggregate is real and portable but would be a 9th query duplicating work
`groupBy` already does for free while computing `averageAgeDays` — not adopted for the same
reason.

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
