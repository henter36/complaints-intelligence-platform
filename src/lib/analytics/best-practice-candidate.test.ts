import { describe, expect, it } from "vitest";
import {
  evaluateBestPracticeCandidacy,
  findStrugglingFacilitiesForClassification,
  buildBestPracticeSectionSummary,
  buildBestPracticeComparisonConclusion,
  type BestPracticeCandidateEvaluation,
} from "./best-practice-candidate";
import type { AnalyticalFinding } from "./analytical-finding";

const DOCTOR_ACCESS_CLASSIFICATION_ID = "cls-doctor-access";

function finding(overrides: Partial<AnalyticalFinding> = {}): AnalyticalFinding {
  return {
    id: overrides.id ?? "f",
    type: "SUSTAINED_IMPROVEMENT",
    entityType: "CLASSIFICATION",
    entityId: DOCTOR_ACCESS_CLASSIFICATION_ID,
    entityName: "سجن الملز — الوصول إلى الطبيب",
    currentValue: 32,
    previousValue: 73,
    difference: -41,
    changeRate: -56.2,
    severity: "LOW",
    priorityScore: 0,
    confidence: "MEDIUM",
    detectionSource: "QUANTITATIVE",
    explanation: "x",
    supportingMetrics: { streakPeriods: 4 },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: { facility: "سجن الملز" },
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

describe("evaluateBestPracticeCandidacy", () => {
  it("returns null for anything other than SUSTAINED_IMPROVEMENT", () => {
    expect(evaluateBestPracticeCandidacy(finding({ type: "CHRONIC_ISSUE" }), "سجن الملز")).toBeNull();
  });

  it("a large, sustained decline off a real base is BEST_PRACTICE_CANDIDATE with a data-derived reason", () => {
    const result = evaluateBestPracticeCandidacy(finding(), "سجن الملز");
    expect(result?.status).toBe("BEST_PRACTICE_CANDIDATE");
    expect(result?.decrease).toBe(41);
    expect(result?.streakPeriods).toBe(4);
    expect(result?.classificationId).toBe(DOCTOR_ACCESS_CLASSIFICATION_ID);
    expect(result?.reasonLabel).toBe("تحسن قوي ومستدام");
  });

  it("2→1 over 3 periods stays OBSERVED_IMPROVEMENT — never a candidate, regardless of the 50% drop", () => {
    const result = evaluateBestPracticeCandidacy(
      finding({ currentValue: 1, previousValue: 2, changeRate: -50, supportingMetrics: { streakPeriods: 3 } }),
      "سجن أ"
    );
    expect(result?.status).toBe("OBSERVED_IMPROVEMENT");
    expect(result?.reasonLabel).toBeNull();
  });

  it("1→0 stays OBSERVED_IMPROVEMENT — a 100% drop off a trivial base is not a candidate", () => {
    const result = evaluateBestPracticeCandidacy(
      finding({ currentValue: 0, previousValue: 1, changeRate: -100, supportingMetrics: { streakPeriods: 3 } }),
      "سجن أ"
    );
    expect(result?.status).toBe("OBSERVED_IMPROVEMENT");
  });

  it("a single-period-equivalent streak is never a candidate even with a large decrease", () => {
    const result = evaluateBestPracticeCandidacy(
      finding({ currentValue: 5, previousValue: 60, changeRate: -91.7, supportingMetrics: { streakPeriods: 1 } }),
      "سجن أ"
    );
    expect(result?.status).toBe("OBSERVED_IMPROVEMENT");
  });

  it("finding.changeRate is IGNORED entirely — even a wildly different whole-window rate never affects candidacy, reason, or merit", () => {
    // startValue=73, currentValue=32 (candidate rate ≈ -56%), but
    // finding.changeRate claims a barely-there whole-window rate. The
    // candidate-specific rate (derived from startValue/currentValue only)
    // must still drive everything.
    const result = evaluateBestPracticeCandidacy(finding({ changeRate: -1 }), "سجن الملز");
    expect(result?.status).toBe("BEST_PRACTICE_CANDIDATE");
    expect(result?.changeRatePercent).toBeCloseTo(-56.164, 2);
    expect(result?.reasonLabel).toBe("تحسن قوي ومستدام");
  });

  it("startValue of 0 (no real baseline) is never a candidate — the candidate-specific rate is null, not borrowed from finding.changeRate", () => {
    const result = evaluateBestPracticeCandidacy(
      finding({ previousValue: 0, currentValue: 0, changeRate: -100, supportingMetrics: { streakPeriods: 4 } }),
      "سجن الملز"
    );
    expect(result?.changeRatePercent).toBeNull();
    expect(result?.status).toBe("OBSERVED_IMPROVEMENT");
    expect(result?.reasonLabel).toBeNull();
  });

  it("the same finding evaluated twice produces the exact same result (deterministic)", () => {
    const f = finding();
    const first = evaluateBestPracticeCandidacy(f, "سجن الملز");
    const second = evaluateBestPracticeCandidacy(f, "سجن الملز");
    expect(first).toEqual(second);
  });

  it("a shorter streak (below the 'long streak' wording threshold) gets the substantial-but-not-'strong' reason text", () => {
    // 3-period streak (below strongReasonStreakPeriods=4) — still a real
    // candidate since it clears minStreakPeriods=3, just worded differently
    // from the "قوي ومستدام" case which additionally requires a long streak.
    const result = evaluateBestPracticeCandidacy(
      finding({ currentValue: 6, previousValue: 20, changeRate: -70, supportingMetrics: { streakPeriods: 3 } }),
      "سجن الحائر"
    );
    expect(result?.status).toBe("BEST_PRACTICE_CANDIDATE");
    expect(result?.reasonLabel).toBe("تحسن مستدام مع انخفاض جوهري في حجم الشكاوى");
  });

  it("never invents an operational cause (no rounds/staffing/booking language) in the reason text", () => {
    const result = evaluateBestPracticeCandidacy(finding(), "سجن الملز");
    const forbidden = ["جولات", "حجز", "كادر", "تنسيق", "موظفين", "طاقم"];
    for (const word of forbidden) {
      expect(result?.reasonLabel ?? "").not.toContain(word);
    }
  });

  describe("candidacy gate vs. strong-reason-label threshold are two DIFFERENT, non-conflicting concepts", () => {
    it("qualifies right at the candidacy gate (-improvementDropPercent = -20%) even though it misses the stronger -30% reason-label bar", () => {
      // decrease=15 (>=5), start=20 (>=5), streak=3 (>=3), changeRate exactly
      // -20% — clears config.improvementDropPercent (the ONLY candidacy
      // gate) but not bestPracticeCandidate.strongReasonChangeRatePercent (-30%).
      const result = evaluateBestPracticeCandidacy(
        finding({ currentValue: 20, previousValue: 25, changeRate: -20, supportingMetrics: { streakPeriods: 3 } }),
        "سجن أ"
      );
      expect(result?.status).toBe("BEST_PRACTICE_CANDIDATE");
      expect(result?.reasonLabel).toBe("تحسن مستدام مع انخفاض جوهري في حجم الشكاوى");
    });

    it("a change rate stronger than -20% but weaker than -30% (e.g. -25%) still qualifies, still with the modest wording", () => {
      const result = evaluateBestPracticeCandidacy(
        finding({ currentValue: 15, previousValue: 20, changeRate: -25, supportingMetrics: { streakPeriods: 3 } }),
        "سجن أ"
      );
      expect(result?.status).toBe("BEST_PRACTICE_CANDIDATE");
      expect(result?.reasonLabel).toBe("تحسن مستدام مع انخفاض جوهري في حجم الشكاوى");
    });

    it("a change rate just short of the candidacy gate (-19%) is excluded entirely, never just relabeled", () => {
      const result = evaluateBestPracticeCandidacy(
        finding({ currentValue: 21, previousValue: 25, changeRate: -19, supportingMetrics: { streakPeriods: 3 } }),
        "سجن أ"
      );
      expect(result?.status).toBe("OBSERVED_IMPROVEMENT");
      expect(result?.reasonLabel).toBeNull();
    });

    it("only changeRate <= -strongReasonChangeRatePercent (-30%) AND a long streak (>=4) earns the 'قوي ومستدام' wording", () => {
      const strongButShortStreak = evaluateBestPracticeCandidacy(
        finding({ currentValue: 10, previousValue: 20, changeRate: -50, supportingMetrics: { streakPeriods: 3 } }),
        "سجن أ"
      );
      expect(strongButShortStreak?.status).toBe("BEST_PRACTICE_CANDIDATE");
      expect(strongButShortStreak?.reasonLabel).not.toBe("تحسن قوي ومستدام");

      const strongAndLongStreak = evaluateBestPracticeCandidacy(
        finding({ currentValue: 10, previousValue: 20, changeRate: -50, supportingMetrics: { streakPeriods: 4 } }),
        "سجن أ"
      );
      expect(strongAndLongStreak?.reasonLabel).toBe("تحسن قوي ومستدام");
    });
  });

  describe("merit score safeguards (ranking never overrides the gate, and size/duration alone never qualify)", () => {
    it("a 100%-drop 5→0 case never outranks a 73→32 case merely for its percentage", () => {
      const small = evaluateBestPracticeCandidacy(
        finding({ currentValue: 0, previousValue: 5, changeRate: -100, supportingMetrics: { streakPeriods: 3 } }),
        "سجن صغير"
      ) as BestPracticeCandidateEvaluation;
      const large = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
      expect(small.status).toBe("BEST_PRACTICE_CANDIDATE");
      expect(large.status).toBe("BEST_PRACTICE_CANDIDATE");
      expect(large.meritScore).toBeGreaterThan(small.meritScore);
    });

    it("a large base volume alone (tiny actual drop) never qualifies", () => {
      const result = evaluateBestPracticeCandidacy(
        finding({ currentValue: 195, previousValue: 200, changeRate: -2.5, supportingMetrics: { streakPeriods: 3 } }),
        "سجن كبير"
      );
      expect(result?.status).toBe("OBSERVED_IMPROVEMENT");
    });

    it("a long streak alone (tiny decrease, tiny base) never qualifies", () => {
      const result = evaluateBestPracticeCandidacy(
        finding({ currentValue: 5, previousValue: 6, changeRate: -16.7, supportingMetrics: { streakPeriods: 6 } }),
        "سجن أ"
      );
      expect(result?.status).toBe("OBSERVED_IMPROVEMENT");
    });

    it("a gate-failing evaluation never reports a positive-looking merit score that could smuggle it into a ranked list", () => {
      // Below minAbsoluteDecrease/minBaseVolume — the meritScore field still
      // gets a number (needed for BestPracticeCandidateEvaluation's shape),
      // but callers must never treat OBSERVED_IMPROVEMENT as rankable; this
      // documents the status field as the actual authority, not the score.
      const result = evaluateBestPracticeCandidacy(
        finding({ currentValue: 1, previousValue: 2, changeRate: -50, supportingMetrics: { streakPeriods: 3 } }),
        "سجن أ"
      ) as BestPracticeCandidateEvaluation;
      expect(result.status).toBe("OBSERVED_IMPROVEMENT");
    });
  });

  describe("candidate change-rate window mismatch (governance review item 1)", () => {
    it("25→21 over 3 periods: candidate rate ≈ -16%, NOT finding.changeRate's -79% — stays OBSERVED_IMPROVEMENT, no strong reason, merit never sees -79", () => {
      const result = evaluateBestPracticeCandidacy(
        finding({
          previousValue: 25,
          currentValue: 21,
          changeRate: -79,
          supportingMetrics: { streakPeriods: 3 },
        }),
        "سجن أ"
      ) as BestPracticeCandidateEvaluation;

      expect(result.changeRatePercent).toBeCloseTo(-16, 1);
      expect(result.status).toBe("OBSERVED_IMPROVEMENT");
      expect(result.reasonLabel).toBeNull();

      // If merit had used -79% instead of the real -16%, its changeRate
      // factor would be clamp01(79/100)*20 ≈ 15.8 instead of clamp01(16/100)*20 ≈ 3.2 —
      // a ~12-point difference easily distinguishable in the total score.
      const meritIfWrongRateWereUsed = computeExpectedMeritWithGivenRate({
        decrease: 4, startValue: 25, streakPeriods: 3, changeRatePercent: -79,
      });
      expect(result.meritScore).toBeLessThan(meritIfWrongRateWereUsed);
    });

    it("25→20 over 3 periods: candidate rate is EXACTLY -20%, the candidacy boundary — qualifies", () => {
      const result = evaluateBestPracticeCandidacy(
        finding({
          previousValue: 25,
          currentValue: 20,
          changeRate: -1, // deliberately wrong/irrelevant whole-window rate — must be ignored
          supportingMetrics: { streakPeriods: 3 },
        }),
        "سجن أ"
      ) as BestPracticeCandidateEvaluation;

      expect(result.changeRatePercent).toBeCloseTo(-20, 5);
      expect(result.status).toBe("BEST_PRACTICE_CANDIDATE");
    });
  });
});

/**
 * Mirrors computeMeritScore's own formula (best-practice-candidate.ts) so
 * the "merit never uses the wrong rate" test above has an independent
 * expected value to compare against, using the SAME default config weights
 * (config is not exported per-field, so the scales/weights are inlined —
 * kept in sync manually; a drift here would only make this ONE test overly
 * strict/lenient, never mask the actual bug the test targets).
 */
function computeExpectedMeritWithGivenRate(input: { decrease: number; startValue: number; streakPeriods: number; changeRatePercent: number }): number {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const score =
    clamp01(input.decrease / 40) * 40
    + clamp01(input.streakPeriods / 6) * 25
    + clamp01(Math.abs(input.changeRatePercent) / 100) * 20
    + clamp01(input.startValue / 50) * 15;
  return Math.round(Math.min(100, Math.max(0, score)));
}

describe("findStrugglingFacilitiesForClassification", () => {
  it("finds other facilities still chronic or trending negative in the same classification (matched by classificationId)", () => {
    const findings: AnalyticalFinding[] = [
      finding({ id: "chronic-b", type: "CHRONIC_ISSUE", entityName: "سجن ب — الوصول إلى الطبيب", drilldownFilters: { facility: "سجن ب" } }),
      finding({
        id: "trend-c", type: "TREND_PATTERN", entityName: "سجن ج — الوصول إلى الطبيب",
        supportingMetrics: { pattern: "CONTINUED_RISE", streakPeriods: 3 }, drilldownFilters: { facility: "سجن ج" },
      }),
    ];
    const struggling = findStrugglingFacilitiesForClassification("سجن الملز", DOCTOR_ACCESS_CLASSIFICATION_ID, findings);
    expect(struggling).toEqual(["سجن ب", "سجن ج"]);
  });

  it("matches by classificationId even if a display label happens to differ (relabeled classification)", () => {
    const findings: AnalyticalFinding[] = [
      finding({
        id: "relabeled", type: "CHRONIC_ISSUE", entityName: "سجن ب — الوصول للطبيب (تسمية محدثة)",
        drilldownFilters: { facility: "سجن ب" },
      }),
    ];
    expect(findStrugglingFacilitiesForClassification("سجن الملز", DOCTOR_ACCESS_CLASSIFICATION_ID, findings)).toEqual(["سجن ب"]);
  });

  it("never matches a different classification even if its label text coincidentally matches", () => {
    const findings: AnalyticalFinding[] = [
      finding({
        id: "same-label-different-id", type: "CHRONIC_ISSUE", entityId: "cls-some-other-id",
        entityName: "سجن ب — الوصول إلى الطبيب", drilldownFilters: { facility: "سجن ب" },
      }),
    ];
    expect(findStrugglingFacilitiesForClassification("سجن الملز", DOCTOR_ACCESS_CLASSIFICATION_ID, findings)).toEqual([]);
  });

  it("excludes the candidate's own facility and unrelated classifications", () => {
    const findings: AnalyticalFinding[] = [
      finding({ id: "self", type: "CHRONIC_ISSUE", entityName: "سجن الملز — الوصول إلى الطبيب", drilldownFilters: { facility: "سجن الملز" } }),
      finding({ id: "other-topic", type: "CHRONIC_ISSUE", entityId: "cls-food", entityName: "سجن ب — التغذية", drilldownFilters: { facility: "سجن ب" } }),
    ];
    expect(findStrugglingFacilitiesForClassification("سجن الملز", DOCTOR_ACCESS_CLASSIFICATION_ID, findings)).toEqual([]);
  });

  it("a SUSTAINED_IMPROVEMENT elsewhere is never counted as 'still struggling'", () => {
    const findings: AnalyticalFinding[] = [
      finding({ id: "also-improving", type: "SUSTAINED_IMPROVEMENT", entityName: "سجن ب — الوصول إلى الطبيب", drilldownFilters: { facility: "سجن ب" } }),
    ];
    expect(findStrugglingFacilitiesForClassification("سجن الملز", DOCTOR_ACCESS_CLASSIFICATION_ID, findings)).toEqual([]);
  });

  it("a STABLE/no-signal trend pattern (defensive — the engine never actually emits one) is never counted as struggling", () => {
    const findings: AnalyticalFinding[] = [
      finding({
        id: "stable", type: "TREND_PATTERN", entityName: "سجن ب — الوصول إلى الطبيب",
        supportingMetrics: { pattern: "STABLE", streakPeriods: 0 }, drilldownFilters: { facility: "سجن ب" },
      }),
    ];
    expect(findStrugglingFacilitiesForClassification("سجن الملز", DOCTOR_ACCESS_CLASSIFICATION_ID, findings)).toEqual([]);
  });

  it("returns an empty list when nothing struggles with the same classification", () => {
    expect(findStrugglingFacilitiesForClassification("سجن الملز", DOCTOR_ACCESS_CLASSIFICATION_ID, [])).toEqual([]);
  });

  it("matches the UNCLASSIFIED bucket (null classificationId) as one shared group", () => {
    const findings: AnalyticalFinding[] = [
      finding({ id: "unclassified-b", type: "CHRONIC_ISSUE", entityId: null, entityName: "سجن ب — غير مصنف", drilldownFilters: { facility: "سجن ب" } }),
    ];
    expect(findStrugglingFacilitiesForClassification("سجن الملز", null, findings)).toEqual(["سجن ب"]);
  });
});

describe("buildBestPracticeSectionSummary", () => {
  it("returns null with no candidates", () => {
    expect(buildBestPracticeSectionSummary([])).toBeNull();
  });

  it("uses facility-neutral phrasing ('أظهرت بيانات X'), never a facility-as-subject verb like 'سجلت X'", () => {
    const c = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
    const summary = buildBestPracticeSectionSummary([c]);
    expect(summary).toBe(
      "أظهرت بيانات سجن الملز تحسناً مستداماً في الوصول إلى الطبيب، من 73 إلى 32 شكوى خلال 4 فترات، ويوصى بدراسة الإجراءات التي أسهمت في هذا التحسن والتحقق من إمكانية تعميمها."
    );
    expect(summary).not.toMatch(/^سجلت/);
  });

  it("never asserts the practice IS generalizable — only that studying it/its generalization is worthwhile", () => {
    const c = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
    const summary = buildBestPracticeSectionSummary([c]) ?? "";
    expect(summary).not.toContain("ممارسة قابلة للتعميم");
    expect(summary).not.toContain("ممارسة مثبتة");
  });

  it("uses a generic, count-based sentence for multiple DIFFERENT-facility candidates", () => {
    const a = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
    const b = evaluateBestPracticeCandidacy(
      finding({ currentValue: 6, previousValue: 20, changeRate: -70, entityName: "سجن الحائر — الطرود", drilldownFilters: { facility: "سجن الحائر" } }),
      "سجن الحائر"
    ) as BestPracticeCandidateEvaluation;
    const summary = buildBestPracticeSectionSummary([a, b]);
    expect(summary).toContain("موقعان");
    expect(summary).not.toContain("سجن الملز");
  });

  it("governance review item 4: the SAME facility qualifying in two classifications is reported as ONE site, never 'موقعان'", () => {
    const a = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
    const b = evaluateBestPracticeCandidacy(
      finding({ currentValue: 6, previousValue: 20, changeRate: -70, entityId: "cls-other", entityName: "سجن الملز — الطرود" }),
      "سجن الملز"
    ) as BestPracticeCandidateEvaluation;
    const summary = buildBestPracticeSectionSummary([a, b]) ?? "";
    expect(summary).not.toContain("موقعان");
    expect(summary).toContain("سجن الملز");
  });

  function evaluationAt(facility: string, classificationId: string): BestPracticeCandidateEvaluation {
    return evaluateBestPracticeCandidacy(
      finding({ entityId: classificationId, entityName: `${facility} — ت-${classificationId}`, drilldownFilters: { facility } }),
      facility
    ) as BestPracticeCandidateEvaluation;
  }

  it("source-of-truth item 1: 5 candidate rows from 5 DIFFERENT facilities => summary says 5 مواقع (same count the table would show)", () => {
    const evaluations = [
      evaluationAt("سجن 1", "c1"), evaluationAt("سجن 2", "c2"), evaluationAt("سجن 3", "c3"),
      evaluationAt("سجن 4", "c4"), evaluationAt("سجن 5", "c5"),
    ];
    expect(evaluations).toHaveLength(5); // same source the table rows would be built from
    const summary = buildBestPracticeSectionSummary(evaluations) ?? "";
    expect(summary).toContain("5 مواقع");
  });

  it("source-of-truth item 2/3: 5 candidate rows but only 4 unique facilities => summary says 4 مواقع, never 5", () => {
    const evaluations = [
      evaluationAt("سجن 1", "c1"),
      evaluationAt("سجن 1", "c1b"), // same facility, second classification — still 1 site
      evaluationAt("سجن 2", "c2"),
      evaluationAt("سجن 3", "c3"),
      evaluationAt("سجن 4", "c4"),
    ];
    expect(evaluations).toHaveLength(5); // the table can legitimately show all 5 rows
    const uniqueFacilities = new Set(evaluations.map((e) => e.facility));
    expect(uniqueFacilities.size).toBe(4);
    const summary = buildBestPracticeSectionSummary(evaluations) ?? "";
    expect(summary).toContain("4 مواقع");
    expect(summary).not.toContain("5 مواقع");
  });
});

describe("buildBestPracticeComparisonConclusion", () => {
  it("returns null with no candidates", () => {
    expect(buildBestPracticeComparisonConclusion([], [])).toBeNull();
  });

  it("returns null when no other facility struggles with the same classification", () => {
    const c = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
    expect(buildBestPracticeComparisonConclusion([c], [finding()])).toBeNull();
  });

  it("recommends comparing against a facility still struggling with the same classification, never claiming generalizability", () => {
    const c = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
    const strugglingFinding = finding({
      id: "b", type: "CHRONIC_ISSUE", entityName: "سجن ب — الوصول إلى الطبيب", drilldownFilters: { facility: "سجن ب" },
    });
    const sentence = buildBestPracticeComparisonConclusion([c], [finding(), strugglingFinding]);
    expect(sentence).toContain("سجن الملز");
    expect(sentence).toContain("سجن ب");
    expect(sentence).not.toContain("قابلة للتعميم بشكل مؤكد");
  });

  it("matches the struggling facility by the candidate's classificationId, not a same-text label from a different classification", () => {
    const c = evaluateBestPracticeCandidacy(finding(), "سجن الملز") as BestPracticeCandidateEvaluation;
    const sameLabelDifferentClassification = finding({
      id: "decoy", type: "CHRONIC_ISSUE", entityId: "cls-different",
      entityName: "سجن ب — الوصول إلى الطبيب", drilldownFilters: { facility: "سجن ب" },
    });
    expect(buildBestPracticeComparisonConclusion([c], [finding(), sameLabelDifferentClassification])).toBeNull();
  });
});
