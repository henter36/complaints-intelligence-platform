import { describe, expect, it } from "vitest";
import {
  getComparisonModeLabelShort,
  getComparisonModeLabelForTable,
  getComparisonModeDescription,
} from "./comparison-mode-labels";

const PREV = { from: "2024-01-01", to: "2024-12-31" };

describe("getComparisonModeLabelShort", () => {
  it("returns correct label for SAME_PERIOD_LAST_YEAR", () => {
    expect(getComparisonModeLabelShort("SAME_PERIOD_LAST_YEAR")).toBe(
      "الفترة المماثلة من السنة السابقة"
    );
  });

  it("returns correct label for PREVIOUS_EQUIVALENT_PERIOD", () => {
    expect(getComparisonModeLabelShort("PREVIOUS_EQUIVALENT_PERIOD")).toBe(
      "الفترة السابقة المماثلة في المدة"
    );
  });

  it("returns 'غير محدد' for undefined", () => {
    expect(getComparisonModeLabelShort(undefined)).toBe("وضع المقارنة غير محدد");
  });

  it("returns 'غير محدد' for null", () => {
    expect(getComparisonModeLabelShort(null)).toBe("وضع المقارنة غير محدد");
  });

  it("does not classify undefined as PREVIOUS_EQUIVALENT_PERIOD", () => {
    const label = getComparisonModeLabelShort(undefined);
    expect(label).not.toContain("الفترة السابقة المماثلة في المدة");
    expect(label).not.toContain("الفترة المماثلة من السنة السابقة");
  });
});

describe("getComparisonModeLabelForTable", () => {
  it("returns 'لا توجد فترة مقارنة' when no previous period", () => {
    expect(getComparisonModeLabelForTable("SAME_PERIOD_LAST_YEAR", false)).toBe(
      "لا توجد فترة مقارنة"
    );
  });

  it("returns 'لا توجد فترة مقارنة' when mode is undefined and no previous period", () => {
    expect(getComparisonModeLabelForTable(undefined, false)).toBe("لا توجد فترة مقارنة");
  });

  it("returns SAME_PERIOD_LAST_YEAR label when previous period exists", () => {
    expect(getComparisonModeLabelForTable("SAME_PERIOD_LAST_YEAR", true)).toBe(
      "الفترة المماثلة من السنة السابقة"
    );
  });

  it("returns PREVIOUS_EQUIVALENT_PERIOD label when previous period exists", () => {
    expect(getComparisonModeLabelForTable("PREVIOUS_EQUIVALENT_PERIOD", true)).toBe(
      "الفترة السابقة المماثلة في المدة"
    );
  });

  it("returns 'غير محدد' for undefined mode with previous period", () => {
    const label = getComparisonModeLabelForTable(undefined, true);
    expect(label).toBe("وضع المقارنة غير محدد");
    expect(label).not.toBe("الفترة السابقة المماثلة في المدة");
  });
});

describe("getComparisonModeDescription", () => {
  it("returns 'لا تتوفر فترة' when previousPeriod is undefined", () => {
    expect(getComparisonModeDescription("SAME_PERIOD_LAST_YEAR", undefined)).toBe(
      "لا تتوفر فترة زمنية للمقارنة"
    );
  });

  it("returns 'لا تتوفر فترة' when previousPeriod is null", () => {
    expect(getComparisonModeDescription("PREVIOUS_EQUIVALENT_PERIOD", null)).toBe(
      "لا تتوفر فترة زمنية للمقارنة"
    );
  });

  it("builds full description for SAME_PERIOD_LAST_YEAR", () => {
    expect(getComparisonModeDescription("SAME_PERIOD_LAST_YEAR", PREV)).toBe(
      "مقارنة مع الفترة المماثلة من السنة السابقة: 2024-01-01 إلى 2024-12-31"
    );
  });

  it("builds full description for PREVIOUS_EQUIVALENT_PERIOD", () => {
    expect(getComparisonModeDescription("PREVIOUS_EQUIVALENT_PERIOD", PREV)).toBe(
      "مقارنة مع الفترة السابقة المماثلة في المدة: 2024-01-01 إلى 2024-12-31"
    );
  });

  it("does not classify undefined mode as a known mode", () => {
    const description = getComparisonModeDescription(undefined, PREV);
    expect(description).not.toContain("الفترة السابقة المماثلة في المدة");
    expect(description).not.toContain("الفترة المماثلة من السنة السابقة");
    expect(description).toContain("غير محدد");
  });
});
