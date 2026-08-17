import { describe, expect, it, vi } from "vitest";
import type { PatternSeries, PatternSeriesRecord } from "./pattern-period-series-service";

const mockLoadPatternSeries = vi.fn();
vi.mock("./pattern-period-series-service", () => ({
  loadPatternSeries: (...args: unknown[]) => mockLoadPatternSeries(...args),
}));

const mockLoadFacilityOperationalRegistry = vi.fn();
vi.mock("@/server/facilities/facility-operational-scope-service", () => ({
  loadFacilityOperationalRegistry: (...args: unknown[]) => mockLoadFacilityOperationalRegistry(...args),
}));

const { loadPatternAnalysisForFilters } = await import("./pattern-report-integration-service");

function genCountRecords(facility: string, classificationId: string, classificationLabel: string, counts: number[], idPrefix: string): PatternSeriesRecord[] {
  const records: PatternSeriesRecord[] = [];
  counts.forEach((count, periodIndex) => {
    for (let j = 0; j < count; j++) {
      records.push({
        complaintId: `${idPrefix}-${periodIndex}-${j}`,
        periodIndex,
        facility,
        classificationId,
        classificationLabel,
        subject: classificationLabel,
        complainantIdentifier: `${idPrefix}-id-p${periodIndex}`,
        wingCode: null,
        isPotentialDuplicate: false,
        duplicateOfId: null,
      });
    }
  });
  return records;
}

function buildFixtureSeries(): PatternSeries {
  const base = new Date("2026-01-01T00:00:00.000Z").getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const periods = Array.from({ length: 7 }, (_, i) => ({
    from: new Date(base + i * 30 * DAY_MS),
    toExclusive: new Date(base + (i + 1) * 30 * DAY_MS),
  }));
  const records = [
    ...genCountRecords("سجن أ", "cls-food", "التغذية", [3, 3, 8, 8, 8, 8, 8], "food"),
    ...genCountRecords("سجن ب", "cls-contact", "الاتصال", [3, 3, 8, 8, 8, 8, 8], "contact"),
  ];
  return { periods, records };
}

describe("loadPatternAnalysisForFilters", () => {
  it("returns every finding when scope is empty, without loading the facility registry", async () => {
    mockLoadPatternSeries.mockResolvedValueOnce(buildFixtureSeries());
    const result = await loadPatternAnalysisForFilters(new Date(), new Date(), {});
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.entityName.includes("سجن أ"))).toBe(true);
    expect(result.findings.some((f) => f.entityName.includes("سجن ب"))).toBe(true);
    expect(mockLoadFacilityOperationalRegistry).not.toHaveBeenCalled();
  });

  it("scopes findings to one facility without pulling in unrelated findings", async () => {
    mockLoadPatternSeries.mockResolvedValueOnce(buildFixtureSeries());
    const result = await loadPatternAnalysisForFilters(new Date(), new Date(), { facility: "سجن أ" });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.entityName.includes("سجن أ"))).toBe(true);
  });

  it("scopes findings by region using the facility registry lookup", async () => {
    mockLoadPatternSeries.mockResolvedValueOnce(buildFixtureSeries());
    mockLoadFacilityOperationalRegistry.mockResolvedValueOnce({
      facilities: [
        { id: "1", name: "سجن أ", normalizedName: "سجن أ", region: "المنطقة الوسطى", status: "ACTIVE", closedAt: null },
        { id: "2", name: "سجن ب", normalizedName: "سجن ب", region: "المنطقة الشرقية", status: "ACTIVE", closedAt: null },
      ],
      byNormalizedName: new Map(),
    });
    const result = await loadPatternAnalysisForFilters(new Date(), new Date(), { region: "المنطقة الوسطى" });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.entityName.includes("سجن أ"))).toBe(true);
  });

  it("exposes the exact periods behind the series for timeline reconstruction", async () => {
    mockLoadPatternSeries.mockResolvedValueOnce(buildFixtureSeries());
    const result = await loadPatternAnalysisForFilters(new Date(), new Date(), {});
    expect(result.periods).toHaveLength(7);
    expect(result.periods[0].from).toBe("2026-01-01");
  });
});
