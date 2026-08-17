import { describe, expect, it } from "vitest";
import type { MonthlyComplaintTrendPoint } from "@/lib/reports/report-contract";
import {
  buildMonthlyTrendInsights,
  calculateMonthlyTrendTotals,
  resolveReportMonthStatus,
} from "./report-monthly-trend-presentation";

function point(
  monthKey: string,
  receivedCount: number,
  closedDuringMonthCount: number,
  monthLabel = monthKey
): MonthlyComplaintTrendPoint {
  return {
    monthKey,
    monthLabel,
    receivedCount,
    closedDuringMonthCount,
    openAtMonthEndCount: 0,
    lateAtMonthEndCount: 0,
  };
}

describe("calculateMonthlyTrendTotals", () => {
  it("sums registered and closed counts", () => {
    const points = [
      point("2026-01", 10, 7, "يناير 2026"),
      point("2026-02", 5, 8, "فبراير 2026"),
    ];
    expect(calculateMonthlyTrendTotals(points)).toEqual({
      registeredTotal: 15,
      closedTotal: 15,
    });
  });

  it("handles zero months", () => {
    expect(
      calculateMonthlyTrendTotals([
        point("2026-01", 0, 0),
        point("2026-02", 0, 0),
      ])
    ).toEqual({ registeredTotal: 0, closedTotal: 0 });
  });

  it("allows closedTotal greater than registeredTotal", () => {
    expect(
      calculateMonthlyTrendTotals([
        point("2026-01", 3, 10),
        point("2026-02", 2, 5),
      ])
    ).toEqual({ registeredTotal: 5, closedTotal: 15 });
  });

  it("does not mutate inputs", () => {
    const points = [point("2026-01", 4, 2)];
    const frozen = Object.freeze({ ...points[0]! });
    const list = Object.freeze([frozen]);
    expect(() => calculateMonthlyTrendTotals(list)).not.toThrow();
    expect(list[0]).toEqual(frozen);
  });
});

