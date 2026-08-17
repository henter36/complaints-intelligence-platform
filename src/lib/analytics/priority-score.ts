import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "./pattern-analysis-config";

/**
 * Documented, adjustable follow-up priority score (spec §12). Every input is
 * normalized to 0..1, multiplied by a weight from
 * `PATTERN_ANALYSIS_CONFIG.priorityWeights`, and summed to a 0-100 score.
 * The score is never shown as a bare number without `reasons` explaining why
 * it is high (spec §12 forbids "أولوية مرتفعة" with no explanation).
 */
export type PriorityScoreInput = {
  currentValue: number;
  /** Percent change vs. the first period in the analysis window; null when unavailable. */
  changeRatePercent: number | null;
  /** True once currentValue clears the minimum-signal threshold — gates changeRate so a 1→3 jump can't dominate the score (spec §11). */
  hasSufficientVolume: boolean;
  streakPeriods: number;
  /** Analysis window size, used to normalize streakPeriods. */
  windowPeriods: number;
  repeatRatePercent: number | null;
  distinctComplainants: number | null;
  /** Facility's classification share minus the rest-of-org average share, in points. */
  concentrationDeltaPercent: number | null;
  /** How many other classifications are simultaneously flagged negative at the same facility. */
  affectedClassificationsCount: number;
  isRelapse: boolean;
  /** How many facilities are affected by the same rising classification org-wide. */
  crossFacilityAffectedCount: number;
};

export type PriorityBand = "HIGH" | "MEDIUM" | "LOW";

export type PriorityScoreResult = {
  score: number;
  band: PriorityBand;
  reasons: string[];
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

type Factor = { key: string; value: number; reason: string };

function buildFactors(input: PriorityScoreInput, config: PatternAnalysisConfig): Factor[] {
  const volumeScale = config.minComplaintsForSignal * 4;
  const changeRate = input.hasSufficientVolume ? Math.max(input.changeRatePercent ?? 0, 0) : 0;

  return [
    {
      key: "volume",
      value: clamp01(input.currentValue / volumeScale),
      reason: `حجم شكاوى مرتفع (${input.currentValue})`,
    },
    {
      key: "changeRate",
      value: clamp01(changeRate / 100),
      reason: `ارتفاع فعلي بنسبة ${Math.round(changeRate)}%`,
    },
    {
      key: "streak",
      value: clamp01(input.streakPeriods / Math.max(input.windowPeriods, 1)),
      reason: `استمرار ${input.streakPeriods} فترات`,
    },
    {
      key: "repeatRate",
      value: clamp01((input.repeatRatePercent ?? 0) / 50),
      reason: `معدل تكرار مرتفع (${Math.round(input.repeatRatePercent ?? 0)}%)`,
    },
    {
      key: "distinctComplainants",
      value: clamp01((input.distinctComplainants ?? 0) / 20),
      reason: `تعدد أصحاب الشكاوى (${input.distinctComplainants ?? 0})`,
    },
    {
      key: "concentration",
      value: clamp01(Math.max(input.concentrationDeltaPercent ?? 0, 0) / 30),
      reason: `تركّز غير اعتيادي للتصنيف داخل الموقع`,
    },
    {
      key: "multiIssue",
      value: clamp01(input.affectedClassificationsCount / 4),
      reason: `تعدد التصنيفات المتأثرة (${input.affectedClassificationsCount})`,
    },
    {
      key: "relapse",
      value: input.isRelapse ? 1 : 0,
      reason: `عودة المشكلة بعد تحسن سابق`,
    },
    {
      key: "crossFacilitySpread",
      value: clamp01(input.crossFacilityAffectedCount / 6),
      reason: `انتشار المشكلة في عدة مواقع (${input.crossFacilityAffectedCount})`,
    },
  ];
}

/** A factor is worth citing as a "reason" once it contributes meaningfully, not just nonzero. */
const REASON_INCLUSION_THRESHOLD = 0.3;

export function computePriorityScore(
  input: PriorityScoreInput,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): PriorityScoreResult {
  const factors = buildFactors(input, config);
  const weights = config.priorityWeights as Record<string, number>;

  const contributions = factors.map((factor) => ({
    ...factor,
    contribution: factor.value * (weights[factor.key] ?? 0),
  }));

  const score = Math.round(
    Math.min(100, Math.max(0, contributions.reduce((sum, c) => sum + c.contribution, 0)))
  );

  const reasons = contributions
    .filter((c) => c.value >= REASON_INCLUSION_THRESHOLD)
    .sort((a, b) => b.contribution - a.contribution)
    .map((c) => c.reason);

  const band: PriorityBand =
    score >= config.priorityBandThresholds.high
      ? "HIGH"
      : score >= config.priorityBandThresholds.medium
        ? "MEDIUM"
        : "LOW";

  return { score, band, reasons };
}
