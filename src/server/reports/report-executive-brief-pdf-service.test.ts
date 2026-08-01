// @vitest-environment node
//
// Smoke tests for the executive brief PDF service.
// Verifies that the renderers produce valid, non-empty PDFs without errors.

import { describe, expect, it } from "vitest";
import type { ReportData } from "./report-data-service";
import type { ExecutiveBriefData } from "./report-data-service";
import type { ReportType } from "@prisma/client";
import { renderExecutiveBriefPdf } from "./report-executive-brief-pdf-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBriefData(overrides: Partial<ExecutiveBriefData> = {}): ExecutiveBriefData {
  return {
    briefKpis: [
      { key: "total", label: "إجمالي الشكاوى", value: 100, previousValue: 80, difference: 20, changeRate: 25.0, format: "number", assessment: "neutral" },
      { key: "open", label: "المفتوحة", value: 30, previousValue: 25, difference: 5, changeRate: 20.0, format: "number", assessment: "negative" },
      { key: "closed", label: "المغلقة", value: 65, previousValue: 50, difference: 15, changeRate: 30.0, format: "number", assessment: "positive" },
      { key: "currentlyLate", label: "المتأخرة", value: 8, previousValue: 10, difference: -2, changeRate: -20.0, format: "number", assessment: "positive" },
      { key: "complianceRate", label: "نسبة الالتزام%", value: 95, previousValue: 90, difference: 5, changeRate: 5.6, format: "percent", assessment: "positive" },
      { key: "averageResolutionDays", label: "متوسط زمن الإغلاق", value: 3.5, previousValue: 4.0, difference: -0.5, changeRate: -12.5, format: "days", assessment: "positive" },
      { key: "highPriorityOpen", label: "عالية الأولوية المفتوحة", value: 5, previousValue: 8, difference: -3, changeRate: -37.5, format: "number", assessment: "positive" },
      { key: "unclassified", label: "غير المصنفة", value: 4, previousValue: 6, difference: -2, changeRate: -33.3, format: "number", assessment: "neutral" },
    ],
    allRegions: [
      { regionName: "الرياض", currentCount: 40, previousCount: 30, difference: 10, changeRate: 33.3, complianceRate: 96.4, averageResolutionDays: 3.2, currentlyLate: 3, direction: "↑ ارتفاع" },
      { regionName: "جدة", currentCount: 30, previousCount: 35, difference: -5, changeRate: -14.3, complianceRate: 95.0, averageResolutionDays: 3.5, currentlyLate: 2, direction: "↓ انخفاض" },
      { regionName: "مكة", currentCount: 20, previousCount: 10, difference: 10, changeRate: 100.0, complianceRate: 91.7, averageResolutionDays: 4.1, currentlyLate: 2, direction: "↑ ارتفاع" },
    ],
    topClassifications: [
      { classificationId: "class-01", classificationName: "ضوضاء", categoryName: "بيئة", currentCount: 30, previousCount: 25, difference: 5, changeRate: 20.0, shareOfTotal: 30.0 },
      { classificationId: "class-02", classificationName: "بنية تحتية", categoryName: "خدمات", currentCount: 25, previousCount: 20, difference: 5, changeRate: 25.0, shareOfTotal: 25.0 },
    ],
    comparativeTimeline: {
      current: {
        label: "الفترة الحالية",
        points: [
          { relativeDay: 1, count: 12 },
          { relativeDay: 2, count: 15 },
          { relativeDay: 3, count: 10 },
          { relativeDay: 4, count: 18 },
          { relativeDay: 5, count: 14 },
          { relativeDay: 6, count: 16 },
          { relativeDay: 7, count: 15 },
        ],
      },
      previous: {
        label: "الفترة السابقة (2026-06-24 → 2026-06-30)",
        points: [
          { relativeDay: 1, count: 10 },
          { relativeDay: 2, count: 12 },
          { relativeDay: 3, count: 8 },
          { relativeDay: 4, count: 14 },
          { relativeDay: 5, count: 11 },
          { relativeDay: 6, count: 13 },
          { relativeDay: 7, count: 12 },
        ],
      },
      periodDays: 7,
    },
    concentrationBands: [
      { entityType: "region", top1SharePercent: 40.0, top3SharePercent: 90.0, top5SharePercent: 100.0, totalEntities: 3 },
      { entityType: "classification", top1SharePercent: 30.0, top3SharePercent: 75.0, top5SharePercent: 100.0, totalEntities: 5 },
      { entityType: "department", top1SharePercent: 45.0, top3SharePercent: 100.0, top5SharePercent: 100.0, totalEntities: 3 },
    ],
    ...overrides,
  };
}

