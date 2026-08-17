import { describe, expect, it } from "vitest";
import { rankFindingsForExecutiveBrief } from "./finding-ranking";
import type { AnalyticalFinding } from "./analytical-finding";

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: overrides.id ?? "f",
    type: "TREND_PATTERN",
    entityType: "CLASSIFICATION",
    entityId: null,
    entityName: "x",
    currentValue: 10,
    previousValue: 5,
    difference: 5,
    changeRate: 100,
    severity: "MEDIUM",
    priorityScore: 50,
    confidence: "MEDIUM",
    detectionSource: "QUANTITATIVE",
    explanation: "x",
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

describe("rankFindingsForExecutiveBrief", () => {
  it("never lets category order override a real priorityScore difference", () => {
    const lowScoreChronic = finding({ id: "chronic-low", type: "CHRONIC_ISSUE", priorityScore: 10 });
    const highScoreImprovement = finding({ id: "improvement-high", type: "SUSTAINED_IMPROVEMENT", priorityScore: 90 });
    const [first] = rankFindingsForExecutiveBrief([lowScoreChronic, highScoreImprovement]);
    expect(first.id).toBe("improvement-high");
  });

  it("orders equal-score categories: chronic, then escalation, then relapse, then repeat/spread, then improvement last", () => {
    const chronic = finding({ id: "chronic", type: "CHRONIC_ISSUE", priorityScore: 60 });
    const escalating = finding({ id: "escalating", type: "TREND_PATTERN", priorityScore: 60, supportingMetrics: { pattern: "ESCALATING" } });
    const relapse = finding({ id: "relapse", type: "TREND_PATTERN", priorityScore: 60, supportingMetrics: { pattern: "RELAPSE_AFTER_IMPROVEMENT" } });
    const repeat = finding({ id: "repeat", type: "REPEAT_COMPLAINANT", priorityScore: 60 });
    const improvement = finding({ id: "improvement", type: "SUSTAINED_IMPROVEMENT", priorityScore: 60 });

    const ranked = rankFindingsForExecutiveBrief([improvement, repeat, relapse, escalating, chronic]);
    expect(ranked.map((f) => f.id)).toEqual(["chronic", "escalating", "relapse", "repeat", "improvement"]);
  });
});
