# Operational analytics — Phase 1 DB aggregates

Refs: Issue #59 (left open; residual metrics still row-loaded).

## Scope moved to DB aggregates

| Metric | Method |
| --- | --- |
| `totalInScope` | `db.complaint.count` |
| `sourceOrigin` count/open/closed | `groupBy([sourceOrigin, status])` |
| `sourceStatus` count/open/closed | `groupBy([sourceStatus, status])` |
| `sourceActionStatus` count/open/closed | `groupBy([sourceActionStatus, status])` |
| `currentlyLate` (per dimension) | one `groupBy([dimension])` with `buildCurrentlyLateWhere` |
| `averageResolutionDays` | one narrow `findMany` (`closedAt not null`) for all three dimensions |
| previous-period `sourceOrigin` | existing `groupBy([sourceOrigin])` moved into aggregate layer |
| `channelIndependentCheck` | `groupBy([channel])` + `groupBy([sourceOrigin])` |

No `$queryRaw`, no `take`/`skip`/sampling for totals, no schema migration.

## Still on residual row load (`RESIDUAL_OPERATIONAL_SELECT`)

- `wing`
- `freshness`
- `actionTakenQuality`
- `dataQuality`
- `staffActors`

`performanceMs.loadRows` is the time to load **residual** rows only (not full analytics I/O).

## Why Issue #59 stays open

Phase 1 removes full-row aggregation only for the three categorical dimensions above. Wing/freshness/quality/staff still download in-scope rows into Node, so peak memory and wall time remain dominated by residual load until later phases.

## Before (main @ d618151, read-only probe on `prisma/dev.db` copy)

Measured with `.tmp/baseline-operational-analytics.mts` (no writes to `dev.db`).

| Field | Value |
| --- | --- |
| In-scope complaints | 16,993 |
| Table rows (all) | 29,939 |
| `performanceMs.loadRows` | 1,801 ms |
| Metric CPU (origin/status/action/wing/freshness/actionTaken/dataQuality) | ~244 ms |
| Approx. wall (load + metrics) | ~2,045 ms |
| Heap before → after | 16 → 86 MB |
| RSS before → after | 72 → 275 MB |
| Prisma queries | 1× `findMany` (+ optional previous `groupBy`) |
| `dev.db` SHA-256 | `0241a3ef186091cbbb32cc48b78216784553bacccc573cdb50c2ddc760416f33` (unchanged) |

Top `sourceOrigin` (unchanged after): الجهاز الرئيسي 11321 / main 4726 / منطقة عسير 580.

## After (phase 1 branch, same dataset, read-only copy)

Script: `scripts/benchmark-operational-analytics.ts --mode=read-only-current`.

| Field | Value |
| --- | --- |
| In-scope complaints | 16,993 |
| Wall `totalMs` | 1,862 ms |
| `performanceMs.loadRows` / `residualRows` | 1,694 ms |
| `aggregateDimensions` | 229 ms |
| `resolutionRows` | 29 ms |
| Heap before → after | 15 → 79 MB |
| RSS before → after | 87 → 289 MB |
| Prisma queries | **12** (fixed; independent of bucket cardinality) |
| `dev.db` SHA-256 | unchanged (`sourceUnchanged: true`) |

### Interpretation

- Numeric parity for migrated dimensions matches the before probe (counts/open/closed/late/averages/channel keys).
- Peak heap did not increase (86 → 79 MB).
- Wall time did not increase by more than 20% (~2,045 → 1,862 ms).
- Residual `findMany` still dominates cost; migrated dimensions no longer drive that load.
- Query count rose from ~1–2 to 12 but is **O(1)** vs bucket count (no N+1).

## Synthetic 20k (temporary DB)

`scripts/benchmark-operational-analytics.ts --mode=synthetic --size=20000`

| Field | Value |
| --- | --- |
| Rows | 20,000 |
| Wall `totalMs` | 1,691 ms |
| `aggregateDimensions` | 118 ms |
| `resolutionRows` | 533 ms |
| `residualRows` | 1,566 ms |
| Heap before → after | 36 → 97 MB |
| RSS before → after | 186 → 321 MB |
| Prisma queries | 12 |

Sizes `100000` and `500000` are supported by the script flags but are **not** run in CI.

## Divergence note (unchanged behavior)

List item field `isLate` can be true for `wasClosedLate`, while list filter `isLate=true` and operational `currentlyLate` use **currently overdue open** complaints only (`buildCurrentlyLateWhere`). This PR does not redefine lateness; it centralizes the existing filter/analytics predicate.
