import { describe, expect, it } from "vitest";
import { defaultPeriodRange, formatLocalDate } from "./import-center";

describe("import center date ranges", () => {
  it("formats local calendar dates without UTC conversion", () => {
    expect(formatLocalDate(new Date(2026, 0, 1, 0, 30))).toBe("2026-01-01");
  });

  it("keeps daily range on the selected local day", () => {
    expect(defaultPeriodRange("daily", new Date(2026, 2, 15))).toEqual({
      start: "2026-03-15",
      end: "2026-03-15",
    });
  });

  it("uses today plus the previous six days for weekly ranges", () => {
    expect(defaultPeriodRange("weekly", new Date(2026, 0, 1))).toEqual({
      start: "2025-12-26",
      end: "2026-01-01",
    });
  });

  it.each([
    [new Date(2026, 2, 31), "2026-03-01", "2026-03-31"],
    [new Date(2026, 2, 30), "2026-03-01", "2026-03-30"],
    [new Date(2024, 2, 29), "2024-03-01", "2024-03-29"],
    [new Date(2023, 2, 29), "2023-03-01", "2023-03-29"],
    [new Date(2026, 0, 1), "2025-12-02", "2026-01-01"],
  ])("computes monthly ranges without month overflow for %s", (today, start, end) => {
    const range = defaultPeriodRange("monthly", today);

    expect(range).toEqual({ start, end });
    expect(range.start <= range.end).toBe(true);
  });
});