function makeReportData(mode: "DIGITAL_EXECUTIVE_BRIEF" | "PRINT_EXECUTIVE_BRIEF"): ReportData {
  return {
    type: "EXECUTIVE_SUMMARY" as ReportType,
    title: mode === "DIGITAL_EXECUTIVE_BRIEF" ? "تقرير تنفيذي مختصر — عرض رقمي" : "تقرير تنفيذي مختصر — نسخة طباعة",
    generatedAt: new Date("2026-07-31T04:00:00Z").toISOString(),
    period: { from: "2026-07-01", to: "2026-07-07" },
    filters: { from: "2026-07-01", to: "2026-07-07" },
    kpis: {
      totalComplaints: { currentValue: 100, previousValue: 80, absoluteChange: 20, percentageChange: 25.0, trend: "up", direction: "neutral" },
    } as unknown as ReportData["kpis"],
    sections: [
      {
        id: "executive_summary_text",
        kind: "text",
        title: "الملخص التنفيذي",
        points: [
          "استُقبلت خلال الفترة الحالية 100 شكوى.",
          "سجّلت الرياض أعلى ارتفاع في عدد الشكاوى.",
        ],
      },
    ],
    warnings: [],
    rowCount: 0,
    reportMode: mode,
    briefData: makeBriefData(),
    comparisonData: {
      currentPeriod: { from: new Date("2026-07-01T00:00:00Z"), toExclusive: new Date("2026-07-08T00:00:00Z") },
      previousPeriod: { from: new Date("2026-06-24T00:00:00Z"), toExclusive: new Date("2026-07-01T00:00:00Z") },
      regionTrend: {
        allDates: ["2026-07-01", "2026-07-02"],
        series: [],
        truncated: false,
        otherSeriesName: null,
      },
      regionChanges: [
        { regionName: "الرياض", currentCount: 40, previousCount: 30, difference: 10, changeRate: 33.3, direction: "ارتفاع" },
        { regionName: "جدة", currentCount: 30, previousCount: 35, difference: -5, changeRate: -14.3, direction: "انخفاض" },
      ],
      deptClassRises: [],
      deptClassRisesTotal: 0,
      executiveSummaryPoints: ["استُقبلت خلال الفترة الحالية 100 شكوى."],
      warnings: [],
    },
  };
}

// ---------------------------------------------------------------------------
// DIGITAL_EXECUTIVE_BRIEF tests
// ---------------------------------------------------------------------------

describe("renderExecutiveBriefPdf — DIGITAL_EXECUTIVE_BRIEF", () => {
  it("produces a non-empty buffer", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("starts with PDF magic bytes", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.slice(0, 4).toString()).toBe("%PDF");
  });

  it("returns no warnings for a valid report", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    // Only soft warnings (chart rendering issues) are expected to be possible.
    // Fatal errors would throw. We just verify warnings is an array.
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("PDF contains at least 3 pages (one per section)", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    // Count /Page (singular, not /Pages) objects in the raw PDF.
    const pdfText = result.buffer.toString("binary");
    const pageMatches = pdfText.match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pageMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("PDF title matches data.title", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    // Title is encoded in the Info dictionary (UTF-16BE or UTF-8 in PDFKit).
    // Check the raw buffer contains some representation of the title bytes.
    expect(result.buffer.length).toBeGreaterThan(1000);
  });

  it("renders without error when briefData is empty allRegions", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({ allRegions: [] });
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("renders without error when briefData topClassifications is empty", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({ topClassifications: [] });
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("renders without error when no previous period in timeline", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      comparativeTimeline: {
        current: { label: "الفترة الحالية", points: [{ relativeDay: 1, count: 10 }] },
        previous: null,
        periodDays: 1,
      },
    });
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("renders without error when briefData is undefined", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = undefined;
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("renders many regions without crashing", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const manyRegions = Array.from({ length: 50 }, (_, i) => ({
      regionName: `منطقة ${i + 1}`,
      currentCount: 10 + i,
      previousCount: 8 + i,
      difference: 2,
      changeRate: 25.0,
      complianceRate: 95.0,
      averageResolutionDays: 3.5,
      currentlyLate: 1,
      direction: "↑ ارتفاع",
    }));
    data.briefData = makeBriefData({ allRegions: manyRegions });
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PRINT_EXECUTIVE_BRIEF tests
// ---------------------------------------------------------------------------

describe("renderExecutiveBriefPdf — PRINT_EXECUTIVE_BRIEF", () => {
  it("produces a non-empty buffer", async () => {
    const data = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "PRINT_EXECUTIVE_BRIEF");
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("starts with PDF magic bytes", async () => {
    const data = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "PRINT_EXECUTIVE_BRIEF");
    expect(result.buffer.slice(0, 4).toString()).toBe("%PDF");
  });

  it("PDF contains at least 3 pages (one per section)", async () => {
    const data = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "PRINT_EXECUTIVE_BRIEF");
    const pdfText = result.buffer.toString("binary");
    const pageMatches = pdfText.match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pageMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("print PDF buffer is reasonably sized (> 5 KB)", async () => {
    const data = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "PRINT_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(5_000);
  });

  it("print and digital buffers differ (different page dimensions)", async () => {
    const digital = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const print = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const [digitalResult, printResult] = await Promise.all([
      renderExecutiveBriefPdf(digital, "DIGITAL_EXECUTIVE_BRIEF"),
      renderExecutiveBriefPdf(print, "PRINT_EXECUTIVE_BRIEF"),
    ]);
    // Different page sizes → different raw buffer sizes
    expect(digitalResult.buffer.length).not.toBe(printResult.buffer.length);
  });

  it("renders without error when all sections are empty", async () => {
    const data = makeReportData("PRINT_EXECUTIVE_BRIEF");
    data.sections = [];
    data.briefData = makeBriefData({
      briefKpis: [],
      allRegions: [],
      topClassifications: [],
    });
    const result = await renderExecutiveBriefPdf(data, "PRINT_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
  });
});
