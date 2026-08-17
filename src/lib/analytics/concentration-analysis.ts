import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "./pattern-analysis-config";

/**
 * Facility-level classification concentration (spec §5): what share of a
 * facility's complaints one classification represents, compared to that
 * classification's average share across the rest of the organization.
 */
export type ClassificationConcentrationInput = {
  facility: string;
  classificationLabel: string;
  facilityClassificationCount: number;
  facilityTotal: number;
  orgWideClassificationCountExcludingFacility: number;
  orgWideTotalExcludingFacility: number;
};

export type ClassificationConcentrationResult = {
  facility: string;
  classificationLabel: string;
  count: number;
  facilitySharePercent: number;
  orgAverageSharePercent: number;
  deltaPercent: number;
  isUnusual: boolean;
};

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Returns null when the facility doesn't have enough volume in this classification to draw a conclusion (spec §19). */
export function analyzeClassificationConcentration(
  input: ClassificationConcentrationInput,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): ClassificationConcentrationResult | null {
  if (input.facilityTotal <= 0 || input.facilityClassificationCount < config.minComplaintsForSignal) return null;

  const facilitySharePercent = roundTenth((input.facilityClassificationCount / input.facilityTotal) * 100);
  const orgAverageSharePercent =
    input.orgWideTotalExcludingFacility > 0
      ? roundTenth((input.orgWideClassificationCountExcludingFacility / input.orgWideTotalExcludingFacility) * 100)
      : 0;
  const deltaPercent = roundTenth(facilitySharePercent - orgAverageSharePercent);

  const isUnusual =
    facilitySharePercent >= config.concentrationShareThresholdPercent &&
    deltaPercent >= config.concentrationMinDeltaPercent;

  return {
    facility: input.facility,
    classificationLabel: input.classificationLabel,
    count: input.facilityClassificationCount,
    facilitySharePercent,
    orgAverageSharePercent,
    deltaPercent,
    isUnusual,
  };
}

// ---------------------------------------------------------------------------
// Wing-level concentration (spec §6) — only when wingCode coverage is
// complete enough to trust the result.
// ---------------------------------------------------------------------------

export type WingConcentrationInput = {
  facility: string;
  classificationLabel: string;
  wingCounts: readonly { wingCode: string; count: number }[];
  /** Complaints in this facility×classification cell that DO have a wingCode. */
  totalWithWingData: number;
  /** All complaints in this facility×classification cell, wingCode present or not. */
  totalComplaints: number;
};

export type WingConcentrationResult = {
  facility: string;
  classificationLabel: string;
  topWings: { wingCode: string; count: number; sharePercent: number }[];
  combinedSharePercent: number;
  isConcentrated: boolean;
  dataCompletenessRate: number;
};

const MAX_TOP_WINGS = 2;

export function analyzeWingConcentration(
  input: WingConcentrationInput,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): WingConcentrationResult | null {
  if (input.totalComplaints <= 0) return null;
  const dataCompletenessRate = input.totalWithWingData / input.totalComplaints;
  // Data quality gate (spec §19): incomplete wing data yields no conclusion at all.
  if (dataCompletenessRate < config.minWingDataCompletenessRate) return null;
  if (input.totalWithWingData < config.minComplaintsForSignal) return null;

  const sorted = [...input.wingCounts].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, MAX_TOP_WINGS);
  const combinedCount = top.reduce((sum, w) => sum + w.count, 0);
  const combinedSharePercent = roundTenth((combinedCount / input.totalWithWingData) * 100);

  return {
    facility: input.facility,
    classificationLabel: input.classificationLabel,
    topWings: top.map((w) => ({
      ...w,
      sharePercent: roundTenth((w.count / input.totalWithWingData) * 100),
    })),
    combinedSharePercent,
    isConcentrated: combinedSharePercent / 100 >= config.wingConcentrationShareThreshold,
    dataCompletenessRate: roundTenth(dataCompletenessRate * 100),
  };
}
