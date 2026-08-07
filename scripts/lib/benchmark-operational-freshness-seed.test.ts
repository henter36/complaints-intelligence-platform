import { describe, expect, it } from "vitest";
import {
  BENCHMARK_NOW,
  DAY_MS,
  HOUR_MS,
  MAX_HIGH_CARDINALITY_ROWS,
  assertSupportedSyntheticCardinality,
  sourceModifiedAtForRow,
  sourceUpdatedAtForRow,
} from "./benchmark-operational-freshness-seed";

/**
 * Regression guard for Issue #63 phase 3: an earlier version of the "high"
 * cardinality generator used `(i * 400) % 40_000_000`, which wrapped around
 * well before 500,000 rows and silently capped cardinality at ~80,000
 * distinct timestamps regardless of dataset size — understating the
 * groupBy stop-condition risk at scale. These tests fail if that modulo
 * (or any other cap) is reintroduced.
 */
function countDistinctUpdatedTimestamps(size: number, cardinality: "normal" | "high"): number {
  const seen = new Set<number>();
  for (let i = 0; i < size; i += 1) {
    const value = sourceUpdatedAtForRow(i, cardinality);
    if (value !== null) seen.add(value.getTime());
  }
  return seen.size;
}

function countNonNullPairs(size: number, cardinality: "normal" | "high"): number {
  let count = 0;
  for (let i = 0; i < size; i += 1) {
    const updated = sourceUpdatedAtForRow(i, cardinality);
    const modified = sourceModifiedAtForRow(i, updated);
    if (updated !== null && modified !== null) count += 1;
  }
  return count;
}

describe("sourceUpdatedAtForRow", () => {
  it("places exactly 1/5 of rows in each of the 5 buckets, bucket 4 always missing", () => {
    const size = 10_000;
    let missing = 0;
    for (let i = 0; i < size; i += 1) {
      if (sourceUpdatedAtForRow(i, "normal") === null) missing += 1;
    }
    expect(missing).toBe(size / 5);
  });

  it("never returns a timestamp past the boundary of its own bucket, even at the largest offsets (i near 500,000)", () => {
    const sampleIndices = [0, 1, 2, 3, 499_995, 499_996, 499_997, 499_998, 499_999];
    for (const cardinality of ["normal", "high"] as const) {
      for (const i of sampleIndices) {
        const value = sourceUpdatedAtForRow(i, cardinality);
        if (value === null) continue;
        const ageMs = BENCHMARK_NOW.getTime() - value.getTime();
        const bucket = i % 5;
        if (bucket === 0) expect(ageMs, `cardinality=${cardinality} i=${i}`).toBeLessThan(DAY_MS);
        if (bucket === 1) {
          expect(ageMs, `cardinality=${cardinality} i=${i}`).toBeGreaterThan(DAY_MS);
          expect(ageMs, `cardinality=${cardinality} i=${i}`).toBeLessThanOrEqual(3 * DAY_MS);
        }
        if (bucket === 2) {
          expect(ageMs, `cardinality=${cardinality} i=${i}`).toBeGreaterThan(3 * DAY_MS);
          expect(ageMs, `cardinality=${cardinality} i=${i}`).toBeLessThanOrEqual(7 * DAY_MS);
        }
        if (bucket === 3) expect(ageMs, `cardinality=${cardinality} i=${i}`).toBeGreaterThan(7 * DAY_MS);
      }
    }
  });

  it("normal cardinality: distinct sourceUpdatedAt values stay ~400 regardless of dataset size", () => {
    expect(countDistinctUpdatedTimestamps(20_000, "normal")).toBe(400);
    expect(countDistinctUpdatedTimestamps(100_000, "normal")).toBe(400);
    expect(countDistinctUpdatedTimestamps(500_000, "normal")).toBe(400);
  });

  it("high cardinality: distinct sourceUpdatedAt values scale linearly with dataset size (no modulo wraparound)", () => {
    // 4 non-missing buckets, each row within a bucket gets its own unique
    // offset — so distinct count == number of non-missing rows exactly.
    expect(countDistinctUpdatedTimestamps(100_000, "high")).toBe(80_000);
    expect(countDistinctUpdatedTimestamps(500_000, "high")).toBe(400_000);
  });

  it("MAX_HIGH_CARDINALITY_ROWS boundary: the last safe bucket-0 (fresh_1d) index stays fresh, the first unsafe index does not", () => {
    // The largest bucket-0 (i % 5 === 0) index within a MAX_HIGH_CARDINALITY_ROWS-sized
    // dataset (indices 0..MAX_HIGH_CARDINALITY_ROWS - 1) is
    // MAX_HIGH_CARDINALITY_ROWS - 5, since MAX_HIGH_CARDINALITY_ROWS - 1 itself
    // is bucket 4 (missing). It must still resolve to fresh_1d (age < 24h).
    const lastSafeIndex = MAX_HIGH_CARDINALITY_ROWS - 5;
    expect(lastSafeIndex % 5).toBe(0);
    const lastSafeValue = sourceUpdatedAtForRow(lastSafeIndex, "high");
    expect(lastSafeValue).not.toBeNull();
    const lastSafeAgeMs = BENCHMARK_NOW.getTime() - lastSafeValue!.getTime();
    expect(lastSafeAgeMs).toBeLessThan(DAY_MS);
    expect(lastSafeAgeMs).toBeGreaterThan(DAY_MS - HOUR_MS / 60); // within a minute of the 24h boundary

    // Index MAX_HIGH_CARDINALITY_ROWS itself (only reachable by a dataset of
    // MAX_HIGH_CARDINALITY_ROWS + 1 rows or more — exactly what
    // assertSupportedSyntheticCardinality rejects) breaks the boundary: it
    // lands in stale_1_3d instead of fresh_1d. This is *why* the limit exists.
    expect(MAX_HIGH_CARDINALITY_ROWS % 5).toBe(0);
    const firstUnsafeValue = sourceUpdatedAtForRow(MAX_HIGH_CARDINALITY_ROWS, "high");
    expect(firstUnsafeValue).not.toBeNull();
    const firstUnsafeAgeMs = BENCHMARK_NOW.getTime() - firstUnsafeValue!.getTime();
    expect(firstUnsafeAgeMs).toBeGreaterThanOrEqual(DAY_MS);
  });
});

