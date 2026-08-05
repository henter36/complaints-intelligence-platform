// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { ReportType } from "@prisma/client";
import type { ExecutiveBriefV2Data, ReportData } from "./report-data-service";
import { isExecutiveBriefV2Data } from "./report-data-service";
import {
  renderExecutiveBriefV2Pdf,
  formatTableValue,
  fitTextToBox,
  measurePreparedArabicText,
  resolveV2MonthlyChartAvailableHeight,
  resolveV2MonthlyChartHeight,
  resolveV2ConclusionsAvailableHeight,
} from "./report-executive-brief-v2-pdf-service";
import { preparePdfText } from "./arabic-pdf-text";
import { REPORT_DESIGN_TOKENS } from "@/lib/reports/design-tokens";
import { UNCLASSIFIED_CLASSIFICATION_KEY } from "@/lib/reports/classification-keys";

const DANGER = REPORT_DESIGN_TOKENS.colors.danger;

function countPageObjects(buffer: Buffer): number {
  return (buffer.toString("binary").match(/\/Type\s*\/Page\s*\/Parent/g) ?? []).length;
}

function makeV2Brief(overrides: Partial<ExecutiveBriefV2Data> = {}): ExecutiveBriefV2Data {
  return {
    briefKpis: [
      { key: "total", label: "إجمالي الشكاوى", value: 100, previousValue: 80, difference: 20, changeRate: 25, format: "number", assessment: "neutral" },
      { key: "open", label: "المفتوحة", value: 30, previousValue: 25, difference: 5, changeRate: 20, format: "number", assessment: "negative" },
      { key: "closed", label: "المغلقة", value: 65, previousValue: 50, difference: 15, changeRate: 30, format: "number", assessment: "positive" },
      { key: "currentlyLate", label: "المتأخرة", value: 8, previousValue: 10, difference: -2, changeRate: -20, format: "number", assessment: "positive" },
      { key: "complianceRate", label: "نسبة الالتزام", value: 95, previousValue: 90, difference: 5, changeRate: 5.6, format: "percent", assessment: "positive" },
      { key: "averageResolutionDays", label: "متوسط زمن الإغلاق", value: 3.5, previousValue: 4, difference: -0.5, changeRate: -12.5, format: "days", assessment: "positive" },
      { key: "closedLate", label: "المغلقة بعد المهلة", value: 2, previousValue: 3, difference: -1, changeRate: -33.3, format: "number", assessment: "positive" },
      { key: "netChange", label: "صافي التغير", value: 20, previousValue: null, difference: null, changeRate: null, format: "number", assessment: "neutral" },
    ],
    allRegions: [
      { regionName: "منطقة الرياض", currentCount: 40, previousCount: 30, difference: 10, changeRate: 33.3, complianceRate: 96, averageResolutionDays: 3.2, openCount: 10, closedCount: 30, currentlyLate: 3, direction: "ارتفاع" },
      { regionName: "منطقة جدة", currentCount: 30, previousCount: 35, difference: -5, changeRate: -14.3, complianceRate: 95, averageResolutionDays: 3.5, openCount: 8, closedCount: 22, currentlyLate: 2, direction: "انخفاض" },
      { regionName: "منطقة مكة", currentCount: 15, previousCount: 0, difference: 15, changeRate: null, complianceRate: 90, averageResolutionDays: 4, openCount: 5, closedCount: 10, currentlyLate: 1, direction: "ارتفاع" },
    ],
    topClassifications: [
      { classificationId: "c1", classificationName: "نقل", currentCount: 30, previousCount: 25, difference: 5, changeRate: 20, shareOfTotal: 30 },
      { classificationId: "c2", classificationName: "علاج", currentCount: 20, previousCount: 0, difference: 20, changeRate: null, shareOfTotal: 20 },
      {
        classificationId: UNCLASSIFIED_CLASSIFICATION_KEY,
        classificationName: "غير مصنف",
        currentCount: 50,
        previousCount: 40,
        difference: 10,
        changeRate: 25,
        shareOfTotal: 50,
      },
    ],
    comparativeTimeline: {
      current: { label: "الحالية", points: [{ relativeDay: 1, count: 10 }] },
      previous: { label: "السابقة", points: [{ relativeDay: 1, count: 8 }] },
      periodDays: 30,
    },
    concentrationBands: [],
    topDepartments: [
      { name: "المتابعة", total: 40, open: 10, closed: 30, currentlyLate: 3, shareOfTotal: 40 },
    ],
    conclusions: ["استنتاج تجريبي."],
    notes: ["ملاحظة جودة بيانات تجريبية."],
    allTimeTotal: 18560,
    monthlyStockFlow: [
      { monthKey: "2025-11", monthLabel: "نوفمبر 2025", receivedCount: 100, closedDuringMonthCount: 90, openAtMonthEndCount: 40, lateAtMonthEndCount: 5 },
      { monthKey: "2025-12", monthLabel: "ديسمبر 2025", receivedCount: 120, closedDuringMonthCount: 110, openAtMonthEndCount: 45, lateAtMonthEndCount: 6 },
    ],
    classificationOpenLate: {
      c1: { openAtEnd: 12, lateAtEnd: 3 },
      c2: { openAtEnd: 4, lateAtEnd: 1 },
      [UNCLASSIFIED_CLASSIFICATION_KEY]: { openAtEnd: 163, lateAtEnd: 163 },
    },
    ...overrides,
  };
}

