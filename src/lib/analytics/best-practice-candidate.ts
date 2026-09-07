import type { AnalyticalFinding } from "./analytical-finding";
import { classificationLabelFromEntityName } from "./finding-labels";
import { formatPeriodCount, isNegativeTrend, TREND_PATTERNS, type TrendPattern } from "./multi-period-trend";
import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "./pattern-analysis-config";

/**
 * Governance vocabulary for a SUSTAINED_IMPROVEMENT finding ("الجهات
 * المتميزة والمرشحة لدراسة الممارسات الناجحة"). The trend engine already
 * proves a real, multi-period decline — never a single-period drop (see
 * multi-period-trend.ts). This module only decides whether that decline is
 * ALSO large/deep/long enough to justify naming the facility as a study
 * candidate, and generates the reason text straight from those numbers.
 *
 * It never claims the underlying operational practice is proven, and never
 * claims it is generalizable — that is exactly the line between
 * OBSERVED_IMPROVEMENT (the data shows a real decline) and
 * BEST_PRACTICE_CANDIDATE (the decline is also strong enough to be worth
 * studying). Whether an actual documented practice caused it, and whether it
 * generalizes to other sites, are separate, human-verified facts — see
 * best-practice-record.ts. Never render the phrase "ممارسة قابلة للتعميم" or
 * "ممارسة مثبتة" for a CANDIDATE or OBSERVED_IMPROVEMENT record; those words
 * belong only to a future VERIFIED/APPROVED BestPracticeRecordDraft.
 */
export const BEST_PRACTICE_CANDIDATE_STATUSES = ["OBSERVED_IMPROVEMENT", "BEST_PRACTICE_CANDIDATE"] as const;
export type BestPracticeCandidateStatus = (typeof BEST_PRACTICE_CANDIDATE_STATUSES)[number];

