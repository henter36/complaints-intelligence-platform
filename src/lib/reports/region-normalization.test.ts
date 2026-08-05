import { describe, expect, it } from "vitest";
import {
  assertRegionalReconciliation,
  displayRegionName,
  normalizeRegionName,
  UNSPECIFIED_REGION_KEY,
  UNSPECIFIED_REGION_LABEL,
} from "./region-normalization";

describe("normalizeRegionName", () => {
  it("collapses eastern and makkah aliases into one canonical bucket each", () => {
    const eastern = [
      "المنطقة الشرقية",
      "الشرقية",
      "منطقة الشرقية",
      " المنطقة الشرقية ",
    ].map((value) => normalizeRegionName(value));
    expect(new Set(eastern)).toEqual(new Set(["المنطقة الشرقية"]));

    const makkah = [
      "منطقة مكة المكرمة",
      "مكة المكرمة",
      "مكة",
    ].map((value) => normalizeRegionName(value));
    expect(new Set(makkah)).toEqual(new Set(["منطقة مكة المكرمة"]));
  });

  it("maps blank regions to the unspecified sentinel and displays Arabic label", () => {
    expect(normalizeRegionName(null)).toBe(UNSPECIFIED_REGION_KEY);
    expect(normalizeRegionName("")).toBe(UNSPECIFIED_REGION_KEY);
    expect(normalizeRegionName("غير محدد")).toBe(UNSPECIFIED_REGION_KEY);
    expect(displayRegionName(UNSPECIFIED_REGION_KEY)).toBe(UNSPECIFIED_REGION_LABEL);
  });

  it("does not invent a Saudi region for unknown labels", () => {
    expect(normalizeRegionName("N/A")).toBe("N/A");
    expect(normalizeRegionName("جدة")).toBe("جدة");
  });
});

describe("assertRegionalReconciliation", () => {
  it("passes when regional sums match period totals", () => {
    expect(() =>
      assertRegionalReconciliation({
        currentRows: [{ currentCount: 5 }, { currentCount: 3 }],
        previousRows: [{ previousCount: 4 }, { previousCount: 2 }],
        currentTotal: 8,
        previousTotal: 6,
      })
    ).not.toThrow();
  });

  it("fails when previous regional sum drifts from previousTotal", () => {
    expect(() =>
      assertRegionalReconciliation({
        currentRows: [{ currentCount: 8 }],
        previousRows: [{ previousCount: 7771 }],
        currentTotal: 8,
        previousTotal: 7703,
      })
    ).toThrow(/previous sum/);
  });
});
