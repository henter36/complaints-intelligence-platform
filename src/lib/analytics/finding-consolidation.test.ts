import { describe, expect, it } from "vitest";
import { consolidateFindingsForBrief } from "./finding-consolidation";
import type { AnalyticalFinding } from "./analytical-finding";

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: overrides.id ?? "f",
    type: "CHRONIC_ISSUE",
    entityType: "CLASSIFICATION",
    entityId: "cls-1",
    entityName: "سجن أ — التغذية",
    currentValue: 10,
    previousValue: 8,
    difference: 2,
    changeRate: 25,
    severity: "HIGH",
    priorityScore: 70,
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: "مشكلة مزمنة بسبب: استمرار",
    supportingMetrics: {},
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: { facility: "سجن أ", classificationId: "cls-1" },
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

describe("consolidateFindingsForBrief", () => {
  it("merges chronic + wing concentration + matching repeat complaints into one card without losing the originals", () => {
    const chronic = finding({ id: "chronic", priorityScore: 80 });
    const wing = finding({
      id: "wing",
      type: "WING_CONCENTRATION",
      priorityScore: 40,
      drilldownFilters: { facility: "سجن أ", classificationId: "cls-1" },
    });
    const repeat = finding({
      id: "repeat",
      type: "REPEAT_COMPLAINANT",
      entityType: "FACILITY",
      entityName: "سجن أ",
      priorityScore: 30,
      drilldownFilters: { facility: "سجن أ" },
      supportingMetrics: { repeatEntries: JSON.stringify([{ topicLabel: "التغذية", complaintCount: 5, periodsSpanned: 3 }]) },
    });

    const cards = consolidateFindingsForBrief([chronic, wing, repeat]);
    expect(cards).toHaveLength(1);
    expect(cards[0].primary.id).toBe("chronic");
    expect(cards[0].mergedFindings.map((f) => f.id).sort()).toEqual(["chronic", "repeat", "wing"]);
    expect(cards[0].additionalSignalLabels).toContain("تركّز داخل جناح");
    expect(cards[0].additionalSignalLabels).toContain("تكرار شكوى");
  });

  it("does not merge an unrelated facility's repeat complaints", () => {
    const chronic = finding({ id: "chronic" });
    const repeat = finding({
      id: "repeat",
      type: "REPEAT_COMPLAINANT",
      entityType: "FACILITY",
      entityName: "سجن ب",
      drilldownFilters: { facility: "سجن ب" },
      supportingMetrics: { repeatEntries: JSON.stringify([{ topicLabel: "التغذية" }]) },
    });
    const cards = consolidateFindingsForBrief([chronic, repeat]);
    expect(cards).toHaveLength(2);
  });

  it("keeps a facility-level finding with no classification dimension as its own card", () => {
    const multiIssue = finding({
      id: "multi",
      type: "MULTI_ISSUE_FACILITY",
      entityType: "FACILITY",
      entityName: "سجن أ",
      drilldownFilters: { facility: "سجن أ" },
    });
    const cards = consolidateFindingsForBrief([multiIssue]);
    expect(cards).toHaveLength(1);
    expect(cards[0].mergedFindings).toEqual([multiIssue]);
  });

  it("orders cards by the primary finding's priority score", () => {
    const low = finding({ id: "low", priorityScore: 20, drilldownFilters: { facility: "سجن ج", classificationId: "cls-3" } });
    const high = finding({ id: "high", priorityScore: 90, drilldownFilters: { facility: "سجن د", classificationId: "cls-4" } });
    const cards = consolidateFindingsForBrief([low, high]);
    expect(cards[0].primary.id).toBe("high");
  });
});
