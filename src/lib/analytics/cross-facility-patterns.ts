import { evaluateComparison } from "./comparison-evaluation";
import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "./pattern-analysis-config";

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Cross-facility spread (spec §8): the same classification rising at once
// in several facilities, rolled up into one organization-level conclusion
// instead of N separate per-facility findings.
// ---------------------------------------------------------------------------

export type FacilityClassificationChange = {
  facility: string;
  classificationLabel: string;
  currentCount: number;
  previousCount: number;
};

export type CrossFacilitySpreadResult = {
  classificationLabel: string;
  affectedFacilityCount: number;
  totalComplaints: number;
  changeFromPrevious: number;
  changeRatePercent: number | null;
  topContributingFacilities: { facility: string; currentCount: number; difference: number }[];
};

const MAX_TOP_CONTRIBUTING_FACILITIES = 5;

export function detectCrossFacilitySpread(
  changes: readonly FacilityClassificationChange[],
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): CrossFacilitySpreadResult[] {
  const byClassification = new Map<string, FacilityClassificationChange[]>();
  for (const change of changes) {
    const list = byClassification.get(change.classificationLabel) ?? [];
    list.push(change);
    byClassification.set(change.classificationLabel, list);
  }

  const results: CrossFacilitySpreadResult[] = [];
  for (const [classificationLabel, facilityChanges] of byClassification) {
    const affected = facilityChanges.filter((c) => {
      if (c.currentCount < config.minComplaintsForSignal) return false;
      const evaluation = evaluateComparison(c.currentCount, c.previousCount, true);
      return evaluation.state === "INCREASE" && (evaluation.changeRate ?? 0) >= config.materialChangeRatePercent;
    });

    if (affected.length < config.crossFacilityMinAffectedFacilities) continue;

    const totalComplaints = facilityChanges.reduce((sum, c) => sum + c.currentCount, 0);
    const totalPrevious = facilityChanges.reduce((sum, c) => sum + c.previousCount, 0);
    const overall = evaluateComparison(totalComplaints, totalPrevious, true);

    results.push({
      classificationLabel,
      affectedFacilityCount: affected.length,
      totalComplaints,
      changeFromPrevious: overall.difference ?? totalComplaints - totalPrevious,
      changeRatePercent: overall.changeRate,
      topContributingFacilities: [...affected]
        .map((c) => ({ facility: c.facility, currentCount: c.currentCount, difference: c.currentCount - c.previousCount }))
        .sort((a, b) => b.difference - a.difference)
        .slice(0, MAX_TOP_CONTRIBUTING_FACILITIES),
    });
  }

  return results.sort((a, b) => b.affectedFacilityCount - a.affectedFacilityCount);
}

// ---------------------------------------------------------------------------
// Composition shift (spec §9): the facility total stays flat while the mix
// of classifications underneath it changes — a rising classification
// becomes the new leading problem even though nothing changed at the total.
// ---------------------------------------------------------------------------

export type CompositionShiftInput = {
  facility: string;
  facilityTotalCurrent: number;
  facilityTotalPrevious: number;
  classifications: readonly { label: string; currentCount: number; previousCount: number }[];
};

export type CompositionShiftResult = {
  facility: string;
  risingClassification: string;
  risingChange: number;
  fallingClassification: string;
  fallingChange: number;
  becameTopClassification: boolean;
};

export function detectCompositionShift(
  input: CompositionShiftInput,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): CompositionShiftResult | null {
  const totalEvaluation = evaluateComparison(input.facilityTotalCurrent, input.facilityTotalPrevious, true);
  const totalIsStable =
    totalEvaluation.changeRate === null || Math.abs(totalEvaluation.changeRate) < config.materialChangeRatePercent;
  if (!totalIsStable) return null;

  const withChange = input.classifications.map((c) => ({ ...c, difference: c.currentCount - c.previousCount }));

  const rising = withChange
    .filter((c) => c.currentCount >= config.minComplaintsForSignal && c.difference > 0)
    .sort((a, b) => b.difference - a.difference)[0];
  const falling = withChange
    .filter((c) => c.previousCount >= config.minComplaintsForSignal && c.difference < 0)
    .sort((a, b) => a.difference - b.difference)[0];

  if (!rising || !falling || rising.label === falling.label) return null;

  const previousTop = [...withChange].sort((a, b) => b.previousCount - a.previousCount)[0];
  const currentTop = [...withChange].sort((a, b) => b.currentCount - a.currentCount)[0];
  const becameTopClassification = currentTop.label === rising.label && previousTop.label !== rising.label;

  return {
    facility: input.facility,
    risingClassification: rising.label,
    risingChange: rising.difference,
    fallingClassification: falling.label,
    fallingChange: falling.difference,
    becameTopClassification,
  };
}

// ---------------------------------------------------------------------------
// Multi-issue facility (spec §10): several classifications flagged negative
// at the same facility at the same time — used as a follow-up-priority input.
// ---------------------------------------------------------------------------

export type FacilityClassificationSignal = {
  facility: string;
  classificationLabel: string;
  isNegativeTrend: boolean;
  streakPeriods: number;
  sharePercent: number;
};

export type MultiIssueFacilityResult = {
  facility: string;
  affectedClassificationCount: number;
  classifications: { label: string; streakPeriods: number; sharePercent: number }[];
};

export function detectMultiIssueFacilities(
  signals: readonly FacilityClassificationSignal[],
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): MultiIssueFacilityResult[] {
  const byFacility = new Map<string, FacilityClassificationSignal[]>();
  for (const signal of signals) {
    if (!signal.isNegativeTrend) continue;
    const list = byFacility.get(signal.facility) ?? [];
    list.push(signal);
    byFacility.set(signal.facility, list);
  }

  const results: MultiIssueFacilityResult[] = [];
  for (const [facility, facilitySignals] of byFacility) {
    if (facilitySignals.length < config.minAffectedClassificationsForMultiIssue) continue;
    results.push({
      facility,
      affectedClassificationCount: facilitySignals.length,
      classifications: facilitySignals
        .map((s) => ({ label: s.classificationLabel, streakPeriods: s.streakPeriods, sharePercent: roundTenth(s.sharePercent) }))
        .sort((a, b) => b.streakPeriods - a.streakPeriods),
    });
  }

  return results.sort((a, b) => b.affectedClassificationCount - a.affectedClassificationCount);
}