function makeV2Report(overrides: Partial<ReportData> = {}): ReportData {
  return {
    type: "EXECUTIVE_SUMMARY" as ReportType,
    title: "تقرير الشكاوى",
    generatedAt: new Date("2026-07-31T04:00:00Z").toISOString(),
    period: { from: "2025-11-25", to: "2025-12-25" },
    previousPeriod: { from: "2025-10-25", to: "2025-11-24" },
    filters: { from: "2025-11-25", to: "2025-12-25" },
    kpis: {} as ReportData["kpis"],
    sections: [],
    warnings: [],
    rowCount: 0,
    reportMode: "PRINT_EXECUTIVE_BRIEF_V2",
    comparisonMode: "PREVIOUS_EQUIVALENT_PERIOD",
    briefData: makeV2Brief(),
    comparisonData: {
      currentPeriod: { from: new Date("2025-11-25"), toExclusive: new Date("2025-12-26") },
      previousPeriod: { from: new Date("2025-10-25"), toExclusive: new Date("2025-11-25") },
      currentTotal: 100,
      previousTotal: 80,
      regionTrend: { allDates: [], series: [], truncated: false, otherSeriesName: null },
      regionChanges: [],
      regionSubjectChanges: [
        { regionName: "منطقة الرياض", subject: "عرضه على الطبيب", currentCount: 18, previousCount: 7, difference: 11, changeRate: 157.1, direction: "ارتفاع" },
        { regionName: "منطقة جدة", subject: "استفسار", currentCount: 1, previousCount: 8, difference: -7, changeRate: -87.5, direction: "انخفاض" },
        { regionName: "منطقة مكة", subject: "طلب نقل", currentCount: 4, previousCount: 0, difference: 4, changeRate: null, direction: "ارتفاع" },
      ],
      deptClassRises: [
        {
          departmentId: "d1",
          departmentName: "المتابعة",
          classificationId: "c1",
          classificationName: "نقل",
          currentCount: 10,
          previousCount: 2,
          difference: 8,
          changeRate: 400,
          classificationContribution: 80,
        },
      ],
      deptClassRisesTotal: 1,
      deptClassAllPairs: [],
      executiveSummaryPoints: [],
      warnings: [],
    },
    ...overrides,
  };
}

