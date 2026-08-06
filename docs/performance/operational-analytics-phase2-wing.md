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

## Read-only on ~16,993 in-scope rows

Script: `scripts/benchmark-operational-analytics.ts --mode=read-only-current`

| Field | Value |
| --- | --- |
| Wall `totalMs` | 1,273 ms |
| `loadRows` / `residualRows` | 1,153 ms |
| `wingCode` / `wingAggregate` | 177 ms |
| `aggregateDimensions` | 205 ms |
| Heap before → after | 16 → 83 MB |
| RSS before → after | 353 → 227 MB |
| `prismaQueries` | 15 |
| Source SHA | unchanged |

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