export type BestPracticeCandidateEvaluation = {
  status: BestPracticeCandidateStatus;
  facility: string;
  /** Classification.id (via finding.entityId) when known — the canonical identity used for cross-facility matching; null only for the UNCLASSIFIED bucket. */
  classificationId: string | null;
  classificationLabel: string;
  startValue: number;
  currentValue: number;
  decrease: number;
  streakPeriods: number;
  changeRatePercent: number | null;
  /** 0-100 deterministic ranking score; only meaningful to compare candidates against each other. */
  meritScore: number;
  /** Arabic reason phrase generated from the same numbers shown in the row; set only when status is BEST_PRACTICE_CANDIDATE. */
  reasonLabel: string | null;
  sourceFindingId: string;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function streakPeriodsOf(finding: AnalyticalFinding): number {
  return typeof finding.supportingMetrics.streakPeriods === "number" ? finding.supportingMetrics.streakPeriods : 0;
}

function computeMeritScore(
  input: { decrease: number; startValue: number; streakPeriods: number; changeRatePercent: number | null },
  config: PatternAnalysisConfig
): number {
  const { meritWeights, meritScales } = config.bestPracticeCandidate;
  const changeRateMagnitude = input.changeRatePercent === null ? 0 : Math.abs(input.changeRatePercent);
  const score =
    clamp01(input.decrease / meritScales.decreaseScale) * meritWeights.decreaseMagnitude
    + clamp01(input.streakPeriods / meritScales.streakScale) * meritWeights.streak
    + clamp01(changeRateMagnitude / 100) * meritWeights.changeRate
    + clamp01(input.startValue / meritScales.baseVolumeScale) * meritWeights.baseVolume;
  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Deterministic, data-only reason text (never a claimed operational cause —
 * spec forbids inventing "زيادة الجولات" etc. unless documented). Only the
 * numbers already shown in the row (streak length, change rate) decide the
 * wording.
 */
function buildReasonLabel(
  input: { streakPeriods: number; changeRatePercent: number | null },
  config: PatternAnalysisConfig
): string {
  // REASON-TEXT ONLY — these two constants never gate candidacy (that gate
  // is config.improvementDropPercent, applied once in evaluateBestPracticeCandidacy).
  // A candidate that clears the gate but misses these falls through to the
  // last, still-true, more modest sentence — it is never excluded here.
  const { strongReasonChangeRatePercent, strongReasonStreakPeriods } = config.bestPracticeCandidate;
  const isStrongChange = input.changeRatePercent !== null && input.changeRatePercent <= -strongReasonChangeRatePercent;
  const isLongStreak = input.streakPeriods >= strongReasonStreakPeriods;
  if (isStrongChange && isLongStreak) return "تحسن قوي ومستدام";
  if (isLongStreak) return `انخفاض مستدام عبر ${formatPeriodCount(input.streakPeriods)}`;
  return "تحسن مستدام مع انخفاض جوهري في حجم الشكاوى";
}

/**
 * Evaluates ONE SUSTAINED_IMPROVEMENT finding for best-practice candidacy.
 * `facility` is passed in already-resolved (the caller is expected to have
 * already excluded the "unspecified facility" bucket via its own facility
 * resolution) rather than re-derived here, so this module never duplicates
 * that exclusion. Returns null for any finding that isn't a
 * SUSTAINED_IMPROVEMENT — there is nothing to evaluate for a chronic or
 * escalating finding.
 */
export function evaluateBestPracticeCandidacy(
  finding: AnalyticalFinding,
  facility: string,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): BestPracticeCandidateEvaluation | null {
  if (finding.type !== "SUSTAINED_IMPROVEMENT") return null;

  // `startValue` is finding.previousValue exactly as pattern-findings-service.ts
  // computed it — the value at the START of the verified declining streak
  // (counts[counts.length - streakPeriods]), NOT the oldest/highest value in
  // the whole fetched window. An older, higher peak that came before an
  // intervening rise/relapse is deliberately excluded by the engine itself
  // (see its own "improvementStartValue" comment and the regression tests in
  // pattern-findings-service.test.ts) — this module trusts that value as-is
  // and never recomputes or overrides it.
  const startValue = finding.previousValue ?? 0;
  const currentValue = finding.currentValue;
  const decrease = startValue - currentValue;
  const streakPeriods = streakPeriodsOf(finding);
  const changeRatePercent = finding.changeRate;
  const classificationId = finding.entityId;
  const classificationLabel = classificationLabelFromEntityName(finding.entityName);

  const t = config.bestPracticeCandidate;
  // A real multi-period decline is already guaranteed by SUSTAINED_IMPROVEMENT
  // classification — this is the ADDITIONAL "is it big/deep/long enough"
  // bar so a 2→1 or 1→0 blip can never outrank a genuine 73→32 decline.
  // THE ONLY change-rate gate is config.improvementDropPercent (reused from
  // the trend engine itself) — bestPracticeCandidate.strongReasonChangeRatePercent
  // is a separate, stricter, TEXT-ONLY threshold used solely by
  // buildReasonLabel below; it never excludes a candidate.
  const passesGates =
    decrease >= t.minAbsoluteDecrease
    && startValue >= t.minBaseVolume
    && streakPeriods >= t.minStreakPeriods
    && changeRatePercent !== null
    && changeRatePercent <= -config.improvementDropPercent;

  const meritScore = computeMeritScore({ decrease, startValue, streakPeriods, changeRatePercent }, config);

  return {
    status: passesGates ? "BEST_PRACTICE_CANDIDATE" : "OBSERVED_IMPROVEMENT",
    facility,
    classificationId,
    classificationLabel,
    startValue,
    currentValue,
    decrease,
    streakPeriods,
    changeRatePercent,
    meritScore,
    reasonLabel: passesGates ? buildReasonLabel({ streakPeriods, changeRatePercent }, config) : null,
    sourceFindingId: finding.id,
  };
}

function isNegativeTrendPatternValue(value: unknown): value is TrendPattern {
  return typeof value === "string" && (TREND_PATTERNS as readonly string[]).includes(value) && isNegativeTrend(value as TrendPattern);
}

/**
 * Other facilities still struggling with the SAME classification a
 * candidate just improved on (spec: "المقارنة مع الجهات التي لديها نفس
 * المشكلة") — used only to point at who else has the same problem and would
 * benefit from comparing notes. Never used to assert the candidate's
 * practice IS generalizable; that judgment stays with a human.
 *
 * Matches on `classificationId` (finding.entityId — Classification.id, or
 * null for the single UNCLASSIFIED bucket), the canonical identity, rather
 * than the display label — two differently-labeled findings can never be
 * conflated, and a relabeled classification still matches correctly. Only
 * CHRONIC_ISSUE and a negative-trend TREND_PATTERN (CONTINUED_RISE,
 * ESCALATING, RELAPSE_AFTER_IMPROVEMENT, EMERGING, VOLATILE, ... — see
 * isNegativeTrend) count as "struggling"; a SUSTAINED_IMPROVEMENT or any
 * STABLE/no-signal finding elsewhere is never included.
 */
export function findStrugglingFacilitiesForClassification(
  candidateFacility: string,
  classificationId: string | null,
  findings: readonly AnalyticalFinding[]
): string[] {
  const facilities = new Set<string>();
  for (const finding of findings) {
    if (finding.entityType !== "CLASSIFICATION") continue;
    if (finding.entityId !== classificationId) continue;
    const isStruggling =
      finding.type === "CHRONIC_ISSUE"
      || (finding.type === "TREND_PATTERN" && isNegativeTrendPatternValue(finding.supportingMetrics.pattern));
    if (!isStruggling) continue;
    const facility = typeof finding.drilldownFilters.facility === "string" ? finding.drilldownFilters.facility : null;
    if (!facility || facility === candidateFacility) continue;
    facilities.add(facility);
  }
  return [...facilities].sort((a, b) => a.localeCompare(b, "ar"));
}

function formatArabicSiteCount(count: number): string {
  if (count === 2) return "موقعان";
  if (count >= 3 && count <= 10) return `${count} مواقع`;
  return `${count} موقعاً`;
}

/**
 * Short automatic executive line for the report section (spec item 5) —
 * always phrased as an observed, data-proven pattern plus a recommendation
 * to verify, never as a claimed cause (spec item 6) and never asserting the
 * practice IS generalizable (spec item 1) — only that studying it, and its
 * possible generalization, is worthwhile. Phrasing is deliberately
 * facility-name-neutral ("أظهرت بيانات X...") rather than a verb whose
 * subject is the facility ("سجلت X...") so it reads correctly regardless of
 * whether `facility` already carries an administrative prefix like "إدارة".
 * `candidates` must already be filtered to BEST_PRACTICE_CANDIDATE status.
 */
export function buildBestPracticeSectionSummary(
  candidates: readonly BestPracticeCandidateEvaluation[]
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const c = candidates[0];
    return `أظهرت بيانات ${c.facility} تحسناً مستداماً في ${c.classificationLabel}، من ${c.startValue} إلى ${c.currentValue} شكوى خلال ${formatPeriodCount(c.streakPeriods)}، وهي مرشحة لدراسة الإجراءات التي أسهمت في هذا التحسن والتحقق من إمكانية تعميمها.`;
  }
  return `أظهرت بيانات ${formatArabicSiteCount(candidates.length)} تحسناً مستداماً في مشكلات متكررة، ويوصى بالتحقق من الإجراءات التشغيلية التي أسهمت في هذا التحسن ودراسة إمكانية تعميمها على المواقع التي لا تزال تواجه المشكلة نفسها.`;
}

/**
 * "يوصى بدراسة تجربة X ومقارنتها بالمواقع التي لا تزال تسجل استمراراً
 * مرتفعاً" (spec item 10) — generated only for the top-ranked candidate (by
 * merit score; `candidates` must already be sorted descending) and only when
 * at least one other facility genuinely still struggles with the same
 * classification (matched by classificationId — see
 * findStrugglingFacilitiesForClassification). Never asserts the practice is
 * generalizable — only that a comparison is worth making.
 */
export function buildBestPracticeComparisonConclusion(
  candidates: readonly BestPracticeCandidateEvaluation[],
  findings: readonly AnalyticalFinding[]
): string | null {
  const top = candidates[0];
  if (!top) return null;
  const struggling = findStrugglingFacilitiesForClassification(top.facility, top.classificationId, findings);
  if (struggling.length === 0) return null;
  const comparisonClause = struggling.length === 1
    ? `${struggling[0]}، الذي لا يزال يسجل استمراراً مرتفعاً في التصنيف نفسه`
    : `المواقع التالية التي لا تزال تسجل استمراراً مرتفعاً في التصنيف نفسه: ${struggling.join("، ")}`;
  return `يوصى بدراسة تجربة ${top.facility} في ${top.classificationLabel} ومقارنتها بـ${comparisonClause}.`;
}