describe("assertSupportedSyntheticCardinality", () => {
  it("never throws for normal cardinality, at any size", () => {
    expect(() => assertSupportedSyntheticCardinality(MAX_HIGH_CARDINALITY_ROWS, "normal")).not.toThrow();
    expect(() => assertSupportedSyntheticCardinality(MAX_HIGH_CARDINALITY_ROWS + 1, "normal")).not.toThrow();
    expect(() => assertSupportedSyntheticCardinality(Number.MAX_SAFE_INTEGER, "normal")).not.toThrow();
  });

  it("allows high cardinality up to and including MAX_HIGH_CARDINALITY_ROWS", () => {
    expect(() => assertSupportedSyntheticCardinality(500_000, "high")).not.toThrow();
    expect(() => assertSupportedSyntheticCardinality(MAX_HIGH_CARDINALITY_ROWS, "high")).not.toThrow();
  });

  it("rejects high cardinality above MAX_HIGH_CARDINALITY_ROWS", () => {
    expect(() => assertSupportedSyntheticCardinality(MAX_HIGH_CARDINALITY_ROWS + 1, "high")).toThrow(
      `high-cardinality synthetic benchmark supports at most ${MAX_HIGH_CARDINALITY_ROWS} rows to preserve freshness bucket boundaries`
    );
  });
});

describe("sourceModifiedAtForRow", () => {
  it("is always null when sourceUpdatedAt is null", () => {
    for (let i = 0; i < 1000; i += 1) {
      if (sourceUpdatedAtForRow(i, "normal") === null) {
        expect(sourceModifiedAtForRow(i, null)).toBeNull();
      }
    }
  });

  it("exactly half of all rows have both timestamps non-null, at any cardinality", () => {
    // Independent of cardinality: pair-eligibility depends only on i % 5
    // (updated non-null) and i % 10 (modified non-null), not on the offset.
    expect(countNonNullPairs(100_000, "normal")).toBe(50_000);
    expect(countNonNullPairs(100_000, "high")).toBe(50_000);
    expect(countNonNullPairs(500_000, "high")).toBe(250_000);
  });
});
