import { evaluateComparison } from "./comparison-evaluation";
import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "./pattern-analysis-config";

/**
 * Classifies how a metric (a facility×classification complaint count, a
 * facility total, etc.) has moved across several consecutive measurement
 * periods. This replaces "current vs previous only" comparisons (spec §2)
 * with a small deterministic state machine so a report can say *how long*
 * and *what kind* of pattern is happening, not just up/down.
 */
export const TREND_PATTERNS = [
  "CONTINUED_RISE",
  "ESCALATING",
  "NO_MEANINGFUL_IMPROVEMENT",
  "SUSTAINED_IMPROVEMENT",
  "RELAPSE_AFTER_IMPROVEMENT",
  "EMERGING",
  "VOLATILE",
  "STABLE",
  "INSUFFICIENT_DATA",
] as const;

export type TrendPattern = (typeof TREND_PATTERNS)[number];

export type TrendClassification = {
  pattern: TrendPattern;
  /** Trailing periods (ending at the current one) that support the classification. */
  streakPeriods: number;
  /** How many of the periods in the window were at/above the signal threshold. */
  occurrencesAboveThreshold: number;
  /** Total periods considered. */
  periodsConsidered: number;
  /** Percent change from the first period in the window to the current one; null if the first value is 0. */
  overallChangePercent: number | null;
  /** Present only for RELAPSE_AFTER_IMPROVEMENT: how many periods the prior improvement lasted. */
  priorImprovementPeriods: number | null;
  /** Human-readable Arabic sentence describing how long the pattern has held (spec §4). */
  durationLabel: string;
};

function isElevated(count: number, config: PatternAnalysisConfig): boolean {
  return count >= config.minComplaintsForSignal;
}

export type PeriodUnit = "فترة" | "شهر";

const PERIOD_UNIT_FORMS: Record<PeriodUnit, { singular: string; dual: string; plural: string }> = {
  "فترة": { singular: "فترة", dual: "فترتين", plural: "فترات" },
  "شهر": { singular: "شهر", dual: "شهرين", plural: "أشهر" },
};

/** Arabic count-noun agreement: 1=singular, 2=dual, 3-10=plural, 11+=singular. */
export function formatPeriodCount(count: number, unit: PeriodUnit = "فترة"): string {
  const forms = PERIOD_UNIT_FORMS[unit];
  if (count === 1) return forms.singular;
  if (count === 2) return forms.dual;
  if (count >= 3 && count <= 10) return `${count} ${forms.plural}`;
  return `${count} ${forms.singular}`;
}

/** Trailing run length (from the end) where `predicate` holds for each consecutive pair. */
function trailingRunLength(values: number[], predicate: (curr: number, prev: number) => boolean): number {
  let run = 1;
  for (let i = values.length - 1; i > 0; i--) {
    if (predicate(values[i], values[i - 1])) {
      run += 1;
    } else {
      break;
    }
  }
  return run;
}

/**
 * Number of trailing consecutive STEPS (not elements) satisfying predicate.
 * A single real drop preceded by flat periods must count as one step, not
 * as a multi-period streak — otherwise a plateau-then-one-drop looks like a
 * sustained decline (spec §14: a single-period drop is never "sustained").
 */
function trailingStepRun(values: number[], predicate: (curr: number, prev: number) => boolean): number {
  let steps = 0;
  for (let i = values.length - 1; i > 0; i--) {
    if (predicate(values[i], values[i - 1])) {
      steps += 1;
    } else {
      break;
    }
  }
  return steps;
}

function countSignFlips(values: number[]): number {
  const diffs = values.slice(1).map((v, i) => v - values[i]).filter((d) => d !== 0);
  let flips = 0;
  for (let i = 1; i < diffs.length; i++) {
    if ((diffs[i] > 0) !== (diffs[i - 1] > 0)) flips += 1;
  }
  return flips;
}

function overallChange(first: number, last: number): { difference: number; changeRate: number | null } {
  const evaluation = evaluateComparison(last, first, true);
  return { difference: evaluation.difference ?? last - first, changeRate: evaluation.changeRate };
}

