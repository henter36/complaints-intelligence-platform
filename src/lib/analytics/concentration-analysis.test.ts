import { describe, expect, it } from "vitest";
import { analyzeClassificationConcentration, analyzeWingConcentration } from "./concentration-analysis";

describe("analyzeClassificationConcentration", () => {
  it("flags unusual concentration when a facility's share far exceeds the org average", () => {
    const result = analyzeClassificationConcentration({
      facility: "سجن X",
      classificationLabel: "التغذية",
      facilityClassificationCount: 32,
      facilityTotal: 100,
      orgWideClassificationCountExcludingFacility: 90,
      orgWideTotalExcludingFacility: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!.facilitySharePercent).toBe(32);
    expect(result!.orgAverageSharePercent).toBe(9);
    expect(result!.isUnusual).toBe(true);
  });

  it("does not flag concentration when the facility's share is close to the org average", () => {
    const result = analyzeClassificationConcentration({
      facility: "سجن X",
      classificationLabel: "التغذية",
      facilityClassificationCount: 12,
      facilityTotal: 100,
      orgWideClassificationCountExcludingFacility: 100,
      orgWideTotalExcludingFacility: 1000,
    });
    expect(result!.isUnusual).toBe(false);
  });

  it("returns null when the facility doesn't have enough volume to judge (data quality gate)", () => {
    const result = analyzeClassificationConcentration({
      facility: "سجن X",
      classificationLabel: "التغذية",
      facilityClassificationCount: 2,
      facilityTotal: 10,
      orgWideClassificationCountExcludingFacility: 90,
      orgWideTotalExcludingFacility: 1000,
    });
    expect(result).toBeNull();
  });
});

describe("analyzeWingConcentration", () => {
  it("reports concentration in 1-2 wings when data is complete", () => {
    const result = analyzeWingConcentration({
      facility: "سجن X",
      classificationLabel: "التغذية",
      wingCounts: [
        { wingCode: "A", count: 20 },
        { wingCode: "B", count: 12 },
        { wingCode: "C", count: 8 },
        { wingCode: "D", count: 10 },
      ],
      totalWithWingData: 50,
      totalComplaints: 50,
    });
    expect(result).not.toBeNull();
    expect(result!.combinedSharePercent).toBe(64);
    expect(result!.isConcentrated).toBe(true);
  });

  it("returns null when wing data coverage is too incomplete to trust", () => {
    const result = analyzeWingConcentration({
      facility: "سجن X",
      classificationLabel: "التغذية",
      wingCounts: [{ wingCode: "A", count: 10 }],
      totalWithWingData: 10,
      totalComplaints: 50,
    });
    expect(result).toBeNull();
  });
});