describe("isExecutiveBriefV2Data", () => {
  it("rejects payloads missing classificationOpenLate so EMPTY_V2 fallback is used", async () => {
    const incomplete = {
      briefKpis: makeV2Brief().briefKpis,
      allRegions: makeV2Brief().allRegions,
      topClassifications: makeV2Brief().topClassifications,
      comparativeTimeline: makeV2Brief().comparativeTimeline,
      concentrationBands: [],
      topDepartments: makeV2Brief().topDepartments,
      conclusions: makeV2Brief().conclusions,
      notes: makeV2Brief().notes,
      allTimeTotal: 18560,
      monthlyStockFlow: makeV2Brief().monthlyStockFlow,
      // intentionally omit classificationOpenLate
    };
    expect(isExecutiveBriefV2Data(incomplete as unknown as ExecutiveBriefV2Data)).toBe(false);

    const result = await renderExecutiveBriefV2Pdf(
      makeV2Report({
        briefData: incomplete as unknown as ExecutiveBriefV2Data,
      })
    );
    expect(result.buffer.slice(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});

describe("renderExecutiveBriefV2Pdf", () => {
  it("produces a valid 4-page reference PDF", async () => {
    const result = await renderExecutiveBriefV2Pdf(makeV2Report());
    expect(result.buffer.slice(0, 4).toString()).toBe("%PDF");
    expect(countPageObjects(result.buffer)).toBe(4);
    expect(result.warnings.every((w) => !w.includes("بدلًا من"))).toBe(true);
  });

  it("colors negative difference and changeRate with danger", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const fillSpy = vi.spyOn(PDFDocument.prototype, "fillColor");
    try {
      await renderExecutiveBriefV2Pdf(makeV2Report());
      const colorBefore = (needle: string): string | undefined => {
        const textIndex = textSpy.mock.calls.findIndex((call) => String(call[0]).includes(needle));
        if (textIndex < 0) return undefined;
        const textOrder = textSpy.mock.invocationCallOrder[textIndex];
        let colorIndex = -1;
        fillSpy.mock.invocationCallOrder.forEach((order, index) => {
          if (order < textOrder && (colorIndex === -1 || order > fillSpy.mock.invocationCallOrder[colorIndex])) {
            colorIndex = index;
          }
        });
        return colorIndex === -1 ? undefined : String(fillSpy.mock.calls[colorIndex][0]);
      };
      // −5 difference for Jeddah and −14.3% change rate
      expect(colorBefore("−5")).toBe(DANGER);
      expect(colorBefore("−14.3%")).toBe(DANGER);
    } finally {
      textSpy.mockRestore();
      fillSpy.mockRestore();
    }
  });

  it("uses drawInfoBox height so long methodology notes do not ignore returned y", async () => {
    const yValues: number[] = [];
    const originalRoundedRect = PDFDocument.prototype.roundedRect;
    const rectSpy = vi.spyOn(PDFDocument.prototype, "roundedRect").mockImplementation(function (
      this: PDFKit.PDFDocument,
      ...args: unknown[]
    ) {
      const y = args[1] as number;
      yValues.push(y);
      return originalRoundedRect.apply(this, args as [number, number, number, number, number?]);
    });
    try {
      await renderExecutiveBriefV2Pdf(makeV2Report());
      expect(yValues.length).toBeGreaterThan(5);
      // Later boxes are placed at higher y positions on page content flow
      expect(Math.max(...yValues)).toBeGreaterThan(Math.min(...yValues));
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("classification comparison columns do not depend on region previous data", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      const data = makeV2Report();
      data.briefData = makeV2Brief({
        allRegions: makeV2Brief().allRegions.map((r) => ({
          ...r,
          previousCount: 0,
          difference: r.currentCount,
          changeRate: null,
        })),
        topClassifications: [
          { classificationId: "c1", classificationName: "نقل", currentCount: 30, previousCount: 25, difference: 5, changeRate: 20, shareOfTotal: 30 },
        ],
      });
      await renderExecutiveBriefV2Pdf(data);
      const texts = textSpy.mock.calls.map((c) => String(c[0]));
      // "السابق" header must appear for classifications even when regions have previous=0
      expect(texts.some((t) => t.includes("السابق"))).toBe(true);
    } finally {
      textSpy.mockRestore();
    }
  });

  it("does not fail when page count exceeds target; footers use actual count", async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      regionName: `منطقة ${i + 1}`,
      currentCount: 50 + i,
      previousCount: 40 + i,
      difference: 10,
      changeRate: 25,
      complianceRate: 90,
      averageResolutionDays: 4,
      openCount: 10,
      closedCount: 40,
      currentlyLate: 2,
      direction: "ارتفاع",
    }));
    const data = makeV2Report({
      briefData: makeV2Brief({
        allRegions: many,
        notes: Array.from({ length: 5 }, (_, i) => `ملاحظة ${i + 1}`),
        conclusions: Array.from({ length: 5 }, (_, i) => `استنتاج ${i + 1}`),
      }),
    });
    const result = await renderExecutiveBriefV2Pdf(data);
    expect(result.buffer.slice(0, 4).toString()).toBe("%PDF");
    expect(countPageObjects(result.buffer)).toBeGreaterThanOrEqual(4);
    // Must never throw V2_PAGE_COUNT_MISMATCH
    expect(result.warnings.some((w) => w.includes("V2_PAGE_COUNT"))).toBe(false);
  });

  it("calls doc.end once on success and once on render failure", async () => {
    const originalEnd = PDFDocument.prototype.end;
    let endCount = 0;
    PDFDocument.prototype.end = function (this: PDFKit.PDFDocument, ...args: unknown[]) {
      endCount += 1;
      return originalEnd.apply(this, args as []);
    };
    try {
      const ok = await renderExecutiveBriefV2Pdf(makeV2Report());
      expect(ok.buffer.length).toBeGreaterThan(100);
      expect(endCount).toBe(1);

      endCount = 0;
      const originalAddPage = PDFDocument.prototype.addPage;
      let addPageCalls = 0;
      PDFDocument.prototype.addPage = function (this: PDFKit.PDFDocument, ...args: unknown[]) {
        addPageCalls += 1;
        // Allow autoFirstPage construction; fail when adding page 2.
        if (addPageCalls >= 2) {
          throw new Error("forced-render-failure");
        }
        return originalAddPage.apply(this, args as []);
      };
      try {
        await expect(renderExecutiveBriefV2Pdf(makeV2Report())).rejects.toThrow("forced-render-failure");
        expect(endCount).toBe(1);
      } finally {
        PDFDocument.prototype.addPage = originalAddPage;
      }
    } finally {
      PDFDocument.prototype.end = originalEnd;
    }
  });

  it("shows جديد when previousCount is 0 and uses signed subject declines", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderExecutiveBriefV2Pdf(makeV2Report());
      const joined = textSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(joined).toContain("جديد");
      expect(joined).toMatch(/−7/);
    } finally {
      textSpy.mockRestore();
    }
  });

  it("renders table headers without deleted note section titles", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      const result = await renderExecutiveBriefV2Pdf(
        makeV2Report({
          briefData: makeV2Brief({
            notes: [
              "تعتمد شكاوى الفترة على تاريخ إنشاء الشكوى، بينما تشمل مؤشرات المفتوحة والمتأخرة جميع الحالات غير المغلقة حتى نهاية الفترة ولو أُنشئت قبل بداية الفترة.",
              "ملاحظة جودة بيانات تجريبية.",
            ],
          }),
        })
      );
      expect(countPageObjects(result.buffer)).toBe(4);
      const joined = textSpy.mock.calls.map((c) => String(c[0])).join("\n");
      for (const token of [
        "المنطقة",
        "الحالية",
        "السابقة",
        "الفرق",
        "تغير",
        "موضوع",
        "التصنيف",
        "الإدارة",
        "الاستنتاجات",
        "استنتاج",
        "المتابعة",
        "نقل",
      ]) {
        expect(joined).toContain(token);
      }
      expect(joined).not.toContain("[object Object]");
      expect(joined).not.toContain(preparePdfText("ملاحظات جودة البيانات وتأثيرها على المؤشرات"));
      expect(joined).not.toContain("ملاحظات جودة البيانات وتأثيرها على المؤشرات");
    } finally {
      textSpy.mockRestore();
    }
  });

  it("does not render the long cover policy note", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const policyNote =
      "تعتمد شكاوى الفترة على تاريخ إنشاء الشكوى، بينما تشمل مؤشرات المفتوحة والمتأخرة جميع الحالات غير المغلقة حتى نهاية الفترة ولو أُنشئت قبل بداية الفترة.";
    try {
      await renderExecutiveBriefV2Pdf(
        makeV2Report({
          briefData: makeV2Brief({ notes: [policyNote] }),
        })
      );
      const joined = textSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(joined).not.toContain(preparePdfText(policyNote));
      expect(joined).not.toContain(policyNote);
    } finally {
      textSpy.mockRestore();
    }
  });
});

