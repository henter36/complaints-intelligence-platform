import { describe, expect, it } from "vitest";
import { filterFindingsByScope, filterPeriodChangeDigestByScope } from "./finding-scope-filter";
import type { AnalyticalFinding } from "./analytical-finding";
import type { PeriodChangeDigest } from "./period-change-digest";

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: "f1",
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
    drilldownFilters: { facility: "سجن أ", classificationId: "cls-1", from: "2026-01-01", to: "2026-01-31" },
    firstDetectedAt: "2026-01-31T00:00:00.000Z",
    lastDetectedAt: "2026-01-31T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

describe("filterFindingsByScope", () => {
  it("returns everything unchanged for an empty scope", () => {
    const findings = [finding({}), finding({ id: "f2", drilldownFilters: { facility: "سجن ب" } })];
    expect(filterFindingsByScope(findings, {})).toHaveLength(2);
  });

  it("filters by facility", () => {
    const findings = [finding({}), finding({ id: "f2", drilldownFilters: { facility: "سجن ب" } })];
    const result = filterFindingsByScope(findings, { facility: "سجن أ" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f1");
  });

  it("filters by classificationId", () => {
    const findings = [finding({}), finding({ id: "f2", drilldownFilters: { facility: "سجن أ", classificationId: "cls-2" } })];
    const result = filterFindingsByScope(findings, { classificationId: "cls-1" });
    expect(result).toHaveLength(1);
  });

  it("filters by region via the facility→region lookup", () => {
    const findings = [finding({}), finding({ id: "f2", drilldownFilters: { facility: "سجن ب" } })];
    const lookup = new Map([["سجن أ", "المنطقة الوسطى"], ["سجن ب", "المنطقة الشرقية"]]);
    const result = filterFindingsByScope(findings, { region: "المنطقة الوسطى" }, lookup);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f1");
  });

  it("keeps a cross-facility spread finding when the scoped facility is among its top contributors", () => {
    const spread = finding({
      id: "spread-1",
      type: "CROSS_FACILITY_SPREAD",
      drilldownFilters: { from: "2026-01-01", to: "2026-01-31" },
      supportingMetrics: { topContributingFacilities: JSON.stringify(["سجن أ", "سجن ب", "سجن ج"]) },
    });
    expect(filterFindingsByScope([spread], { facility: "سجن ب" })).toHaveLength(1);
    expect(filterFindingsByScope([spread], { facility: "سجن غير موجود" })).toHaveLength(0);
  });
});

describe("filterPeriodChangeDigestByScope", () => {
  const digest: PeriodChangeDigest = {
    newProblems: [{ key: "k1", facility: "سجن أ", classificationLabel: "التغذية", pattern: "EMERGING", priorityBand: "MEDIUM" }],
    continuingProblems: [],
    worsenedProblems: [{ key: "k2", facility: "سجن ب", classificationLabel: "الاتصال", from: "MEDIUM", to: "HIGH" }],
    relapsedProblems: [],
    improvedFacilities: [],
    exitedPriorityList: [],
    newlySpreadingClassifications: ["الرعاية الصحية"],
  };

  it("scopes every list by facility but keeps newlySpreadingClassifications untouched (org-wide baseline)", () => {
    const scoped = filterPeriodChangeDigestByScope(digest, { facility: "سجن أ" });
    expect(scoped.newProblems).toHaveLength(1);
    expect(scoped.worsenedProblems).toHaveLength(0);
    expect(scoped.newlySpreadingClassifications).toEqual(["الرعاية الصحية"]);
  });
});
