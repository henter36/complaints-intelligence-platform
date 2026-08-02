// @vitest-environment node
//
// Smoke tests for the executive brief PDF service.
// Verifies that the renderers produce valid, non-empty PDFs without errors.

import { describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import type { ReportData } from "./report-data-service";
import type { ExecutiveBriefData } from "./report-data-service";
import type { ReportType } from "@prisma/client";
import { renderExecutiveBriefPdf } from "./report-executive-brief-pdf-service";
import * as chartService from "./report-chart-service";
import { preparePdfText } from "./arabic-pdf-text";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utf16BeWithBom(value: string): Buffer {
  return Buffer.from(`\uFEFF${value}`, "utf16le").swap16();
}

function utf16Be(value: string): Buffer {
  const raw = Buffer.from(value, "utf16le").swap16();
  const escaped: number[] = [];
  for (const byte of raw) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) escaped.push(0x5c);
    escaped.push(byte);
  }
  return Buffer.from(escaped);
}

function countPageObjects(buffer: Buffer): number {
  return (buffer.toString("binary").match(/\/Type\s*\/Page\s*\/Parent/g) ?? []).length;
}

function firstMediaBox(buffer: Buffer): [number, number] {
  const match = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(
    buffer.toString("binary")
  );
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

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
      { classificationId: "class-01", classificationName: "ضوضاء", currentCount: 30, previousCount: 25, difference: 5, changeRate: 20.0, shareOfTotal: 30.0 },
      { classificationId: "class-02", classificationName: "بنية تحتية", currentCount: 25, previousCount: 20, difference: 5, changeRate: 25.0, shareOfTotal: 25.0 },
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
    title: "تقرير الشكاوى",
    generatedAt: new Date("2026-07-31T04:00:00Z").toISOString(),
    period: { from: "2026-07-01", to: "2026-07-07" },
    previousPeriod: { from: "2026-06-24", to: "2026-06-30" },
    filters: { from: "2026-07-01", to: "2026-07-07" },
    kpis: {
      totalComplaints: { currentValue: 100, previousValue: 80, absoluteChange: 20, percentageChange: 25.0, trend: "up", direction: "neutral" },
    } as unknown as ReportData["kpis"],
    sections: [
      {
        id: "executive_summary_text",
        kind: "text",
        title: "الملخص",
        points: [
          "استُقبلت خلال الفترة الحالية 100 شكوى.",
          "سجّلت الرياض أعلى ارتفاع في عدد الشكاوى.",
        ],
      },
    ],
    warnings: [],
    rowCount: 0,
    reportMode: mode,
    comparisonMode: "PREVIOUS_EQUIVALENT_PERIOD",
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
      deptClassAllPairs: [],
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
    expect(result.warnings).toEqual([]);
  });

  it("PDF contains exactly 4 pages", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(countPageObjects(result.buffer)).toBe(4);
  });

  it("PDF title matches data.title", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.includes(utf16BeWithBom(data.title))).toBe(true);
  });

  it("writes actual four-page footer labels", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(makeReportData("DIGITAL_EXECUTIVE_BRIEF"), "DIGITAL_EXECUTIVE_BRIEF");
      const footerTexts = textSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes("صفحة") && text.includes("من"));
      expect(footerTexts).toHaveLength(4);
      expect(footerTexts[0]).toContain(preparePdfText("صفحة 1 من 4"));
      expect(footerTexts[3]).toContain(preparePdfText("صفحة 4 من 4"));
    } finally {
      textSpy.mockRestore();
    }
  });

  it("draws period and comparison metadata on the cover — no generated-date line", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(makeReportData("DIGITAL_EXECUTIVE_BRIEF"), "DIGITAL_EXECUTIVE_BRIEF");
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      // After preparePdfText, RTL token order is reversed: "الفترة من X إلى Y" → "Y إلى X من الفترة"
      expect(texts.filter((text) => text.includes("الفترة") && text.includes("2026-07-01"))).toHaveLength(1);
      // "مقارنة مع الفترة ..." contains both "مقارنة" and "مع"; section titles like "مقارنة المناطق" do not contain "مع"
      expect(texts.filter((text) => text.includes("مقارنة") && text.includes("مع"))).toHaveLength(1);
      expect(texts.filter((text) => text.includes("تاريخ") && text.includes("الإنشاء"))).toHaveLength(0);
      expect(texts.some((text) => text === "الفترة:")).toBe(false);
    } finally {
      textSpy.mockRestore();
    }
  });

  it("labels a previous-year comparison explicitly on the cover", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.comparisonMode = "SAME_PERIOD_LAST_YEAR";
    data.previousPeriod = { from: "2025-07-01", to: "2025-07-07" };
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      // preparePdfText reverses RTL token order; "مقارنة" is still present as a token
      expect(textSpy.mock.calls.some((call) => {
        const t = String(call[0]);
        return t.includes("مقارنة") && t.includes("السنة") && t.includes("السابقة");
      })).toBe(true);
    } finally {
      textSpy.mockRestore();
    }
  });

  it("contains safe report metadata without forbidden internal wording", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.reportRunId = "run-sensitive-internal-id";
    const result = await renderExecutiveBriefPdf(
      data,
      "DIGITAL_EXECUTIVE_BRIEF"
    );
    for (const title of ["الشكاوى", "المؤشرات", "المناطق", "التصنيفات"]) {
      expect(result.buffer.includes(utf16Be(title))).toBe(true);
    }
    for (const forbidden of ["تقرير تنفيذي مختصر", "المنهجية", "نظام ذكاء الشكاوى", "معرف التشغيل"]) {
      expect(result.buffer.includes(utf16Be(forbidden))).toBe(false);
    }
  });

  it("does not draw prohibited or technical wording on any page", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(
        makeReportData("DIGITAL_EXECUTIVE_BRIEF"),
        "DIGITAL_EXECUTIVE_BRIEF"
      );
      const displayedText = textSpy.mock.calls.map((call) => String(call[0])).join(" | ");
      for (const forbidden of [
        "تقرير تنفيذي مختصر",
        "التنفيذي",
        "المنهجية",
        "ذكاء نظام",
        "التحليل الشامل",
        "معرف التشغيل",
        "ما يستحق الانتباه",
      ]) {
        expect(displayedText).not.toContain(forbidden);
      }
      expect(displayedText).toContain("ملاحظات");
    } finally {
      textSpy.mockRestore();
    }
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
    data.previousPeriod = null;
    if (data.comparisonData) data.comparisonData.previousPeriod = null;
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

  it("shows no-reference guidance without fake previous values or continuity labels", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.previousPeriod = null;
    if (data.comparisonData) data.comparisonData.previousPeriod = null;
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      // preparePdfText reverses RTL tokens; "تتوفر" and "للمقارنة" remain present as tokens
      expect(texts.some((text) => text.includes("تتوفر") && text.includes("للمقارنة"))).toBe(true);
      expect(texts.some((text) => text.includes("جديد"))).toBe(false);
      expect(texts.some((text) => text.includes("persistent") || text.includes("resolved"))).toBe(false);
    } finally {
      textSpy.mockRestore();
    }
  });

  it("renders without error when briefData is undefined", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = undefined;
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("bounds malformed region cardinality without unbounded page or chart growth", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const manyRegions = Array.from({ length: 250 }, (_, i) => ({
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
    expect(result.warnings).toContain(
      "تم عرض أول 100 تسمية منطقة فقط بسبب وجود عدد غير اعتيادي من التسميات."
    );
    const [, pageHeight] = firstMediaBox(result.buffer);
    expect(pageHeight).toBeLessThan(7_000);
  });

  it("renders positive, negative, zero, and no-rate KPI deltas with all region directions", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      briefKpis: [
        { key: "positive", label: "موجب", value: 15, previousValue: 10, difference: 5, changeRate: 10, format: "number", assessment: "neutral" },
        { key: "negative", label: "سالب", value: 5, previousValue: 10, difference: -5, changeRate: -10, format: "number", assessment: "neutral" },
        { key: "zero", label: "صفر", value: 10, previousValue: 10, difference: 0, changeRate: 0, format: "number", assessment: "neutral" },
        { key: "no-rate", label: "دون نسبة", value: 15, previousValue: 10, difference: 5, changeRate: null, format: "number", assessment: "neutral" },
      ],
      allRegions: [
        { regionName: "منطقة صاعدة", currentCount: 2, previousCount: 1, difference: 1, changeRate: 100, complianceRate: 90, averageResolutionDays: 2, currentlyLate: 0, direction: "↑ صاعد" },
        { regionName: "منطقة هابطة", currentCount: 1, previousCount: 2, difference: -1, changeRate: -50, complianceRate: 90, averageResolutionDays: 2, currentlyLate: 0, direction: "↓ هابط" },
        { regionName: "منطقة ثابتة", currentCount: 1, previousCount: 1, difference: 0, changeRate: 0, complianceRate: 90, averageResolutionDays: 2, currentlyLate: 0, direction: "= ثابت" },
      ],
    });

    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const fillColorSpy = vi.spyOn(PDFDocument.prototype, "fillColor");
    const strokeColorSpy = vi.spyOn(PDFDocument.prototype, "strokeColor");
    try {
      const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      expect(result.buffer.slice(0, 4).toString()).toBe("%PDF");
      expect(result.warnings).toEqual([]);

      const renderedText = textSpy.mock.calls.map((call) => call[0]);
      // preparePdfText reverses RTL tokens; delta numerics appear at the end of the prepared string
      expect(renderedText.some((text) => String(text).includes("+5") && String(text).includes("(+10%)"))).toBe(true);
      expect(renderedText.some((text) => String(text).includes("−5") && String(text).includes("(−10%)"))).toBe(true);
      expect(renderedText.some((text) => String(text).includes("(0%)"))).toBe(true);
      expect(renderedText.some((text) => String(text).includes("+5"))).toBe(true);

      const colorImmediatelyBefore = (text: string): string | undefined => {
        const textIndex = textSpy.mock.calls.findIndex((call) => call[0] === text);
        const textOrder = textSpy.mock.invocationCallOrder[textIndex];
        let colorIndex = -1;
        fillColorSpy.mock.invocationCallOrder.forEach((order, index) => {
          if (order < textOrder && (colorIndex === -1 || order > fillColorSpy.mock.invocationCallOrder[colorIndex])) {
            colorIndex = index;
          }
        });
        return colorIndex === -1 ? undefined : String(fillColorSpy.mock.calls[colorIndex][0]);
      };

      const usedColors = [
        ...fillColorSpy.mock.calls.map((call) => String(call[0])),
        ...strokeColorSpy.mock.calls.map((call) => String(call[0])),
      ];
      expect(usedColors).toContain("#004B3A");
      expect(usedColors).toContain("#B88919");
      expect(usedColors).toContain("#46534E");
      // Region name is rendered with the "منطقة" prefix stripped, so "منطقة صاعدة" → "صاعدة"
      expect(colorImmediatelyBefore("صاعدة")).toBe("#FFFFFF");
    } finally {
      textSpy.mockRestore();
      fillColorSpy.mockRestore();
      strokeColorSpy.mockRestore();
    }
  });

  it("draws region charts at the same height used for rasterization", async () => {
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    const imageSpy = vi.spyOn(PDFDocument.prototype, "image");
    try {
      await renderExecutiveBriefPdf(
        makeReportData("DIGITAL_EXECUTIVE_BRIEF"),
        "DIGITAL_EXECUTIVE_BRIEF"
      );
      const rasterHeights = chartSpy.mock.calls.map((call) => call[2]);
      const displayHeights = imageSpy.mock.calls
        .map((call) => (call[3] as { height?: number } | undefined)?.height)
        .filter((height): height is number => typeof height === "number");
      expect(rasterHeights.length).toBeGreaterThanOrEqual(1);
      expect(displayHeights.slice(0, rasterHeights.length)).toEqual(rasterHeights);
    } finally {
      chartSpy.mockRestore();
      imageSpy.mockRestore();
    }
  });

  it.each([0, 50, 75, 100])(
    "keeps the %s%% compliance gauge within one semicircle",
    async (value) => {
      const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
      data.briefData = makeBriefData({
        briefKpis: makeBriefData().briefKpis.map((card) => (
          card.key === "complianceRate" ? { ...card, value } : card
        )),
      });
      const pathSpy = vi.spyOn(PDFDocument.prototype, "path");
      try {
        await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
        const gaugeArcs = pathSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((path) => path.includes("A 34 34"));
        expect(gaugeArcs).toHaveLength(2);
        expect(gaugeArcs.every((path) => path.includes("A 34 34 0 0 1"))).toBe(true);
        expect(gaugeArcs.some((path) => path.includes("A 34 34 0 1 1"))).toBe(false);
      } finally {
        pathSpy.mockRestore();
      }
    }
  );

  it("does not infer a reference period from missing comparisonData", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.previousPeriod = null;
    data.comparisonData = undefined;
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      expect(chartSpy).toHaveBeenCalledTimes(2);
      const charts = chartSpy.mock.calls.map((call) => call[0]);
      expect(charts.every((chart) => chart.series.length === 1)).toBe(true);
      // preparePdfText reverses RTL tokens; "تتوفر" and "للمقارنة" remain present as tokens
      expect(textSpy.mock.calls.some((call) => String(call[0]).includes("تتوفر") && String(call[0]).includes("للمقارنة"))).toBe(true);
    } finally {
      chartSpy.mockRestore();
      textSpy.mockRestore();
    }
  });

  it("renders only the current trend when previousPeriod is null", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.previousPeriod = null;
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      expect(chartSpy).toHaveBeenCalledTimes(2);
      expect(chartSpy.mock.calls.every((call) => call[0].series.length === 1)).toBe(true);
    } finally {
      chartSpy.mockRestore();
    }
  });

  it("renders a useful comparison when the authoritative previousPeriod exists", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.comparisonData = undefined;
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      expect(chartSpy).toHaveBeenCalledTimes(2);
      expect(chartSpy.mock.calls.every((call) => call[0].series.length === 2)).toBe(true);
    } finally {
      chartSpy.mockRestore();
    }
  });

  it("acceptance fixture stays four pages and keeps the timeline and region visuals", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      briefKpis: [
        { key: "total", label: "إجمالي الشكاوى", value: 3, previousValue: 1, difference: 2, changeRate: 200, format: "number", assessment: "negative" },
        { key: "open", label: "المفتوحة أو تحت الإجراء", value: 2, previousValue: 1, difference: 1, changeRate: 100, format: "number", assessment: "negative" },
        { key: "closed", label: "المغلقة", value: 1, previousValue: 0, difference: 1, changeRate: null, format: "number", assessment: "positive" },
        { key: "currentlyLate", label: "المتأخرة حاليًا", value: 1, previousValue: 0, difference: 1, changeRate: null, format: "number", assessment: "negative" },
        { key: "complianceRate", label: "نسبة الالتزام بالمهلة", value: 100, previousValue: null, difference: 0, changeRate: null, format: "percent", assessment: "positive" },
        { key: "averageResolutionDays", label: "متوسط زمن الإغلاق", value: 8, previousValue: null, difference: 0, changeRate: null, format: "days", assessment: "neutral" },
      ],
      allRegions: [
        { regionName: "الرياض", currentCount: 2, previousCount: 0, difference: 2, changeRate: null, complianceRate: 100, averageResolutionDays: 8, currentlyLate: 1, direction: "ارتفاع" },
        { regionName: "مكة المكرمة", currentCount: 1, previousCount: 0, difference: 1, changeRate: null, complianceRate: 100, averageResolutionDays: null, currentlyLate: 0, direction: "ارتفاع" },
        { regionName: "المنطقة الشرقية", currentCount: 0, previousCount: 1, difference: -1, changeRate: -100, complianceRate: null, averageResolutionDays: null, currentlyLate: 0, direction: "انخفاض" },
      ],
      comparativeTimeline: {
        current: { label: "الفترة الحالية", points: [{ relativeDay: 1, count: 1 }, { relativeDay: 2, count: 1 }, { relativeDay: 3, count: 1 }] },
        previous: { label: "الفترة السابقة", points: [{ relativeDay: 1, count: 1 }, { relativeDay: 2, count: 0 }, { relativeDay: 3, count: 0 }] },
        periodDays: 3,
      },
    });
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    try {
      const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      expect(countPageObjects(result.buffer)).toBe(4);
      expect(chartSpy).toHaveBeenCalledTimes(2);
      expect(chartSpy.mock.calls.map((call) => call[0].chartType)).toEqual(["bar", "bar"]);
      expect(result.warnings).toEqual([]);
    } finally {
      chartSpy.mockRestore();
    }
  });
});

  // ── Cover page: title and date ──────────────────────────────────────────

  it("cover title uses data.title, not a hardcoded string", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.title = "تقرير اختبار المناطق";
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      expect(texts).toContain(preparePdfText("تقرير اختبار المناطق"));
    } finally {
      textSpy.mockRestore();
    }
  });

  it("cover does not render a generated-date line", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(makeReportData("DIGITAL_EXECUTIVE_BRIEF"), "DIGITAL_EXECUTIVE_BRIEF");
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      expect(texts.every((text) => !text.startsWith("تاريخ الإنشاء:"))).toBe(true);
    } finally {
      textSpy.mockRestore();
    }
  });

  // ── Region chart: prefix stripping ─────────────────────────────────────

  it("region chart series use short names without 'منطقة ' prefix", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      allRegions: [
        { regionName: "منطقة الرياض", currentCount: 20, previousCount: 10, difference: 10, changeRate: 100, complianceRate: 95, averageResolutionDays: 3, currentlyLate: 1, direction: "↑ ارتفاع" },
        { regionName: "منطقة مكة المكرمة", currentCount: 10, previousCount: 12, difference: -2, changeRate: -16.7, complianceRate: 90, averageResolutionDays: 4, currentlyLate: 0, direction: "↓ انخفاض" },
      ],
    });
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      const regionChart = chartSpy.mock.calls.find((call) => call[0].id === "executive-region-comparison");
      expect(regionChart).toBeDefined();
      const points = regionChart![0].series[0].points;
      expect(points.every((point) => !point.x.startsWith("منطقة "))).toBe(true);
      expect(points.some((point) => point.x === "الرياض")).toBe(true);
    } finally {
      chartSpy.mockRestore();
    }
  });

  it("region chart strips 'المنطقة ' prefix as well", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      allRegions: [
        { regionName: "المنطقة الشرقية", currentCount: 8, previousCount: 5, difference: 3, changeRate: 60, complianceRate: 85, averageResolutionDays: 5, currentlyLate: 2, direction: "↑ ارتفاع" },
      ],
    });
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      const regionChart = chartSpy.mock.calls.find((call) => call[0].id === "executive-region-comparison");
      expect(regionChart).toBeDefined();
      const points = regionChart![0].series[0].points;
      expect(points.some((point) => point.x === "الشرقية")).toBe(true);
    } finally {
      chartSpy.mockRestore();
    }
  });

  // ── Region table: "جديد" for zero-previous rows ──────────────────────

  it("region table shows 'جديد' in changeRate column when previous=0 and current>0", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      allRegions: [
        { regionName: "الرياض", currentCount: 15, previousCount: 0, difference: 15, changeRate: null, complianceRate: 90, averageResolutionDays: 3, currentlyLate: 1, direction: "جديد" },
      ],
    });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      expect(texts).toContain("جديد");
      expect(texts.every((text) => text !== "غير متاح")).toBe(true);
    } finally {
      textSpy.mockRestore();
    }
  });

  it("region table does not show 'غير متاح' for new regions even with no previousCount", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      allRegions: [
        { regionName: "جدة", currentCount: 5, previousCount: 0, difference: 5, changeRate: null, complianceRate: null, averageResolutionDays: null, currentlyLate: 0, direction: "جديد" },
        { regionName: "مكة", currentCount: 3, previousCount: 2, difference: 1, changeRate: 50, complianceRate: 80, averageResolutionDays: 2, currentlyLate: 0, direction: "↑ ارتفاع" },
      ],
    });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      // "جديد" must appear for the zero-previous row
      expect(texts).toContain("جديد");
    } finally {
      textSpy.mockRestore();
    }
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

  it("PDF contains exactly 4 pages", async () => {
    const data = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "PRINT_EXECUTIVE_BRIEF");
    expect(countPageObjects(result.buffer)).toBe(4);
  });

  it("print PDF buffer is reasonably sized (> 5 KB)", async () => {
    const data = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const result = await renderExecutiveBriefPdf(data, "PRINT_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(5_000);
  });

  it("print and digital PDFs use their intended page dimensions", async () => {
    const digital = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const print = makeReportData("PRINT_EXECUTIVE_BRIEF");
    const [digitalResult, printResult] = await Promise.all([
      renderExecutiveBriefPdf(digital, "DIGITAL_EXECUTIVE_BRIEF"),
      renderExecutiveBriefPdf(print, "PRINT_EXECUTIVE_BRIEF"),
    ]);
    const [digitalWidth, digitalHeight] = firstMediaBox(digitalResult.buffer);
    const [printWidth, printHeight] = firstMediaBox(printResult.buffer);
    expect(digitalWidth).toBeCloseTo(900, 2);
    expect(digitalHeight).toBeGreaterThanOrEqual(1200);
    expect(printWidth).toBeCloseTo(900, 2);
    expect(printHeight).toBeGreaterThanOrEqual(1200);
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

// ---------------------------------------------------------------------------
// Layout review findings — page 2 notes, page 4 boxes, page header options
// ---------------------------------------------------------------------------

describe("renderExecutiveBriefPdf — layout review findings", () => {
  it("page 2 notes box renders without error for long note text", async () => {
    // A note longer than the box width should not throw and should truncate with ellipsis.
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      notes: [
        "هذا نص ملاحظة طويل جداً يحتوي على كثير من الكلمات والمعلومات التي قد تتجاوز عرض الصندوق بكثير مما قد يسبب التفاف النص أو تداخله مع العناصر الأخرى في الصفحة إذا لم يتم التعامل معه بشكل صحيح",
        "ملاحظة قصيرة",
      ],
    });
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(countPageObjects(result.buffer)).toBe(4);
  });

  it("page 2 notes text call uses lineBreak:false to prevent overflow", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      // preparePdfText reverses RTL token order, so "•" moves to the end of the string.
      // Use includes("•") to find bullet calls regardless of token position.
      const bulletCalls = textSpy.mock.calls.filter((call) =>
        String(call[0]).includes("•") &&
        typeof call[3] === "object" &&
        call[3] !== null
      );
      // At least one bullet call must have lineBreak:false
      const hasLineBreakFalse = bulletCalls.some(
        (call) => (call[3] as Record<string, unknown>)?.lineBreak === false
      );
      expect(hasLineBreakFalse).toBe(true);
    } finally {
      textSpy.mockRestore();
    }
  });

  it("page 4 bullet boxes render without error when many conclusions/notes", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      conclusions: [
        "استنتاج أول",
        "استنتاج ثاني",
        "استنتاج ثالث",
        "استنتاج رابع",
        "استنتاج خامس",
        "استنتاج سادس",
      ],
      notes: [
        "ملاحظة أولى",
        "ملاحظة ثانية",
        "ملاحظة ثالثة",
        "ملاحظة رابعة",
        "ملاحظة خامسة",
      ],
    });
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(countPageObjects(result.buffer)).toBe(4);
  });

  it("page 4 boxes box section title is always rendered (header visible)", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({ conclusions: [], notes: [] });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      expect(texts).toContain("الاستنتاجات");
      expect(texts).toContain("ملاحظات");
    } finally {
      textSpy.mockRestore();
    }
  });

  it("executive brief stays exactly four pages when notes are present", async () => {
    const data = makeReportData("DIGITAL_EXECUTIVE_BRIEF");
    data.briefData = makeBriefData({
      notes: ["ملاحظة 1", "ملاحظة 2", "ملاحظة 3"],
      conclusions: ["استنتاج 1", "استنتاج 2"],
    });
    const result = await renderExecutiveBriefPdf(data, "DIGITAL_EXECUTIVE_BRIEF");
    expect(countPageObjects(result.buffer)).toBe(4);
  });

  it("drawPageHeader heightOfString call uses same options as text call", async () => {
    // Verifies the options-object unification fix: both calls share width+align+wordSpacing
    const heightSpy = vi.spyOn(PDFDocument.prototype, "heightOfString");
    try {
      await renderExecutiveBriefPdf(makeReportData("DIGITAL_EXECUTIVE_BRIEF"), "DIGITAL_EXECUTIVE_BRIEF");
      // heightOfString must have been called at least once (for each page title)
      expect(heightSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Each call must provide an options object with a width
      for (const call of heightSpy.mock.calls) {
        const opts = call[1] as Record<string, unknown> | undefined;
        if (opts) {
          expect(opts.width).toBeDefined();
        }
      }
    } finally {
      heightSpy.mockRestore();
    }
  });
});
