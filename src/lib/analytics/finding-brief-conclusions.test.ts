import { describe, expect, it } from "vitest";
import { buildPatternAnalysisBriefConclusions } from "./finding-brief-conclusions";
import type { AnalyticalFinding } from "./analytical-finding";
import { buildPatternSnapshotKey, type PeriodChangeDigest } from "./period-change-digest";
import { evaluateBestPracticeCandidacy, type BestPracticeCandidateEvaluation } from "./best-practice-candidate";

/**
 * Mirrors report-executive-brief-data-service.ts's rankBestPracticeCandidateEvaluations
 * closely enough for these fixtures (facility from drilldownFilters, keep
 * only BEST_PRACTICE_CANDIDATE status) — so tests build the SAME kind of
 * authoritative candidate list the real pipeline passes into
 * buildPatternAnalysisBriefConclusions, instead of re-deriving candidacy
 * with different logic than what's under test.
 */
function toCandidateEvaluations(findings: readonly AnalyticalFinding[]): BestPracticeCandidateEvaluation[] {
  const evaluations: BestPracticeCandidateEvaluation[] = [];
  for (const f of findings) {
    const facility = typeof f.drilldownFilters.facility === "string" ? f.drilldownFilters.facility : "";
    const evaluation = evaluateBestPracticeCandidacy(f, facility);
    if (evaluation?.status === "BEST_PRACTICE_CANDIDATE") evaluations.push(evaluation);
  }
  return evaluations;
}

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: overrides.id ?? "f",
    type: "CHRONIC_ISSUE",
    entityType: "CLASSIFICATION",
    entityId: null,
    entityName: "سجن أ — التغذية",
    currentValue: 46,
    previousValue: 43,
    difference: 3,
    changeRate: 7,
    severity: "HIGH",
    priorityScore: 80,
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: "مشكلة مزمنة بسبب: استمرار 5 فترات",
    supportingMetrics: {},
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: {},
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

const EMPTY_DIGEST: PeriodChangeDigest = {
  newProblems: [],
  continuingProblems: [],
  worsenedProblems: [],
  relapsedProblems: [],
  improvedFacilities: [],
  exitedPriorityList: [],
  newlySpreadingClassifications: [],
};