describe("formatTableValue", () => {
  it("formats numbers and strings while blocking object leak", () => {
    expect(formatTableValue(12)).toBe("12");
    expect(formatTableValue("نقل")).toBe("نقل");
    expect(formatTableValue(null)).toBe("—");
    expect(formatTableValue(undefined)).toBe("—");
    expect(formatTableValue({ nested: true })).toBe("—");
    expect(formatTableValue([1, 2])).toBe("—");
    expect(formatTableValue({ nested: true })).not.toContain("object Object");
  });
});

describe("V2 monthly chart contract + KPI packing", () => {
  it("does not put allTimeTotal into monthly chart series", async () => {
    const pngSpy = vi.spyOn(await import("./report-chart-service"), "renderLineChartPng");
    pngSpy.mockResolvedValue(Buffer.from(
      // minimal 1x1 PNG
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    ));
    try {
      await renderExecutiveBriefV2Pdf(
        makeV2Report({
          briefData: makeV2Brief({
            allTimeTotal: 16993,
            monthlyStockFlow: Array.from({ length: 13 }, (_, i) => {
              const d = new Date(Date.UTC(2025, 7 + i, 1));
              const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
              return {
                monthKey: key,
                monthLabel: `شهر ${i + 1}`,
                receivedCount: 5 + (i % 3),
                closedDuringMonthCount: 4,
                openAtMonthEndCount: 3,
                lateAtMonthEndCount: 1,
              };
            }),
          }),
        })
      );
      const call = pngSpy.mock.calls.find((c) => (c[0] as { id?: string }).id === "v2-monthly-flow");
      expect(call).toBeTruthy();
      const section = call![0] as {
        series: Array<{ name: string; points: Array<{ y: number }>; axis?: string }>;
      };
      expect(section.series).toHaveLength(4);
      expect(section.series.every((s) => s.axis !== "right")).toBe(true);
      const allY = section.series.flatMap((s) => s.points.map((p) => p.y));
      expect(allY.every((y) => y < 100)).toBe(true);
      expect(allY).not.toContain(16993);
      const names = section.series.map((s) => s.name);
      expect(names).toEqual([
        "الواردة",
        "المغلقة",
        "المفتوحة",
        "المتأخرة",
      ]);
    } finally {
      pngSpy.mockRestore();
    }
  });

  it("renders empty monthly chart series with emptyState when all values are zero", async () => {
    const pngSpy = vi.spyOn(await import("./report-chart-service"), "renderLineChartPng");
    pngSpy.mockResolvedValue(Buffer.from("png"));
    try {
      await renderExecutiveBriefV2Pdf(
        makeV2Report({
          briefData: makeV2Brief({
            monthlyStockFlow: [
              {
                monthKey: "2025-11",
                monthLabel: "نوفمبر 2025",
                receivedCount: 0,
                closedDuringMonthCount: 0,
                openAtMonthEndCount: 0,
                lateAtMonthEndCount: 0,
              },
              {
                monthKey: "2025-12",
                monthLabel: "ديسمبر 2025",
                receivedCount: 0,
                closedDuringMonthCount: 0,
                openAtMonthEndCount: 0,
                lateAtMonthEndCount: 0,
              },
            ],
          }),
        })
      );
      const call = pngSpy.mock.calls.find((c) => (c[0] as { id?: string }).id === "v2-monthly-flow");
      expect(call).toBeTruthy();
      const section = call![0] as { series: unknown[]; emptyState?: string };
      expect(section.series).toEqual([]);
      expect(section.emptyState).toBe("لا توجد بيانات للاتجاه الزمني.");
    } finally {
      pngSpy.mockRestore();
    }
  });

  it("clamps monthly chart height to remaining page space", () => {
    const tight = resolveV2MonthlyChartAvailableHeight(842, 42, 600);
    expect(tight).toBeLessThan(320);
    expect(resolveV2MonthlyChartHeight(tight)).toBe(tight);
    expect(resolveV2MonthlyChartHeight(tight)).toBeLessThanOrEqual(tight);

    const negativeSpace = resolveV2MonthlyChartAvailableHeight(842, 42, 900);
    expect(negativeSpace).toBe(0);
    expect(resolveV2MonthlyChartHeight(negativeSpace)).toBe(0);
    expect(resolveV2MonthlyChartHeight(-40)).toBe(0);
  });

  it("keeps conclusions box within the footer reserve", () => {
    const pageHeight = 842;
    const margin = 42;
    const y = 520;
    const availableH = resolveV2ConclusionsAvailableHeight(pageHeight, margin, y);
    expect(availableH).toBe(pageHeight - margin - 26 - y);
    expect(availableH).not.toBe(pageHeight - margin * 2 - 26 - y);

    const lineH = 22;
    const boxHdrH = 30;
    const conclusionsCount = 3;
    const conclusionsBoxH = Math.max(
      boxHdrH + lineH + 12,
      Math.min(boxHdrH + 12 + Math.max(conclusionsCount, 1) * lineH, availableH)
    );
    expect(y + conclusionsBoxH).toBeLessThanOrEqual(pageHeight - margin - 26);
  });

  it("fits stress KPI values without throwing (0%, unavailable, large numbers)", async () => {
    const result = await renderExecutiveBriefV2Pdf(
      makeV2Report({
        briefData: makeV2Brief({
          allTimeTotal: 999999,
          briefKpis: [
            { key: "total", label: "إجمالي الشكاوى", value: 0, previousValue: 0, difference: 0, changeRate: 0, format: "number", assessment: "neutral" },
            { key: "open", label: "المفتوحة", value: 2, previousValue: 1, difference: 1, changeRate: 100, format: "number", assessment: "negative" },
            { key: "closed", label: "المغلقة", value: 100, previousValue: 50, difference: 50, changeRate: 100, format: "number", assessment: "positive" },
            { key: "currentlyLate", label: "المتأخرة", value: 0, previousValue: 10, difference: -10, changeRate: -100, format: "number", assessment: "positive" },
            { key: "closedLate", label: "المغلقة بعد المهلة", value: 2, previousValue: 3, difference: -1, changeRate: -33.3, format: "number", assessment: "positive" },
            { key: "complianceRate", label: "الالتزام ضمن المهلة", value: 0, previousValue: 50, difference: -50, changeRate: -100, format: "percent", assessment: "negative" },
            { key: "averageResolutionDays", label: "متوسط الإغلاق", value: null, previousValue: null, difference: null, changeRate: null, format: "days", assessment: "neutral" },
            { key: "netChange", label: "صافي التغير", value: 20, previousValue: null, difference: null, changeRate: null, format: "number", assessment: "neutral" },
          ],
        }),
      })
    );
    expect(result.buffer.slice(0, 4).toString()).toBe("%PDF");
    expect(countPageObjects(result.buffer)).toBe(4);
  });

  it("drops months after report.to before chart render without page-2 notes boxes", async () => {
    const chartService = await import("./report-chart-service");
    const pngSpy = vi.spyOn(chartService, "renderLineChartPng").mockResolvedValue(Buffer.from("png"));
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const roundedSpy = vi.spyOn(PDFDocument.prototype, "roundedRect");
    const deletedMethodology =
      "يعرض الاتجاه الشهري كامل البيانات المتاحة حتى نهاية التقرير، بحد أقصى 13 شهرًا. تمثل الأعمدة الشكاوى الواردة والمغلقة خلال كل شهر، وتمثل الخطوط رصيد الشكاوى المفتوحة والمتأخرة في نهاية الشهر.";
    const policyNote =
      "تعتمد شكاوى الفترة على تاريخ إنشاء الشكوى، بينما تشمل مؤشرات المفتوحة والمتأخرة جميع الحالات غير المغلقة حتى نهاية الفترة ولو أُنشئت قبل بداية الفترة.";
    try {
      const result = await renderExecutiveBriefV2Pdf(
        makeV2Report({
          period: { from: "2026-07-05", to: "2026-08-04" },
          briefData: makeV2Brief({
            notes: [policyNote, "ملاحظة جودة بيانات تجريبية."],
            monthlyStockFlow: [
              {
                monthKey: "2026-07",
                monthLabel: "يوليو 2026",
                receivedCount: 3,
                closedDuringMonthCount: 1,
                openAtMonthEndCount: 2,
                lateAtMonthEndCount: 0,
              },
              {
                monthKey: "2026-08",
                monthLabel: "أغسطس 2026",
                receivedCount: 5,
                closedDuringMonthCount: 2,
                openAtMonthEndCount: 3,
                lateAtMonthEndCount: 1,
              },
              {
                monthKey: "2026-09",
                monthLabel: "سبتمبر 2026",
                receivedCount: 9,
                closedDuringMonthCount: 4,
                openAtMonthEndCount: 5,
                lateAtMonthEndCount: 2,
              },
            ],
          }),
        })
      );

      expect(result.warnings).toContain("تم تجاهل نقاط زمنية تتجاوز نهاية فترة التقرير.");
      expect(countPageObjects(result.buffer)).toBe(4);

      const flowCall = pngSpy.mock.calls.find(
        (call) => (call[0] as { id?: string }).id === "v2-monthly-flow"
      );
      expect(flowCall).toBeDefined();
      const section = flowCall![0] as {
        series: Array<{ name: string; points: Array<{ x: string; y: number }> }>;
      };
      expect(section.series).toHaveLength(4);
      const expectedLabels = ["يوليو 2026", "أغسطس 2026"];
      for (const series of section.series) {
        expect(series.points.map((p) => p.x)).toEqual(expectedLabels);
        expect(series.points.some((p) => p.x === "سبتمبر 2026")).toBe(false);
      }

      const joined = textSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(joined).not.toContain(preparePdfText(deletedMethodology));
      expect(joined).not.toContain(preparePdfText(policyNote));
      // Page 2 must not draw the notes bullet-box title (prepared RTL form).
      expect(joined).not.toContain(preparePdfText("ملاحظات"));
      expect(joined).not.toContain(preparePdfText("ملاحظات جودة البيانات وتأثيرها على المؤشرات"));
      // Page 3 info box stays short and present
      expect(joined).toContain(
        preparePdfText("يعرض الجدول التغير بين الفترتين حسب المنطقة، وتظهر «جديد» عند عدم وجود قيمة سابقة.")
      );
      // No empty replacement box forced for deleted notes (roundedRect still used by KPIs)
      expect(roundedSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      pngSpy.mockRestore();
      textSpy.mockRestore();
      roundedSpy.mockRestore();
    }
  });

  it("fitTextToBox shrinks long numbers and unavailable label", () => {
    const doc = new PDFDocument({ size: [200, 200], margin: 0 });
    const assets = path.join(process.cwd(), "src/server/reports/assets/fonts");
    doc.registerFont("Body", fs.readFileSync(path.join(assets, "Amiri-Regular.ttf")));
    doc.registerFont("Bold", fs.readFileSync(path.join(assets, "Amiri-Bold.ttf")));
    const narrow = 48;
    const size16k = fitTextToBox(doc, "16,993", narrow, 22, 10, "Bold");
    const size999 = fitTextToBox(doc, "999,999", narrow, 22, 10, "Bold");
    const sizeNA = fitTextToBox(doc, "غير متاح", narrow, 14, 9, "Bold");
    expect(size16k).toBeLessThanOrEqual(22);
    expect(size999).toBeLessThanOrEqual(size16k);
    expect(measurePreparedArabicText(doc, "16,993", size16k, "Bold")).toBeLessThanOrEqual(narrow + 1);
    expect(measurePreparedArabicText(doc, "غير متاح", sizeNA, "Bold")).toBeLessThanOrEqual(narrow + 2);
    doc.end();
  });
});
