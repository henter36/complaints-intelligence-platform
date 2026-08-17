import { describe, expect, it } from "vitest";
import { enumerateConsecutivePeriods } from "./period-range";

describe("enumerateConsecutivePeriods", () => {
  it("builds N consecutive equal-duration periods ending at the current one, oldest first", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const toExclusive = new Date("2026-04-01T00:00:00.000Z");
    const periods = enumerateConsecutivePeriods(from, toExclusive, 4);

    expect(periods).toHaveLength(4);
    expect(periods[periods.length - 1]).toEqual({ from, toExclusive });

    for (let i = 1; i < periods.length; i++) {
      expect(periods[i - 1].toExclusive.getTime()).toBe(periods[i].from.getTime());
      expect(periods[i].toExclusive.getTime() - periods[i].from.getTime()).toBe(
        periods[i - 1].toExclusive.getTime() - periods[i - 1].from.getTime()
      );
    }
  });

  it("returns an empty array for a non-positive count", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const toExclusive = new Date("2026-04-01T00:00:00.000Z");
    expect(enumerateConsecutivePeriods(from, toExclusive, 0)).toEqual([]);
  });
});
