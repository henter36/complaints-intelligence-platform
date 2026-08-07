# Operational analytics — Phase 4 (data-quality aggregates)

Refs: Issue #63, part 4 of N. Follows:

- PR #62 — `perf(analytics): aggregate operational dimensions in database`
- PR #64 — `perf(analytics): aggregate wing metrics in database`
- PR #67 — `perf(analytics): aggregate freshness metrics in database`

This PR does **not** close Issue #63. Still residual after this PR:

- `actionTakenQuality`
- 3 data-quality signals that need per-row text fields: `closed_without_source_closed_by`,
  `action_taken_without_description`, `resolution_without_closed`
- `staffActors`
- final removal of `RESIDUAL_OPERATIONAL_SELECT` (6 fields remain)

## Environment

| Field | Value |
| --- | --- |
| Baseline SHA (main) | `fbd445ddd52642e69c9f647520e6e2ab0ba1e861` |
| After branch | `perf/operational-analytics-db-aggregates-data-quality` (see PR commit for exact SHA) |
| DB | SQLite (temporary synthetic files, `--mode=synthetic`) |
| Fixed `now` for every benchmark run | `2026-08-05T12:00:00.000Z` |

Baseline measured from a separate `git worktree --detach` checkout of the baseline SHA (node_modules
symlinked — package.json is unchanged between the two), running the **unmodified** baseline
`scripts/benchmark-operational-analytics.ts`.

## Data-quality signal count (audited before touching any code)

The prior PR #67 description said "8 من 11" — that was stale. Before making any change, a
regression test (`operational-analytics.test.ts`, "data quality signal registry — ids and order")
was written against the **actual pre-refactor code** and asserts the real list:

```
missing_source_origin
missing_source_status
missing_source_action_status
missing_wing_code
missing_source_updated_at
missing_source_modified_at
closed_without_closed_at
closed_without_source_closed_by
source_status_vs_internal_mismatch
action_status_vs_closure_mismatch
modified_after_updated
action_taken_without_description
resolution_without_closed
```