function buildDurationLabel(
  pattern: TrendPattern,
  streakPeriods: number,
  occurrencesAboveThreshold: number,
  periodsConsidered: number,
  priorImprovementPeriods: number | null,
  periodUnit: PeriodUnit
): string {
  switch (pattern) {
    case "CONTINUED_RISE":
      return `مرتفعة خلال آخر ${formatPeriodCount(streakPeriods, periodUnit)}`;
    case "NO_MEANINGFUL_IMPROVEMENT":
      return `دون تحسن ملموس خلال آخر ${formatPeriodCount(streakPeriods, periodUnit)}`;
    case "ESCALATING":
      return `في تصاعد مستمر منذ ${formatPeriodCount(streakPeriods, periodUnit)}`;
    case "SUSTAINED_IMPROVEMENT":
      return `في تحسن مستمر منذ ${formatPeriodCount(streakPeriods, periodUnit)}`;
    case "RELAPSE_AFTER_IMPROVEMENT":
      return priorImprovementPeriods
        ? `عادت للارتفاع بعد ${formatPeriodCount(priorImprovementPeriods, periodUnit)} من التحسن`
        : `عادت للارتفاع بعد تحسن سابق`;
    case "EMERGING":
      return `ظهرت حديثاً في آخر ${formatPeriodCount(1, periodUnit)}`;
    case "VOLATILE":
      return `ظهرت في ${occurrencesAboveThreshold} من آخر ${formatPeriodCount(periodsConsidered, periodUnit)} دون استقرار`;
    case "STABLE":
      return `مستقرة دون إشارة خلال آخر ${formatPeriodCount(periodsConsidered, periodUnit)}`;
    case "INSUFFICIENT_DATA":
    default:
      return `بيانات غير كافية للحكم على الاتجاه`;
  }
}

/**
 * `counts` must be ordered oldest → newest; the last element is the current
 * period. Returns INSUFFICIENT_DATA rather than a guess when the window is
 * too short to distinguish a real pattern from noise (spec §19).
 */
export function classifyTrend(
  counts: readonly number[],
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG,
  periodUnitLabel: PeriodUnit = "فترة"
): TrendClassification {
  const periodsConsidered = counts.length;
  const values = [...counts];
  const current = values[values.length - 1] ?? 0;
  const first = values[0] ?? 0;
  const { changeRate } = overallChange(first, current);
  const occurrencesAboveThreshold = values.filter((v) => isElevated(v, config)).length;

  if (periodsConsidered < config.minPeriodsForContinuity) {
    return {
      pattern: "INSUFFICIENT_DATA",
      streakPeriods: 0,
      occurrencesAboveThreshold,
      periodsConsidered,
      overallChangePercent: changeRate,
      priorImprovementPeriods: null,
      durationLabel: buildDurationLabel("INSUFFICIENT_DATA", 0, occurrencesAboveThreshold, periodsConsidered, null, periodUnitLabel),
    };
  }

  const elevatedStreak = trailingElevatedStreak(values, config);
  const risingStreak = trailingRunLength(values, (curr, prev) => curr >= prev);
  // Strict, step-counted: a real multi-period decline, not "not rising".
  const decliningSteps = trailingStepRun(values, (curr, prev) => curr < prev);
  const decliningStreak = decliningSteps > 0 ? decliningSteps + 1 : 0;

  // 1. EMERGING — essentially absent before, real signal now.
  const priorValues = values.slice(0, -1);
  if (isElevated(current, config) && priorValues.length > 0 && priorValues.every((v) => !isElevated(v, config))) {
    return finalize("EMERGING", 1, occurrencesAboveThreshold, periodsConsidered, changeRate, null, periodUnitLabel);
  }

  // 2. RELAPSE_AFTER_IMPROVEMENT — a decline into a trough, then a material rebound.
  const relapse = detectRelapse(values, config);
  if (relapse) {
    return finalize(
      "RELAPSE_AFTER_IMPROVEMENT",
      relapse.streakPeriods,
      occurrencesAboveThreshold,
      periodsConsidered,
      changeRate,
      relapse.priorImprovementPeriods,
      periodUnitLabel
    );
  }

  // 3. ESCALATING — monotonic non-decreasing across the whole window with a material overall rise.
  if (
    risingStreak === periodsConsidered &&
    isElevated(current, config) &&
    changeRate !== null &&
    changeRate >= config.materialChangeRatePercent
  ) {
    return finalize("ESCALATING", periodsConsidered, occurrencesAboveThreshold, periodsConsidered, changeRate, null, periodUnitLabel);
  }

  // 4. SUSTAINED_IMPROVEMENT — a real, multi-period decline (never a single-period drop).
  if (
    decliningSteps >= config.minSustainedImprovementPeriods &&
    changeRate !== null &&
    changeRate <= -config.improvementDropPercent
  ) {
    return finalize("SUSTAINED_IMPROVEMENT", decliningStreak, occurrencesAboveThreshold, periodsConsidered, changeRate, null, periodUnitLabel);
  }

  // 5. CONTINUED_RISE — stayed at/above the signal threshold for the required streak.
  if (elevatedStreak >= config.minPeriodsForContinuity) {
    const meaningfulDrop = changeRate !== null && changeRate <= -config.improvementDropPercent;
    if (!meaningfulDrop) {
      return finalize("CONTINUED_RISE", elevatedStreak, occurrencesAboveThreshold, periodsConsidered, changeRate, null, periodUnitLabel);
    }
    return finalize("NO_MEANINGFUL_IMPROVEMENT", elevatedStreak, occurrencesAboveThreshold, periodsConsidered, changeRate, null, periodUnitLabel);
  }

  // 6. VOLATILE — direction keeps flipping without settling into improvement.
  if (countSignFlips(values) >= 2 && occurrencesAboveThreshold >= config.minPeriodsForContinuity) {
    return finalize("VOLATILE", periodsConsidered, occurrencesAboveThreshold, periodsConsidered, changeRate, null, periodUnitLabel);
  }

  return finalize("STABLE", 0, occurrencesAboveThreshold, periodsConsidered, changeRate, null, periodUnitLabel);
}

