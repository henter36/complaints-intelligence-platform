// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertTrendEndsAtOrBeforeReportEnd,
  monthKeyFromReportEndDate,
  sanitizeMonthlyTrendForReport,
} from "./report-monthly-trend-sanitize";
import type { MonthlyComplaintTrendPoint } from "@/lib/reports/report-contract";

function point(monthKey: string, monthLabel = monthKey): MonthlyComplaintTrendPoint {
  return {
    monthKey,
    monthLabel,
    receivedCount: 1,
    closedDuringMonthCount: 1,
    openAtMonthEndCount: 1,
    lateAtMonthEndCount: 0,
  };
}

describe("sanitizeMonthlyTrendForReport", () => {
  it("drops monthKey after report end and keeps last 13", () => {
    const points = [
      point("2025-08"),
      point("2025-09"),
      point("2026-07"),
      point("2026-08"),
      point("2026-09"), // future relative to 2026-08-04
      point("bad-key"),
    ];
    const sanitized = sanitizeMonthlyTrendForReport(points, "2026-08-04", 13);
    expect(sanitized.map((p) => p.monthKey)).toEqual([
      "2025-08",
      "2025-09",
      "2026-07",
      "2026-08",
    ]);
  });

  it("dedupes by monthKey and sorts ascending", () => {
    const points = [
      point("2026-08", "aug-first"),
      point("2026-07"),
      { ...point("2026-08", "aug-last"), receivedCount: 9 },
    ];
    const sanitized = sanitizeMonthlyTrendForReport(points, "2026-08-04", 13);
    expect(sanitized.map((p) => p.monthKey)).toEqual(["2026-07", "2026-08"]);
    expect(sanitized[1].receivedCount).toBe(9);
    expect(sanitized[1].monthLabel).toBe("aug-last");
  });

  it("does not invent new points", () => {
    const sanitized = sanitizeMonthlyTrendForReport([point("2026-08")], "2026-08-04", 13);
    expect(sanitized).toHaveLength(1);
  });

  it("returns empty for invalid report end date", () => {
    expect(sanitizeMonthlyTrendForReport([point("2026-08")], "not-a-date")).toEqual([]);
  });

  it("trims to last maxMonths without creating pads", () => {
    // ensure valid chain ending at 2026-03
    const keyed = [
      point("2025-01"),
      point("2025-02"),
      point("2025-03"),
      point("2025-04"),
      point("2025-05"),
      point("2025-06"),
      point("2025-07"),
      point("2025-08"),
      point("2025-09"),
      point("2025-10"),
      point("2025-11"),
      point("2025-12"),
      point("2026-01"),
      point("2026-02"),
      point("2026-03"),
    ];
    const sanitized = sanitizeMonthlyTrendForReport(keyed, "2026-03-15", 13);
    expect(sanitized).toHaveLength(13);
    expect(sanitized[0].monthKey).toBe("2025-03");
    expect(sanitized.at(-1)?.monthKey).toBe("2026-03");
  });
});

describe("assertTrendEndsAtOrBeforeReportEnd", () => {
  it("passes when fixture ends on report end month", () => {
    expect(() =>
      assertTrendEndsAtOrBeforeReportEnd(
        [point("2025-08"), point("2026-08")],
        "2026-08-04"
      )
    ).not.toThrow();
  });

  it("fails when fixture includes a future month", () => {
    expect(() =>
      assertTrendEndsAtOrBeforeReportEnd(
        [point("2026-08"), point("2026-09")],
        "2026-08-04"
      )
    ).toThrow(/2026-09/);
  });
});

describe("monthKeyFromReportEndDate", () => {
  it("parses calendar end date", () => {
    expect(monthKeyFromReportEndDate("2026-08-04")).toBe("2026-08");
    expect(monthKeyFromReportEndDate("2026-08-04T12:00:00.000Z")).toBe("2026-08");
  });
});
