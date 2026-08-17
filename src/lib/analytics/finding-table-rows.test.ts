import { describe, expect, it } from "vitest";
import { toFindingTableRow } from "./finding-table-rows";
import type { AnalyticalFinding } from "./analytical-finding";

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: "chronic_issue:سجن أ:cls-1:2026-01-01",
    type: "CHRONIC_ISSUE",
    entityType: "CLASSIFICATION",
    entityId: "cls-1",
    entityName: "سجن أ — التغذية",
    currentValue: 46,
    previousValue: 43,
    difference: 3,
    changeRate: 7,
    severity: "HIGH",
    priorityScore: 78,
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: "مشكلة مزمنة بسبب: استمرار 5 فترات + تكرار مرتفع",
    supportingMetrics: {
      streakPeriods: 5,
      repeatRatePercent: 18.4,
      facilitySharePercent: 29,
      distinctComplainants: 8,
      priorityReasons: JSON.stringify(["استمرار 5 فترات", "معدل تكرار مرتفع"]),
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: { facility: "سجن أ", classificationId: "cls-1" },
    firstDetectedAt: "2026-01-31T00:00:00.000Z",
    lastDetectedAt: "2026-01-31T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

describe("toFindingTableRow", () => {
  it("splits facility and classification from the entity name", () => {
    const row = toFindingTableRow(finding({}));
    expect(row.facility).toBe("سجن أ");
    expect(row.classification).toBe("التغذية");
  });

  it("extracts numeric metrics without recomputing them", () => {
    const row = toFindingTableRow(finding({}));
    expect(row.periodsObserved).toBe(5);
    expect(row.repeatRate).toBe(18.4);
    expect(row.concentrationRate).toBe(29);
    expect(row.affectedComplainants).toBe(8);
  });

  it("joins the engine's own priority reasons instead of inventing new text", () => {
    const row = toFindingTableRow(finding({}));
    expect(row.reasons).toBe("استمرار 5 فترات؛ معدل تكرار مرتفع");
  });

  it("uses the facility name alone for facility-level findings, with no classification", () => {
    const row = toFindingTableRow(
      finding({ entityType: "FACILITY", entityName: "سجن ب", supportingMetrics: {} })
    );
    expect(row.facility).toBe("سجن ب");
    expect(row.classification).toBe("");
  });

  it("reports an unavailable direction rather than a misleading label when there is no previous value", () => {
    const row = toFindingTableRow(finding({ previousValue: null }));
    expect(row.direction).toBe("غير متاح");
  });
});
