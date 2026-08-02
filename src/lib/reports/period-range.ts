const DAY_MS = 24 * 60 * 60 * 1000;

export type InclusiveDateRange = { from: Date; to: Date };
export type HalfOpenDateRange = { from: Date; toExclusive: Date };

function isCompleteUtcCalendarMonth(from: Date, toExclusive: Date): boolean {
  if (from.getUTCDate() !== 1 || toExclusive.getUTCDate() !== 1) return false;
  const nextMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return nextMonth.getTime() === toExclusive.getTime();
}

export function previousHalfOpenPeriod(from: Date, toExclusive: Date): HalfOpenDateRange | null {
  const duration = toExclusive.getTime() - from.getTime();
  if (duration <= 0) return null;
  if (isCompleteUtcCalendarMonth(from, toExclusive)) {
    return {
      from: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1)),
      toExclusive: from,
    };
  }
  return { from: new Date(from.getTime() - duration), toExclusive: from };
}

export function previousInclusivePeriod(from: Date, to: Date): InclusiveDateRange | null {
  if (to.getTime() < from.getTime()) return null;
  const previous = previousHalfOpenPeriod(from, new Date(to.getTime() + DAY_MS));
  if (!previous) return null;
  return { from: previous.from, to: new Date(previous.toExclusive.getTime() - DAY_MS) };
}
