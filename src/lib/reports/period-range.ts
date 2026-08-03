import type { ComparisonMode } from "./report-contract";

const DAY_MS = 24 * 60 * 60 * 1000;

export type InclusiveDateRange = { from: Date; to: Date };
export type HalfOpenDateRange = { from: Date; toExclusive: Date };

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function previousHalfOpenPeriod(from: Date, toExclusive: Date): HalfOpenDateRange | null {
  const duration = toExclusive.getTime() - from.getTime();
  if (duration <= 0) return null;
  return { from: new Date(from.getTime() - duration), toExclusive: from };
}

function previousYearUtcDate(date: Date): Date {
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

export function comparisonHalfOpenPeriod(
  from: Date,
  toExclusive: Date,
  mode: ComparisonMode
): HalfOpenDateRange | null {
  if (toExclusive.getTime() <= from.getTime()) return null;
  if (mode === "SAME_PERIOD_LAST_YEAR") {
    return {
      from: previousYearUtcDate(from),
      toExclusive: previousYearUtcDate(toExclusive),
    };
  }
  return previousHalfOpenPeriod(from, toExclusive);
}

export function previousInclusivePeriod(
  from: Date,
  to: Date,
  mode: ComparisonMode = "PREVIOUS_EQUIVALENT_PERIOD"
): InclusiveDateRange | null {
  const normalizedFrom = startOfUtcDay(from);
  const normalizedTo = startOfUtcDay(to);
  if (normalizedTo.getTime() < normalizedFrom.getTime()) return null;
  const previous = comparisonHalfOpenPeriod(
    normalizedFrom,
    new Date(normalizedTo.getTime() + DAY_MS),
    mode
  );
  if (!previous) return null;
  return { from: previous.from, to: new Date(previous.toExclusive.getTime() - DAY_MS) };
}