describe("buildPatternAnalysisBriefConclusions", () => {
  it("returns nothing when there is no pattern analysis", () => {
    expect(buildPatternAnalysisBriefConclusions(undefined)).toEqual([]);
  });

  it("uses the engine's own explanation text verbatim, capped to maxFindings", () => {
    const findings = [finding({ id: "a", priorityScore: 90 }), finding({ id: "b", priorityScore: 10 })];
    const lines = buildPatternAnalysisBriefConclusions({ findings, periodChangeDigest: EMPTY_DIGEST }, 1);
    expect(lines).toEqual(["مشكلة مزمنة بسبب: استمرار 5 فترات"]);
  });

  it("appends a short what-changed summary sentence when the digest has real movement", () => {
    const digest: PeriodChangeDigest = {
      ...EMPTY_DIGEST,
      newProblems: [{ key: "k", facility: "f", classificationLabel: "c", pattern: "EMERGING", priorityBand: "MEDIUM" }],
    };
    const lines = buildPatternAnalysisBriefConclusions({ findings: [], periodChangeDigest: digest });
    expect(lines).toEqual(["ما تغير منذ الفترة السابقة: 1 إشارة ناشئة."]);
  });

  it("omits the what-changed sentence when nothing moved", () => {
    const lines = buildPatternAnalysisBriefConclusions({ findings: [], periodChangeDigest: EMPTY_DIGEST });
    expect(lines).toEqual([]);
  });

  it("appends a best-practice-candidate count when a newly-improved facility also clears the candidacy bar", () => {
    const classificationId = "cls-doctor-access";
    const digest: PeriodChangeDigest = {
      ...EMPTY_DIGEST,
      improvedFacilities: [
        {
          key: buildPatternSnapshotKey("سجن الملز", classificationId),
          facility: "سجن الملز", classificationLabel: "الوصول إلى الطبيب", pattern: "SUSTAINED_IMPROVEMENT", priorityBand: "LOW",
        },
      ],
    };
    const strongImprovement = finding({
      id: "imp",
      type: "SUSTAINED_IMPROVEMENT",
      entityId: classificationId,
      entityName: "سجن الملز — الوصول إلى الطبيب",
      currentValue: 32,
      previousValue: 73,
      // Deliberately inconsistent with startValue/currentValue — candidacy
      // must derive its own rate from those, never read this field.
      changeRate: -1,
      supportingMetrics: { streakPeriods: 4 },
      drilldownFilters: { facility: "سجن الملز" },
    });
    const lines = buildPatternAnalysisBriefConclusions(
      { findings: [strongImprovement], periodChangeDigest: digest },
      2,
      toCandidateEvaluations([strongImprovement])
    );
    expect(lines[lines.length - 1]).toBe(
      "ما تغير منذ الفترة السابقة: 1 موقع حقق تحسناً مستداماً، منها 1 موقع مرشح لدراسة ممارسة ناجحة."
    );
  });

  it("does not append the candidate clause when the improved facility doesn't clear the candidacy bar", () => {
    const classificationId = "cls-contact";
    const digest: PeriodChangeDigest = {
      ...EMPTY_DIGEST,
      improvedFacilities: [
        {
          key: buildPatternSnapshotKey("سجن أ", classificationId),
          facility: "سجن أ", classificationLabel: "الاتصال", pattern: "SUSTAINED_IMPROVEMENT", priorityBand: "LOW",
        },
      ],
    };
    const trivialImprovement = finding({
      id: "imp",
      type: "SUSTAINED_IMPROVEMENT",
      entityId: classificationId,
      entityName: "سجن أ — الاتصال",
      currentValue: 1,
      previousValue: 2,
      changeRate: -50,
      supportingMetrics: { streakPeriods: 3 },
      drilldownFilters: { facility: "سجن أ" },
    });
    const lines = buildPatternAnalysisBriefConclusions({ findings: [trivialImprovement], periodChangeDigest: digest });
    expect(lines[lines.length - 1]).toBe("ما تغير منذ الفترة السابقة: 1 موقع حقق تحسناً مستداماً.");
  });

  it("governance review item 3: two DIFFERENT classifications (at two different facilities) sharing the same Arabic label each match their OWN finding, never each other's (canonical classificationId, not the display label)", () => {
    // Both snapshots below carry the SAME display label — only their
    // canonical classificationId differs. A label-keyed lookup would
    // conflate them; countBestPracticeCandidatesAmongImproved must match
    // strictly on buildPatternSnapshotKey(facility, classificationId)
    // against the report's own bestPracticeCandidateEvaluations, so only
    // the genuinely-qualifying facility×classification pair counts.
    const sharedLabel = "خدمة مشتركة";
    const qualifyingId = "cls-a-real";
    const nonQualifyingId = "cls-b-real";
    const digest: PeriodChangeDigest = {
      ...EMPTY_DIGEST,
      improvedFacilities: [
        {
          key: buildPatternSnapshotKey("سجن أ", qualifyingId),
          facility: "سجن أ", classificationLabel: sharedLabel, pattern: "SUSTAINED_IMPROVEMENT", priorityBand: "LOW",
        },
        {
          key: buildPatternSnapshotKey("سجن ب", nonQualifyingId),
          facility: "سجن ب", classificationLabel: sharedLabel, pattern: "SUSTAINED_IMPROVEMENT", priorityBand: "LOW",
        },
      ],
    };
    const qualifyingFinding = finding({
      id: "a",
      type: "SUSTAINED_IMPROVEMENT",
      entityId: qualifyingId,
      entityName: `سجن أ — ${sharedLabel}`,
      currentValue: 32,
      previousValue: 73,
      supportingMetrics: { streakPeriods: 4 },
      drilldownFilters: { facility: "سجن أ" },
    });
    const nonQualifyingFinding = finding({
      id: "b",
      type: "SUSTAINED_IMPROVEMENT",
      entityId: nonQualifyingId,
      entityName: `سجن ب — ${sharedLabel}`,
      currentValue: 1,
      previousValue: 2,
      supportingMetrics: { streakPeriods: 3 },
      drilldownFilters: { facility: "سجن ب" },
    });
    // Also exercises Arabic dual agreement: 2 unique improved facilities
    // must produce "2 موقعان حققا..." — never "بيانات موقعان" or any other
    // incorrect case/number agreement.
    const lines = buildPatternAnalysisBriefConclusions(
      { findings: [qualifyingFinding, nonQualifyingFinding], periodChangeDigest: digest },
      2,
      toCandidateEvaluations([qualifyingFinding, nonQualifyingFinding])
    );
    expect(lines[lines.length - 1]).toBe(
      "ما تغير منذ الفترة السابقة: 2 موقعان حققا تحسناً مستداماً، منها 1 موقع مرشح لدراسة ممارسة ناجحة."
    );
  });
});
