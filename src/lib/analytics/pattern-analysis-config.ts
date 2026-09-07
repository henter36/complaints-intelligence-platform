/**
 * Single source of truth for every threshold used by the multi-period
 * pattern-analysis engine (trend classification, chronic-issue detection,
 * repeat-complainant analysis, concentration, cross-facility spread,
 * priority scoring). No detector may hard-code one of these numbers itself —
 * change behavior here, not scattered across files.
 */
export const PATTERN_ANALYSIS_CONFIG = {
  /** How many trailing periods the aggregation service fetches for analysis. */
  analysisWindowPeriods: 6,

  /** Periods a signal must hold to count as "continuing" at all. */
  minPeriodsForContinuity: 3,
  /** Periods a signal must hold (or a documented mix of signals) to be labeled a chronic problem. */
  minPeriodsForChronic: 4,

  /** A period's count below this is treated as noise, not a real signal. */
  minComplaintsForSignal: 5,
  /** Repeat-complaint share of a facility's total below this is not reported as a repetition signal. */
  minRepeatRateForSignal: 0.1,

  /** A period-over-period (or first-vs-last) change below this % is not "material" on its own. */
  materialChangeRatePercent: 30,
  /** A decline must reach this % (cumulative) to be called an improvement. */
  improvementDropPercent: 20,
  /** A single-period drop is never a "sustained" improvement (see spec §14). */
  minSustainedImprovementPeriods: 2,

  /** A classification's share of a facility's complaints above this % is a concentration candidate. */
  concentrationShareThresholdPercent: 25,
  /** The facility's share must exceed the rest-of-org average by at least this many points. */
  concentrationMinDeltaPercent: 10,

  /** Minimum share of a classification's complaints inside 1-2 wings to call it wing-concentrated. */
  wingConcentrationShareThreshold: 0.5,
  /** wingCode must be present on at least this share of a facility's complaints before wing analysis runs. */
  minWingDataCompletenessRate: 0.8,

  /** Distinct complainants required on the same subject/classification/facility/period to call it a mass complaint. */
  massComplaintMinDistinctComplainants: 5,

  /** Facilities needed to call a classification's rise "cross-facility spread". */
  crossFacilityMinAffectedFacilities: 3,

  /** Classifications simultaneously flagged negative in one facility to call it "multi-issue". */
  minAffectedClassificationsForMultiIssue: 2,

  /** Weights for the follow-up priority score. Must sum to 100; see priority-score.ts for the formula. */
  priorityWeights: {
    volume: 15,
    changeRate: 15,
    streak: 20,
    repeatRate: 15,
    distinctComplainants: 10,
    concentration: 10,
    multiIssue: 5,
    relapse: 5,
    crossFacilitySpread: 5,
  },

  /** Score cutoffs (0-100) for the HIGH / MEDIUM / LOW follow-up priority bands. */
  priorityBandThresholds: {
    high: 70,
    medium: 40,
  },

  /**
   * Gates a SUSTAINED_IMPROVEMENT finding must ALSO clear to be named a
   * "best-practice candidate" worth studying — a real multi-period decline
   * (already guaranteed by the trend engine) is necessary but not
   * sufficient. Without these, a trivial low-volume change like 2→1 or 1→0
   * held for 3 periods would rank as "best" purely for having a 100% drop,
   * outranking a much larger, more meaningful decline like 73→32.
   *
   * There is exactly ONE gate on change-rate strength, and it is the
   * top-level `improvementDropPercent` above (reused, not duplicated) — the
   * same bar SUSTAINED_IMPROVEMENT itself already had to clear. The two
   * `strongReason*` constants below are NEVER gates: they only pick which
   * Arabic sentence describes an already-qualified candidate (see
   * best-practice-candidate.ts's buildReasonLabel). Do not read
   * `strongReasonChangeRatePercent` as a second, stricter candidacy
   * threshold — a candidate can qualify at exactly -improvementDropPercent
   * and simply get the more modest reason wording.
   */
  bestPracticeCandidate: {
    /** Minimum trailing decline streak (periods) to be candidate-eligible. */
    minStreakPeriods: 3,
    /** Minimum absolute decrease (start - current); blocks tiny changes from ever outranking a materially larger one. */
    minAbsoluteDecrease: 5,
    /** Minimum starting/base volume (the peak just before the decline); blocks a low-volume fluctuation from reading as a meaningful improvement. */
    minBaseVolume: 5,
    /** REASON-TEXT ONLY (never a gate): changeRate at/below this (more negative), combined with strongReasonStreakPeriods, earns the "قوي ومستدام" wording instead of the more modest one. */
    strongReasonChangeRatePercent: 30,
    /** REASON-TEXT ONLY (never a gate): streak length at/above this counts as "long" for reason-text wording. */
    strongReasonStreakPeriods: 4,
    /** Best-practice candidates shown in the report table (top N by merit score). */
    maxCandidates: 5,
    /** Weights for the merit score used to rank candidates against each other. Must sum to 100. */
    meritWeights: {
      decreaseMagnitude: 40,
      streak: 25,
      changeRate: 20,
      baseVolume: 15,
    },
    /** Divisors that normalize each raw merit input to 0..1 before weighting. */
    meritScales: {
      decreaseScale: 40,
      streakScale: 6,
      baseVolumeScale: 50,
    },
  },
} as const;

export type PatternAnalysisConfig = typeof PATTERN_ANALYSIS_CONFIG;
