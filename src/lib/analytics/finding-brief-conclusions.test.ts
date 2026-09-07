import { describe, expect, it } from "vitest";
import { buildPatternAnalysisBriefConclusions } from "./finding-brief-conclusions";
import type { AnalyticalFinding } from "./analytical-finding";
import type { PeriodChangeDigest } from "./period-change-digest";

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
    const digest: PeriodChangeDigest = {
      ...EMPTY_DIGEST,
      improvedFacilities: [
        { key: "k", facility: "سجن الملز", classificationLabel: "الوصول إلى الطبيب", pattern: "SUSTAINED_IMPROVEMENT", priorityBand: "LOW" },
      ],
    };
    const strongImprovement = finding({
      id: "imp",
      type: "SUSTAINED_IMPROVEMENT",
      entityName: "سجن الملز — الوصول إلى الطبيب",
      currentValue: 32,
      previousValue: 73,
      changeRate: -56.2,
      supportingMetrics: { streakPeriods: 4 },
      drilldownFilters: { facility: "سجن الملز" },
    });
    const lines = buildPatternAnalysisBriefConclusions({ findings: [strongImprovement], periodChangeDigest: digest });
    expect(lines[lines.length - 1]).toBe(
      "ما تغير منذ الفترة السابقة: 1 موقع حقق تحسناً مستداماً، منها 1 موقع مرشح لدراسة ممارسة ناجحة."
    );
  });

  it("does not append the candidate clause when the improved facility doesn't clear the candidacy bar", () => {
    const digest: PeriodChangeDigest = {
      ...EMPTY_DIGEST,
      improvedFacilities: [
        { key: "k", facility: "سجن أ", classificationLabel: "الاتصال", pattern: "SUSTAINED_IMPROVEMENT", priorityBand: "LOW" },
      ],
    };
    const trivialImprovement = finding({
      id: "imp",
      type: "SUSTAINED_IMPROVEMENT",
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
});
