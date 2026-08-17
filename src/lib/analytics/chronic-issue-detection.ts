import { isNegativeTrend, type TrendClassification } from "./multi-period-trend";
import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "./pattern-analysis-config";

/**
 * The "مشكلة مزمنة" (chronic problem) classification (spec §3). Never a bare
 * label — every chronic call carries the specific combination of signals
 * that produced it so a reader can verify the reasoning, not just trust it.
 */
export type ChronicIssueInput = {
  trend: TrendClassification;
  repeatRatePercent: number | null;
  distinctComplainants: number | null;
  /** Facility share of the classification minus the rest-of-org average share, in points. */
  concentrationDeltaPercent: number | null;
};

export type ChronicIssueResult = {
  isChronic: boolean;
  reasons: string[];
  explanation: string;
};

export function evaluateChronicIssue(
  input: ChronicIssueInput,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): ChronicIssueResult {
  const { trend } = input;
  const negative = isNegativeTrend(trend.pattern);
  const repeatRate = input.repeatRatePercent ?? 0;
  const concentrationDelta = input.concentrationDeltaPercent ?? 0;

  const meetsFullStreak = negative && trend.streakPeriods >= config.minPeriodsForChronic;
  const hasSupportingSignal =
    repeatRate >= config.minRepeatRateForSignal * 100 || concentrationDelta >= config.concentrationMinDeltaPercent;
  const meetsShortStreakWithSupport =
    negative && trend.streakPeriods >= config.minPeriodsForContinuity && hasSupportingSignal;

  const isChronic = meetsFullStreak || meetsShortStreakWithSupport;

  const reasons: string[] = [];
  if (negative && trend.streakPeriods > 0) {
    reasons.push(`استمرار ${trend.streakPeriods} فترات`);
  }
  if (repeatRate >= config.minRepeatRateForSignal * 100) {
    reasons.push(`تكرار مرتفع (${Math.round(repeatRate)}%)`);
  }
  if ((input.distinctComplainants ?? 0) > 0 && repeatRate === 0) {
    reasons.push(`تعدد أصحاب الشكاوى (${input.distinctComplainants})`);
  }
  if (concentrationDelta >= config.concentrationMinDeltaPercent) {
    reasons.push(`تركّز غير اعتيادي للتصنيف داخل الموقع`);
  }
  if (trend.pattern === "RELAPSE_AFTER_IMPROVEMENT") {
    reasons.push(`عودة المشكلة بعد تحسن سابق`);
  }

  const explanation = isChronic
    ? `مشكلة مزمنة بسبب: ${reasons.join(" + ")}`
    : "لا تستوفي المعايير الحالية تصنيف مشكلة مزمنة.";

  return { isChronic, reasons, explanation };
}
