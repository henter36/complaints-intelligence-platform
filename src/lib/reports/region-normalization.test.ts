import { describe, expect, it } from "vitest";
import {
  assertRegionalReconciliation,
  displayRegionName,
  normalizeRegionName,
  UNSPECIFIED_REGION_KEY,
  UNSPECIFIED_REGION_LABEL,
} from "./region-normalization";

describe("normalizeRegionName", () => {
  it("collapses eastern aliases including منطقة الشرقية via regionKey", () => {
    expect(normalizeRegionName("المنطقة الشرقية")).toBe("المنطقة الشرقية");
    expect(normalizeRegionName("منطقة الشرقية")).toBe("المنطقة الشرقية");
    expect(normalizeRegionName("الشرقية")).toBe("المنطقة الشرقية");
    expect(normalizeRegionName("الشرقيه")).toBe("المنطقة الشرقية");
  });

  it("collapses makkah and madinah aliases", () => {
    expect(normalizeRegionName("مكة")).toBe("منطقة مكة المكرمة");
    expect(normalizeRegionName("مكة المكرمة")).toBe("منطقة مكة المكرمة");
    expect(normalizeRegionName("المدينة")).toBe("منطقة المدينة المنورة");
    expect(normalizeRegionName("المدينة المنورة")).toBe("منطقة المدينة المنورة");
    expect(normalizeRegionName("الرياض")).toBe("منطقة الرياض");
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