describe("buildMonthlyTrendInsights", () => {
  it("leads with the multi-period trend direction (spec §11), reusing classifyTrend — never the registered/closed flow gap", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 20, 18, "يناير 2026"),
        point("2026-02", 25, 20, "فبراير 2026"),
        point("2026-03", 30, 22, "مارس 2026"),
        point("2026-04", 35, 24, "أبريل 2026"),
      ],
      reportEndDate: "2026-04-30",
    });
    expect(insights[0]?.key).toBe("trend-direction");
    expect(insights[0]?.text).toContain("اتجاه الشكاوى المسجلة");
    expect(insights.some((item) => item.key === "flow-proximity")).toBe(false);
    expect(insights.some((item) => item.key === "largest-gap")).toBe(false);
  });

  it("describes a continued decline across several months", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 40, 10, "يناير 2026"),
        point("2026-02", 30, 10, "فبراير 2026"),
        point("2026-03", 20, 10, "مارس 2026"),
        point("2026-04", 12, 10, "أبريل 2026"),
      ],
      reportEndDate: "2026-04-30",
    });
    const trend = insights.find((item) => item.key === "trend-direction");
    expect(trend?.text).toContain("تحسن مستمر");
  });

  it("omits the trend-direction insight when there are fewer than three complete months (insufficient data)", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 10, 9, "يناير 2026"),
        point("2026-02", 25, 20, "فبراير 2026"),
      ],
      reportEndDate: "2026-02-28",
    });
    expect(insights.some((item) => item.key === "trend-direction")).toBe(false);
  });

  it("excludes the partial report-end month from the trend classification", () => {
    // Only "مارس" is partial; the classifier still needs >=3 COMPLETE months,
    // so with just جانفي/فبراير complete this must omit trend-direction rather
    // than classify on an incomplete window.
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 10, 10, "يناير 2026"),
        point("2026-02", 10, 10, "فبراير 2026"),
        point("2026-03", 100, 1, "مارس 2026"),
      ],
      reportEndDate: "2026-03-05",
    });
    expect(insights.some((item) => item.key === "trend-direction")).toBe(false);
  });

  it("picks the highest registration month", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 10, 9, "يناير 2026"),
        point("2026-02", 25, 20, "فبراير 2026"),
        point("2026-03", 12, 11, "مارس 2026"),
      ],
      reportEndDate: "2026-03-31",
    });
    expect(insights.find((item) => item.key === "peak-registration")).toEqual({
      key: "peak-registration",
      text: "أعلى حجم تسجيل كان في فبراير 2026 بعدد 25 شكوى.",
    });
  });

  it("breaks registration ties by choosing the newest month", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 20, 18, "يناير 2026"),
        point("2026-02", 20, 19, "فبراير 2026"),
      ],
      reportEndDate: "2026-02-28",
    });
    expect(insights.find((item) => item.key === "peak-registration")?.text).toContain("فبراير 2026");
  });

  it("describes a complete report-end month", () => {
    const insights = buildMonthlyTrendInsights({
      points: [point("2026-08", 10, 9, "أغسطس 2026")],
      reportEndDate: "2026-08-31",
    });
    expect(insights.at(-1)).toEqual({
      key: "complete-month",
      text: "تنتهي البيانات بنهاية شهر أغسطس 2026.",
    });
  });

  it("describes a partial report-end month", () => {
    const insights = buildMonthlyTrendInsights({
      points: [point("2026-08", 10, 9, "أغسطس 2026")],
      reportEndDate: "2026-08-05",
    });
    expect(insights.at(-1)).toEqual({
      key: "partial-month",
      text: "أغسطس 2026 يمثل شهرًا جزئيًا حتى يوم 5.",
    });
  });

  it("returns no insights when points are unavailable and end date is invalid", () => {
    expect(
      buildMonthlyTrendInsights({
        points: [],
        reportEndDate: "not-a-date",
      })
    ).toEqual([]);
  });

  it("omits peak-registration when every month has zero registrations", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 0, 5, "يناير 2026"),
        point("2026-02", 0, 0, "فبراير 2026"),
        point("2026-03", 0, 8, "مارس 2026"),
      ],
      reportEndDate: "2026-03-31",
    });
    expect(insights.some((item) => item.key === "peak-registration")).toBe(false);
    expect(insights.some((item) => item.key === "complete-month")).toBe(true);
  });

  it("picks the positive peak when mixed with zero months", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 0, 2, "يناير 2026"),
        point("2026-02", 12, 10, "فبراير 2026"),
        point("2026-03", 0, 1, "مارس 2026"),
      ],
      reportEndDate: "2026-03-31",
    });
    expect(insights.find((item) => item.key === "peak-registration")).toEqual({
      key: "peak-registration",
      text: "أعلى حجم تسجيل كان في فبراير 2026 بعدد 12 شكوى.",
    });
  });

  it("caps at three insights total", () => {
    const insights = buildMonthlyTrendInsights({
      points: [
        point("2026-01", 20, 18, "يناير 2026"),
        point("2026-02", 25, 20, "فبراير 2026"),
        point("2026-03", 30, 22, "مارس 2026"),
        point("2026-04", 35, 24, "أبريل 2026"),
      ],
      reportEndDate: "2026-04-05",
    });
    expect(insights.length).toBeLessThanOrEqual(3);
  });
});

describe("resolveReportMonthStatus", () => {
  it("marks a complete month", () => {
    expect(resolveReportMonthStatus("2026-08-31")).toEqual({
      isPartial: false,
      dayOfMonth: 31,
      monthLabel: "أغسطس 2026",
    });
  });

  it("marks a partial month", () => {
    expect(resolveReportMonthStatus("2026-08-05")).toEqual({
      isPartial: true,
      dayOfMonth: 5,
      monthLabel: "أغسطس 2026",
    });
  });

  it("handles February in a leap year", () => {
    expect(resolveReportMonthStatus("2024-02-29")).toEqual({
      isPartial: false,
      dayOfMonth: 29,
      monthLabel: "فبراير 2024",
    });
    expect(resolveReportMonthStatus("2024-02-15")).toEqual({
      isPartial: true,
      dayOfMonth: 15,
      monthLabel: "فبراير 2024",
    });
  });

  it("returns null for an invalid date", () => {
    expect(resolveReportMonthStatus("2026-02-30")).toBeNull();
    expect(resolveReportMonthStatus("")).toBeNull();
    expect(resolveReportMonthStatus("abc")).toBeNull();
  });
});