function trailingElevatedStreak(values: number[], config: PatternAnalysisConfig): number {
  let streak = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (isElevated(values[i], config)) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Looks for: elevated period(s) → a real decline (trough) → a material
 * rebound back up in the current period. Only the trailing 3+ periods are
 * examined; this intentionally does not scan the whole window for every
 * possible peak/trough pair (spec §2's "عودة المشكلة بعد تحسن سابق" is a
 * recent-history signal, not an archaeological one).
 */
function detectRelapse(
  values: number[],
  config: PatternAnalysisConfig
): { streakPeriods: number; priorImprovementPeriods: number } | null {
  if (values.length < 3) return null;
  const current = values[values.length - 1];
  if (!isElevated(current, config)) return null;

  // Find the trailing decline run ending at the period just before current.
  const priorSeries = values.slice(0, -1);
  const declineStreak = trailingRunLength(priorSeries, (curr, prev) => curr <= prev);
  if (declineStreak < 2) return null; // need a real (not single-point) decline before the rebound

  const trough = priorSeries[priorSeries.length - 1];
  const peakIndex = priorSeries.length - declineStreak;
  const peakBeforeDecline = priorSeries[peakIndex];
  const droppedMeaningfully =
    peakBeforeDecline > 0 &&
    ((peakBeforeDecline - trough) / peakBeforeDecline) * 100 >= config.improvementDropPercent;
  if (!droppedMeaningfully) return null;

  // The "peak" must be a genuine local high, not a mid-oscillation bump lower
  // than an even earlier spike — otherwise ongoing volatility gets
  // misread as one clean decline-then-relapse (spec §2 distinguishes the two).
  const earlierValues = priorSeries.slice(0, peakIndex);
  const earlierMax = earlierValues.length > 0 ? Math.max(...earlierValues) : 0;
  if (peakBeforeDecline < earlierMax) return null;

  const rebound = evaluateComparison(current, trough, true);
  const reboundMaterial = rebound.changeRate !== null && rebound.changeRate >= config.materialChangeRatePercent;
  if (!reboundMaterial) return null;

  return { streakPeriods: 1, priorImprovementPeriods: declineStreak - 1 };
}

function finalize(
  pattern: TrendPattern,
  streakPeriods: number,
  occurrencesAboveThreshold: number,
  periodsConsidered: number,
  overallChangePercent: number | null,
  priorImprovementPeriods: number | null,
  periodUnitLabel: PeriodUnit
): TrendClassification {
  return {
    pattern,
    streakPeriods,
    occurrencesAboveThreshold,
    periodsConsidered,
    overallChangePercent,
    priorImprovementPeriods,
    durationLabel: buildDurationLabel(
      pattern,
      streakPeriods,
      occurrencesAboveThreshold,
      periodsConsidered,
      priorImprovementPeriods,
      periodUnitLabel
    ),
  };
}

/** Patterns that represent an unresolved / worsening problem worth follow-up. */
export const NEGATIVE_TREND_PATTERNS: readonly TrendPattern[] = [
  "CONTINUED_RISE",
  "ESCALATING",
  "NO_MEANINGFUL_IMPROVEMENT",
  "RELAPSE_AFTER_IMPROVEMENT",
  "EMERGING",
  "VOLATILE",
];

export function isNegativeTrend(pattern: TrendPattern): boolean {
  return NEGATIVE_TREND_PATTERNS.includes(pattern);
}
