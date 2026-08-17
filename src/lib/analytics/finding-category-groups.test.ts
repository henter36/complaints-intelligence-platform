import { describe, expect, it } from "vitest";
import { groupFindingsByCategory } from "./finding-category-groups";
import type { AnalyticalFinding } from "./analytical-finding";

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: overrides.id ?? "f",
    type: "CHRONIC_ISSUE",
    entityType: "CLASSIFICATION",
    entityId: null,
    entityName: "x",
    currentValue: 1,
    previousValue: null,
    difference: null,
    changeRate: null,
    severity: "LOW",
    priorityScore: 0,
    confidence: "LOW",
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

describe("groupFindingsByCategory", () => {
  it("separates relapse from the general escalation/continuation category", () => {
    const escalating = finding({ id: "e", type: "TREND_PATTERN", supportingMetrics: { pattern: "ESCALATING" } });
    const relapse = finding({ id: "r", type: "TREND_PATTERN", supportingMetrics: { pattern: "RELAPSE_AFTER_IMPROVEMENT" } });
    const groups = groupFindingsByCategory([escalating, relapse]);

    const escalationGroup = groups.find((g) => g.id === "escalation");
    const relapseGroup = groups.find((g) => g.id === "relapse");
    expect(escalationGroup?.findings.map((f) => f.id)).toEqual(["e"]);
    expect(relapseGroup?.findings.map((f) => f.id)).toEqual(["r"]);
  });

  it("folds CONCENTRATION and WING_CONCENTRATION into one 'within a site' category", () => {
    const concentration = finding({ id: "c", type: "CONCENTRATION" });
    const wing = finding({ id: "w", type: "WING_CONCENTRATION" });
    const groups = groupFindingsByCategory([concentration, wing]);
    const group = groups.find((g) => g.id === "concentration");
    expect(group?.findings.map((f) => f.id).sort()).toEqual(["c", "w"]);
  });

  it("omits empty categories entirely", () => {
    const groups = groupFindingsByCategory([finding({ type: "CHRONIC_ISSUE" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("chronic");
  });
});
