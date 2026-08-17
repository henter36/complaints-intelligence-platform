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
});
