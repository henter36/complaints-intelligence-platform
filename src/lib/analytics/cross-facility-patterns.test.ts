import { describe, expect, it } from "vitest";
import {
  detectCompositionShift,
  detectCrossFacilitySpread,
  detectMultiIssueFacilities,
  type FacilityClassificationChange,
  type FacilityClassificationSignal,
} from "./cross-facility-patterns";

describe("detectCrossFacilitySpread", () => {
  it("rolls up a simultaneous rise across several facilities into one finding", () => {
    const changes: FacilityClassificationChange[] = [
      { facility: "سجن أ", classificationLabel: "الرعاية الصحية", currentCount: 20, previousCount: 10 },
      { facility: "سجن ب", classificationLabel: "الرعاية الصحية", currentCount: 15, previousCount: 8 },
      { facility: "سجن ج", classificationLabel: "الرعاية الصحية", currentCount: 12, previousCount: 5 },
      { facility: "سجن د", classificationLabel: "الرعاية الصحية", currentCount: 3, previousCount: 1 },
    ];
    const results = detectCrossFacilitySpread(changes);
    expect(results).toHaveLength(1);
    expect(results[0].affectedFacilityCount).toBe(3);
    expect(results[0].topContributingFacilities[0].facility).toBe("سجن أ");
  });

  it("does not report spread when fewer than the minimum facilities are affected", () => {
    const changes: FacilityClassificationChange[] = [
      { facility: "سجن أ", classificationLabel: "الرعاية الصحية", currentCount: 20, previousCount: 10 },
      { facility: "سجن ب", classificationLabel: "الرعاية الصحية", currentCount: 6, previousCount: 6 },
    ];
    expect(detectCrossFacilitySpread(changes)).toHaveLength(0);
  });
});

describe("detectCompositionShift", () => {
  it("finds a rising classification replacing a falling one while the total stays flat", () => {
    const result = detectCompositionShift({
      facility: "سجن X",
      facilityTotalCurrent: 100,
      facilityTotalPrevious: 98,
      classifications: [
        { label: "التغذية", currentCount: 15, previousCount: 40 },
        { label: "الاتصال", currentCount: 45, previousCount: 18 },
        { label: "أخرى", currentCount: 40, previousCount: 40 },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.risingClassification).toBe("الاتصال");
    expect(result!.fallingClassification).toBe("التغذية");
    expect(result!.becameTopClassification).toBe(true);
  });

  it("returns null when the facility total itself moved materially", () => {
    const result = detectCompositionShift({
      facility: "سجن X",
      facilityTotalCurrent: 200,
      facilityTotalPrevious: 100,
      classifications: [
        { label: "التغذية", currentCount: 15, previousCount: 40 },
        { label: "الاتصال", currentCount: 45, previousCount: 18 },
      ],
    });
    expect(result).toBeNull();
  });
});

describe("detectMultiIssueFacilities", () => {
  it("flags a facility with several simultaneously negative classifications", () => {
    const signals: FacilityClassificationSignal[] = [
      { facility: "سجن X", classificationLabel: "التغذية", isNegativeTrend: true, streakPeriods: 4, sharePercent: 30 },
      { facility: "سجن X", classificationLabel: "الاتصال", isNegativeTrend: true, streakPeriods: 3, sharePercent: 20 },
      { facility: "سجن X", classificationLabel: "النظافة", isNegativeTrend: false, streakPeriods: 0, sharePercent: 5 },
    ];
    const results = detectMultiIssueFacilities(signals);
    expect(results).toHaveLength(1);
    expect(results[0].affectedClassificationCount).toBe(2);
  });

  it("does not flag a facility with only one negative classification", () => {
    const signals: FacilityClassificationSignal[] = [
      { facility: "سجن X", classificationLabel: "التغذية", isNegativeTrend: true, streakPeriods: 4, sharePercent: 30 },
    ];
    expect(detectMultiIssueFacilities(signals)).toHaveLength(0);
  });
});