**13 signals total.** 3 were already DB-aggregated (the freshness-derived trio, PR #67). This PR
migrates **7 more**. That test passed unmodified both before and after the refactor — proving no
signal was dropped, reordered, relabeled, or had its severity/explanation/drillDownFilters changed.

## What moved to the database (7 signals)

| Signal | Source (no new query) |
| --- | --- |
| `missing_source_origin` | `aggregated.sourceOrigin` — find the `OPERATIONAL_UNSPECIFIED` bucket's `count` |
| `missing_source_status` | `aggregated.sourceStatus.unspecifiedCount` (already computed) |
| `missing_source_action_status` | `aggregated.sourceActionStatus.unspecifiedCount` (already computed) |
| `missing_wing_code` | `wingAggregated.metrics.unspecifiedCount` (already computed) |
| `source_status_vs_internal_mismatch` | `countSourceStatusInternalMismatch(sourceStatus.items)` — pure, sums `open`/`closed` per already-aggregated sourceStatus bucket against the same two regexes as before |
| `action_status_vs_closure_mismatch` | `countActionStatusClosureMismatch(sourceActionStatus.items)` — the `"جديد"` bucket's `closed` count |
| `closed_without_closed_at` | **1 new query**: `db.complaint.count({ status: {in: CLOSED_COMPLAINT_STATUSES}, closedAt: null })` |

All 6 no-new-query signals live in `operational-data-quality-aggregate-service.ts` as pure
functions (`buildAggregatedDataQualityCounts`, `countSourceStatusInternalMismatch`,
`countActionStatusClosureMismatch`) operating on already-resolved `OperationalBucketMetrics[]` /
`SourceStatusDistribution` / `ActionStatusDistribution` / `WingOperationalMetrics` — no I/O.

The regex constants (`SOURCE_STATUS_CLOSED_PATTERN`, `SOURCE_STATUS_OPEN_PATTERN`) are unchanged
in content, only centralized (previously inline in the row-scan `test:` closure).

### `closed_without_closed_at` — the one new query

`loadClosedWithoutClosedAtCount(where)` depends only on `where` and is started **immediately**, in
parallel with `aggregatedPromise`/`residualPromise` — not after dimension aggregation resolves.
`CLOSED_STATUS_VALUES` is derived from `CLOSED_COMPLAINT_STATUSES` (`Array.from(...)`), not
duplicated. The where clause combines with the caller's filters via an explicit `{ AND: [where,
condition] }`, never an object spread.

## Signals still Residual (3)

`closed_without_source_closed_by`, `action_taken_without_description`, `resolution_without_closed`
still need per-row text fields (`sourceClosedBy` / `actionTaken` / `actionDescription` /
`resolution` + `status`) and are computed by a single new pure function,
`buildResidualDataQualityCounts`, in one loop over the (now much slimmer) residual rows — not a
generic 13-signal loop anymore.

## Residual field count

| | Fields |
| --- | --- |
| Before (PR #67) | 15: `id, status, sourceOrigin, sourceStatus, sourceActionStatus, wingCode, actionTaken, actionDescription, resolution, sourceClosedBy, sourceUpdatedBy, complaintDate, receivedAt, dueDate, closedAt` |
| After | **6**: `status, actionTaken, actionDescription, resolution, sourceClosedBy, sourceUpdatedBy` |

Verified by search before deletion (`grep` across `operational-analytics-service.ts` for every
removed field name) — none of `id`, `sourceOrigin`, `sourceStatus`, `sourceActionStatus`,
`wingCode`, `complaintDate`, `receivedAt`, `dueDate`, `closedAt` had any other row-level consumer
once the 7 signals above moved to aggregates. `sourceUpdatedBy` is kept — it is read by
`staffActors`, untouched by this phase. A regression test in
`operational-data-quality-aggregate-service.test.ts` is not needed for the field-count assertion
specifically since it is already covered by the benchmark's `residualSelectFieldCount` diagnostic
and by `RESIDUAL_OPERATIONAL_SELECT`'s own updated doc comment.

`normalizeOperationalLabel` (only ever called from the now-removed row-scan closure) and the
now-unused `OPEN_COMPLAINT_STATUSES` import were deleted — grepped across the whole repo first to
confirm no other consumer.

## Parity

- **Explicit expected values, not just wiring**: both the dedicated test file
  (`operational-data-quality-aggregate-service.test.ts`) and the shared parity integration test
  assert concrete integers derived from the fixture (e.g. `sourceStatusVsInternalMismatch === 4`
  from 4 purpose-built rows: 2 open-with-closed-looking-status, 2 closed-with-open-looking-status),
  not only cross-field comparisons between two aggregates that could both be wrong the same way.
- **Whitespace parity**: `missing_source_origin` tested with `null`, `""`, and `"   "` — all 3
  collapse into the same `OPERATIONAL_UNSPECIFIED` bucket, matching the original
  `emptyStringOrNull` row-scan exactly (both use the same trim-based check). `missing_source_status`
  / `missing_source_action_status` spot-checked with `null` + whitespace. `"جديد"` /
  `" جديد "` / `"   جديد   "` all resolve to the same aggregated bucket for
  `action_status_vs_closure_mismatch`.
- **`closed_without_closed_at`**: `CLOSED` and `RESOLVED` with `closedAt: null` both count;
  `CANCELLED` with `closedAt: null` does **not** — matching `CLOSED_COMPLAINT_STATUSES` exactly.
- **Percentage edge cases**: 0-row scope → every signal's `percentage === 0`; 1-row and 3-row
  scopes verified directly. Rounding formula (`Math.round((part/total)*1000)/10`) untouched.
- **Base filter parity**: a combined `region + status + channel` filter's aggregated counts match
  `listComplaints` exactly for the scoped subset.
- **Actual SQL query count**: a query-event-instrumented second `PrismaClient` (`$on("query", …)`)
  measures real Prisma query events fired by `getOperationalAnalytics`, not just the service's own
  arithmetic — confirmed identical between a small and a large scope.

### A pre-existing whitespace drill-down gap, discovered — not fixed here

`applyCategoricalOrUnspecified` (`complaint-query-service.ts`, shared by every `<field>=value` and
`<field>=__UNSPECIFIED__` filter in the app) does **exact, untrimmed** DB-level comparisons:
`{ OR: [{field: null}, {field: ""}] }` for `__UNSPECIFIED__`, and `where[field] = value` for a
literal value. Neither trims. `categoricalKey` (used to build every aggregate bucket, including the
dimension aggregates from PR #62) **does** trim, matching the original row-scan's
`emptyStringOrNull` / `normalizeOperationalLabel` semantics.

Net effect: a whitespace-padded stored value (e.g. `"   "` for `missing_source_origin`, or
`" جديد "` for `action_status_vs_closure_mismatch`) is correctly counted in the **aggregate**
signal but is **not** matched by the corresponding drill-down link (`sourceOrigin=__UNSPECIFIED__`,
`sourceActionStatus=جديد`) — the drill-down under-reports by exactly the whitespace-padded rows.

This is **not introduced by this migration** — it is a pre-existing gap in
`applyCategoricalOrUnspecified` that has applied to the PR #62 dimension aggregates
(`sourceOrigin`/`sourceStatus`/`sourceActionStatus`/`wingCode` breakdowns) since they were first
introduced, and simply had no test that happened to probe a whitespace-padded value against
`listComplaints` until this phase's fixture did. Per this phase's explicit scope, it is **documented
and asserted exactly** (`operational-data-quality-aggregate-service.test.ts`, "documents a
pre-existing whitespace drill-down gap") rather than silently fixed — `complaint-query-service.ts`
is shared by every filterable field in the app, and changing its whitespace handling is a
cross-cutting change that belongs in its own reviewed PR, not folded into a data-quality
performance migration.

## Query count

| Path | Before | After |
| --- | --- | --- |
| `getOperationalAnalytics`, no previous period | 23 | **24** |

The +1 is exactly `loadClosedWithoutClosedAtCount`. Measured as **actual Prisma query events**
(not just the service's self-reported count) via a query-event-instrumented `PrismaClient`, at both
a small and a large row-count scope — identical in both, confirming no N+1.

## Benchmark (synthetic SQLite, `--cardinality=normal`, 3 runs per size, median)

### 20,000 rows

| Field | Baseline (median of 3) | After (median of 3) |
| --- | --- | --- |
| `totalMs` | 610 | 388 |
| `performanceMs.loadRows` | 589 | 216 |
| `performanceMs.dataQuality` (pure signal building) | 16 | 2 |
| `performanceMs.dataQualityAggregate` (new query) | — | 19 |
| Heap before → after (MB) | 36 → 84 | 35 → 21 |
| RSS before → after (MB) | 198 → 294 | 200 → 230 |
| `prismaQueries` | 23 | 24 |

### 100,000 rows

| Field | Baseline (median of 3) | After (median of 3) |
| --- | --- | --- |
| `totalMs` | 2,918 | 1,675 |
| `performanceMs.loadRows` | 2,861 | 946 |
| `performanceMs.dataQuality` | 43 | 4 |
| `performanceMs.dataQualityAggregate` | — | 80 |
| Heap before → after (MB) | 66 → 328 | 65 → 156 |
| RSS before → after (MB) | 290 → 883 | 294 → 501 |
| `prismaQueries` | 23 | 24 |

### 500,000 rows

| Field | Baseline (median of 3) | After (median of 3) |
| --- | --- | --- |
| `totalMs` | 20,399 | 10,883 |
| `performanceMs.loadRows` | 20,145 | 6,652 |
| `performanceMs.dataQuality` | — (not tracked separately in baseline) | 16 |
| `performanceMs.dataQualityAggregate` | — | 3,237 |
| Heap before → after (MB) | 13 → 1,050 | 27 → 673 |
| RSS before → after (MB) | 315 → 2,350 | 292 → 1,423 |
| `prismaQueries` | 23 | 24 |

`residualSelectFieldCount`: **6** at every size (confirmed from the running code, not asserted from
memory — matches the 15→6 target exactly).

## Honest interpretation

- **This phase's win is much larger than the freshness phase's**, and for a clear, mechanical
  reason: removing 9 fields (`id, sourceOrigin, sourceStatus, sourceActionStatus, wingCode,
  complaintDate, receivedAt, dueDate, closedAt`) from a per-row `SELECT`, plus collapsing a
  13-signal-per-row test loop down to a 3-signal one, directly shrinks both the SQLite→Node payload
  and the Node-side work proportionally to row count. `loadRows` alone dropped **~63–67%** at every
  tested size (589→216ms at 20k; 2,861→946ms at 100k; 20,145→6,652ms at 500k).
  `totalMs` dropped **36–47%**.
- **Heap and RSS medians (3 runs each) dropped at every size** — most clearly at 500k (heap
  1,050→673 MB, ~36% less; RSS 2,350→1,423 MB, ~39% less). Per the same standing caution as prior
  phase docs: `process.memoryUsage()` is a point-in-time sample around the call, not a peak-memory
  measurement; the claim here is limited to what 3-run medians support — a repeatable reduction in
  the sampled footprint, consistent with transferring and holding far fewer bytes per row.
- **`performanceMs.dataQualityAggregate` (the one new query) is not free, and its cost grows with
  row count** (19ms → 80ms → 3,237ms) because `status`/`closedAt` have no composite index for this
  exact filter shape, so it is a table scan at every size — same class of finding as the freshness
  phase's un-indexed `sourceUpdatedAt`/`sourceModifiedAt` queries, and out of scope to fix here
  (no schema changes this phase). It remains one query regardless of row count (no N+1), and it
  runs in parallel with the other aggregate work rather than serializing after it, which is why the
  overall `totalMs` win is still large despite this one query's own cost growing with scale.
- **`prismaQueries` moved from 23 to 24`** — a deliberate, fixed +1 replacing what was previously
  part of an unbounded, row-count-scaling Node loop (`closed_without_closed_at`'s row test), not a
  regression.

## Source database integrity

Only synthetic temporary SQLite databases (`--mode=synthetic`) were used for every benchmark;
`prisma/dev.db` was never written to, and no `prisma db push` / `migrate reset` / `updateMany` /
`deleteMany` / `VACUUM` ran against it at any point in this phase.

## Why Issue #63 stays open

`actionTakenQuality`, the 3 remaining residual data-quality signals
(`closed_without_source_closed_by`, `action_taken_without_description`, `resolution_without_closed`),
`staffActors`, and the final removal/reduction of `RESIDUAL_OPERATIONAL_SELECT` are still
outstanding, planned as follow-up phases per the task's own suggested ordering
(`actionTakenQuality` + `action_taken_without_description`, then `staffActors` +
`closed_without_source_closed_by`, then `resolution_without_closed` / final residual cleanup).
