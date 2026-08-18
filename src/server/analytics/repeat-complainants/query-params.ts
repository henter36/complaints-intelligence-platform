export type PositiveIntegerParamOptions = {
  /** Values below this are treated as invalid (fall back), never clamped up. Default 1. */
  min?: number;
  /** Values above this are clamped DOWN to this ceiling (never rejected) — e.g. a `pageSize=999999` becomes the max page size, not "no limit". Default Number.MAX_SAFE_INTEGER (effectively no cap). */
  max?: number;
  /** Returned for a missing/malformed/out-of-range(low) value. Default `undefined` — "no override, caller applies its own default". */
  fallback?: number;
};

/**
 * The ONE numeric-query-param parser for every repeat-complainant endpoint
 * (minComplaints, minDistinctTypes, topFacilities, page, pageSize, ...) —
 * shared rather than re-implemented per service (Sourcery: keep NaN handling
 * consistent between the summary and people services). A raw `Number(value)`
 * silently produces `NaN` for garbage input, which then poisons downstream
 * `Math.max`/array-length comparisons (e.g. `length >= NaN` is always
 * `false`), silently dropping every result instead of failing loudly or
 * falling back — this rejects NaN, Infinity, negative numbers, and
 * fractions outright (falls back) and clamps anything over `max` down to
 * `max` (never up, never rejected) rather than either extreme leaking into
 * an aggregation or a Prisma `take`/`skip`.
 */
export function parsePositiveIntegerParam(
  raw: string | null | undefined,
  options: PositiveIntegerParamOptions = {}
): number | undefined {
  const { min = 1, max = Number.MAX_SAFE_INTEGER, fallback = undefined } = options;
  if (raw === null || raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback; // rejects NaN and +/-Infinity
  if (!Number.isInteger(value)) return fallback; // rejects fractions (e.g. 2.5)
  if (value < min) return fallback;
  if (value > max) return max;
  return value;
}
