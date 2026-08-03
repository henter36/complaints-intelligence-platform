export type ComparisonState =
  | "UNAVAILABLE"
  | "NEW"
  | "NO_CHANGE"
  | "INCREASE"
  | "DECREASE";

export type ComparisonEvaluation = {
  current: number;
  previous: number | null;
  difference: number | null;
  changeRate: number | null;
  state: ComparisonState;
  label: "غير متاح" | "جديد" | "لا تغير" | "ارتفاع" | "انخفاض";
};

function assertNonNegativeFinite(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a finite non-negative number`);
  }
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Single comparison policy for analytics, reports, previews and exports.
 *
 * Rules:
 * - no comparison period => unavailable
 * - previous = 0 and current > 0 => new (never 100%)
 * - previous = 0 and current = 0 => no change
 * - otherwise return the real difference and percentage change
 */
export function evaluateComparison(
  current: number,
  previous: number | null | undefined,
  hasComparisonPeriod: boolean
): ComparisonEvaluation {
  assertNonNegativeFinite(current, "current");

  if (!hasComparisonPeriod || previous == null) {
    return {
      current,
      previous: null,
      difference: null,
      changeRate: null,
      state: "UNAVAILABLE",
      label: "غير متاح",
    };
  }

  assertNonNegativeFinite(previous, "previous");

  const difference = current - previous;

  if (previous === 0) {
    if (current === 0) {
      return {
        current,
        previous,
        difference,
        changeRate: null,
        state: "NO_CHANGE",
        label: "لا تغير",
      };
    }

    return {
      current,
      previous,
      difference,
      changeRate: null,
      state: "NEW",
      label: "جديد",
    };
  }

  if (difference === 0) {
    return {
      current,
      previous,
      difference,
      changeRate: 0,
      state: "NO_CHANGE",
      label: "لا تغير",
    };
  }

  const changeRate = roundOneDecimal((difference / previous) * 100);

  return {
    current,
    previous,
    difference,
    changeRate,
    state: difference > 0 ? "INCREASE" : "DECREASE",
    label: difference > 0 ? "ارتفاع" : "انخفاض",
  };
}
