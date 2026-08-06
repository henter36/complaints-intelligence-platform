# Operational analytics — Phase 2 (wing aggregates)

Refs: Issue #63 (left open; freshness / dataQuality / actionTakenQuality / staffActors still residual).

## Scope in this PR

| Metric | Method |
| --- | --- |
| Wing `count` / `open` / `closed` | `groupBy([wingCode, status])` |
| Wing `currentlyLate` | one `groupBy([wingCode])` with `buildCurrentlyLateWhere` |
| Wing `topClassification` | `groupBy([wingCode, classificationId])` + one `classification.findMany` |
| Display | top 40 by count, unspecified excluded from items |

Bucket identity remains **`wingCode` only** (not `facility + wingCode`) to preserve API / drill-down compatibility.

## Still on residual row load

- `freshness`
- `actionTakenQuality`
- `dataQuality` (still uses `wingCode` for `missing_wing_code`)
- `staffActors`

`RESIDUAL_OPERATIONAL_SELECT` no longer includes `classification` (wing top classification is resolved via aggregate + lookup).

## Query count (default, no previous period)

| Stage | Queries |
| --- | --- |
| Phase 1 dimensions (count + groupBys + resolution + residual findMany) | 11 |
| Wing status / late / classification groupBy | +3 |
| Classification name lookup (when any id present) | +0–1 |
| **Typical total** | **15** |

Query count does **not** scale with the number of wing buckets (no N+1).

## Read-only on ~26,006 in-scope rows

Script: `scripts/benchmark-operational-analytics.ts --mode=read-only-current`, run three times
back-to-back against `prisma/dev.db` with the dev server and any other SQLite connection
stopped first. Each run is a fresh `tsx` process; numbers below are copied verbatim from the
three `.tmp/phase2-wing-readonly-{1,2,3}.json` outputs, not hand-edited.

| Run | Heap before → after (MB) | RSS before → after (MB) | Wall `totalMs` | `wingAggregate` ms | `prismaQueries` | `sourceUnchanged` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 16 → 147 | 424 → 446 | 1,419 | 114 | 15 | true |
| 2 | 14 → 164 | 76 → 470 | 1,360 | 297 | 15 | true |
| 3 | 14 → 164 | 75 → 446 | 1,488 | 299 | 15 | true |
| **Per-field median of the 3 runs** | **14 → 164** | **76 → 446** | **1,419** | **297** | **15** | **true** |

The per-field median row is what's referenced elsewhere in this document as "the" read-only
number; it is **not** a single run's output — each column's median is taken independently
across the 3 runs.

**RSS in all 3 runs increased, not decreased**, from process start to completion (as expected,
since the process loads ~26k rows and their aggregates into memory). This directly supersedes
an earlier version of this document that reported a `353 → 227 MB` RSS *decrease*; that number
was not reproducible under a clean re-run with the dev server stopped and is retracted.

> RSS is a process-wide point-in-time measurement. The observed decrease can result from V8 or
> operating-system memory reclamation during the benchmark and must not be interpreted as
> negative memory consumption or as a measured reduction in peak RSS.

This applies symmetrically to increases: neither the Heap nor the RSS numbers above are peak
memory — `process.memoryUsage()` is sampled once immediately before and once immediately after
`getOperationalAnalytics()` runs, so any transient spike in between (e.g. during row loading)
is not captured. **The wing-metrics DB-aggregation change in this PR should not be represented
as having reduced memory usage based on RSS deltas alone** — `prismaQueries` staying flat at 15
(no N+1) is the load-bearing claim this benchmark supports.

### Source database integrity

| Field | Value |
| --- | --- |
| Source database SHA-256 before → after | identical (`ea4810b2a325…` truncated, full match in each of the 3 runs) |

> The SHA-256 refers to the original SQLite source file `prisma/dev.db`, measured before and
> after the read-only benchmark. The benchmark runs against a consistent temporary snapshot and
> does not modify the original source database.

## Synthetic 20k

| Field | Value |
| --- | --- |
| Wall `totalMs` | 1,160 ms |
| `loadRows` | 1,096 ms |
| `wingAggregate` | 39 ms |
| Heap before → after | 28 → 91 MB |
| RSS before → after | 153 → 291 MB |
| `prismaQueries` | 15 |

## Why Issue #63 stays open

Only wing metrics moved to DB aggregates. Remaining residual metrics and a future `facility + wingCode` bucket redesign are still outstanding.
