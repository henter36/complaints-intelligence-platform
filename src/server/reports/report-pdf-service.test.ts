// @vitest-environment node
//
// pdfkit/fontkit parse binary font data using Node's real Buffer/typed-array
// globals; under the project's default jsdom environment those checks fail
// with "Not a supported font format", so this file opts back into node.
import PDFDocument from "pdfkit";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ReportData, ReportSection } from "./report-data-service";
import { renderReportPdf } from "./report-pdf-service";
import * as chartService from "./report-chart-service";

/** PDFKit stores Info strings (Title/Keywords) as UTF-16BE literals, so a
 * title is discoverable in the raw buffer via its UTF-16BE byte sequence.
 * On-page text is glyph-subsetted and cannot be searched directly.
 *
 * PDF literal strings escape the bytes 0x28 "(", 0x29 ")" and 0x5C "\" with a
 * backslash, so any Arabic code unit whose low byte is one of those is written
 * as `5C <byte>`. We reproduce that escaping to build a byte-accurate needle. */
function bufferContainsText(buffer: Buffer, text: string): boolean {
  const raw = Buffer.from(text, "utf16le").swap16();
  const escaped: number[] = [];
  for (const byte of raw) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) escaped.push(0x5c);
    escaped.push(byte);
  }
  return buffer.includes(Buffer.from(escaped));
}

function baseReport(overrides: Partial<ReportData> = {}): ReportData {
  return {
    type: "EXECUTIVE_SUMMARY",
    title: "التقرير التنفيذي الشامل",
    generatedAt: new Date("2026-07-31T04:00:00Z").toISOString(),
    period: { from: "2026-07-01", to: "2026-07-31" },
    filters: { from: "2026-07-01", to: "2026-07-31", region: "الرياض" },
    kpis: {} as ReportData["kpis"],
    warnings: [],
    rowCount: 0,
    sections: [
      {
        id: "kpi_overview",
        kind: "kpi",
        title: "المؤشرات الرئيسية",
        cards: [
          { key: "total", label: "إجمالي الشكاوى", value: 1240, format: "number" },
          { key: "onTimeRate", label: "نسبة الالتزام", value: 87.5, format: "percent" },
        ],
      },
      {
        id: "top_regions",
        kind: "table",
        title: "أعلى المناطق",
        table: {
          id: "top_regions",
          title: "أعلى المناطق",
          columns: [
            { key: "name", label: "المنطقة", format: "text" },
            { key: "total", label: "الإجمالي", format: "number" },
          ],
          rows: [
            { name: "الرياض", total: 512 },
            { name: "جدة", total: 340 },
          ],
          truncated: false,
          totalMatched: 2,
        },
      },
    ],
    ...overrides,
  };
}

describe("PDF report rendering", () => {
  it("produces a valid PDF buffer with Arabic content", async () => {
    const { buffer, warnings } = await renderReportPdf(baseReport());
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
    expect(warnings).toEqual([]);
  });

  it("embeds the document title in the PDF Info dictionary", async () => {
    const { buffer } = await renderReportPdf(baseReport());
    const text = buffer.toString("latin1");
    expect(text).toContain("/Title");
  });

  it("spans multiple pages when the table has many rows", async () => {
    const manyRows = Array.from({ length: 120 }, (_, i) => ({ name: `منطقة ${i}`, total: i }));
    const report = baseReport({
      sections: [
        {
          id: "detail_table",
          kind: "table",
          title: "جدول كبير",
          table: {
            id: "detail_table",
            title: "جدول كبير",
            columns: [
              { key: "name", label: "الاسم", format: "text" },
              { key: "total", label: "العدد", format: "number" },
            ],
            rows: manyRows,
            truncated: false,
            totalMatched: manyRows.length,
          },
        },
      ],
    });

    const { buffer } = await renderReportPdf(report);
    const text = buffer.toString("latin1");
    const pageMatches = text.match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pageMatches.length).toBeGreaterThan(1);
  });

  it("stays within a reasonable file size for a moderate report", async () => {
    const { buffer } = await renderReportPdf(baseReport());
    expect(buffer.length).toBeLessThan(500 * 1024);
  });

  it("does not load or reserve the application Z logo in report renderers", () => {
    const standardSource = fs.readFileSync(new URL("./report-pdf-service.ts", import.meta.url), "utf8");
    const briefSource = fs.readFileSync(new URL("./report-executive-brief-pdf-service.ts", import.meta.url), "utf8");
    expect(`${standardSource}\n${briefSource}`).not.toMatch(/logo\.svg|LOGO_PATH|loadLogoPng/);
  });

  it("uses the analytical cover page for content and omits continuity without a reference period", async () => {
    const report = baseReport({
      title: "التقرير التحليلي الكامل",
      reportMode: "FULL_ANALYTICAL",
      previousPeriod: null,
      briefData: {
        briefKpis: [],
        allRegions: [],
        topClassifications: [],
        comparativeTimeline: {
          current: { label: "الحالي", points: [] },
          previous: null,
          periodDays: 31,
        },
        concentrationBands: [],
        netBacklogFlow: { inflow: 3, outflow: 1, net: 2, periodDays: 31 },
        perfVolumeRows: [{
          entityName: "إدارة الاختبار",
          totalComplaints: 3,
          complianceRate: 100,
          averageResolutionDays: 8,
          currentlyLate: 1,
          share: 100,
        }],
        continuityRows: [],
      },
    });
    const { buffer } = await renderReportPdf(report);
    const pageCount = (buffer.toString("binary").match(/\/Type\s*\/Page\s*\/Parent/g) ?? []).length;
    expect(pageCount).toBe(2);
    expect(bufferContainsText(buffer, "صافي تدفق التراكم")).toBe(true);
    expect(bufferContainsText(buffer, "الأداء مقابل الحجم")).toBe(true);
    expect(bufferContainsText(buffer, "الاستمرارية")).toBe(false);
  });

  it("does not throw when a table section is empty", async () => {
    const report = baseReport({
      sections: [
        {
          id: "top_regions",
          kind: "table",
          title: "بدون بيانات",
          table: { id: "top_regions", title: "بدون بيانات", columns: [], rows: [], truncated: false, totalMatched: 0 },
        },
      ],
    });
    const { buffer } = await renderReportPdf(report);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("carries forward warnings passed in on the report data", async () => {
    const report = baseReport({ warnings: ["تم اختصار جدول المتأخرات."] });
    const { warnings } = await renderReportPdf(report);
    expect(warnings).toContain("تم اختصار جدول المتأخرات.");
  });

  it("renders the defensive matrix truncation fallback", async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    try {
      await renderReportPdf(baseReport({
        sections: [{
          id: "matrix",
          kind: "matrix",
          title: "مصفوفة الاختبار",
          rowLabel: "الإدارة",
          columnLabel: "التصنيف",
          rowHeaders: ["إدارة أ"],
          columnHeaders: ["تصنيف أ"],
          cells: [[1]],
          rowTotals: [1],
          columnTotals: [1],
          grandTotal: 1,
          totalRows: 1,
          totalColumns: 1,
          truncatedRows: false,
          truncatedColumns: false,
          truncated: true,
          maxRows: 10,
          maxColumns: 10,
        }],
      }));

      expect(textSpy.mock.calls.map((call) => call[0]))
        .toContain("تم اختصار عرض بيانات المصفوفة.");
    } finally {
      textSpy.mockRestore();
    }
  });
});

describe("PDF report — comparative executive sections", () => {
  function executiveSections(): ReportSection[] {
    return [
      { id: "executive_summary_text", kind: "text", title: "الملخص التنفيذي", points: ["نقطة تجريبية أولى"] },
      {
        id: "kpi_overview",
        kind: "kpi",
        title: "المؤشرات الرئيسية",
        cards: [{ key: "total", label: "إجمالي الشكاوى", value: 342, format: "number" }],
      },
      {
        id: "region_trend_chart",
        kind: "chart",
        chartType: "line",
        title: "الاتجاه الزمني للشكاوى حسب المنطقة",
        series: [
          { name: "منطقة الرياض", points: [{ x: "2026-07-08", y: 2 }, { x: "2026-07-09", y: 3 }] },
          { name: "منطقة مكة المكرمة", points: [{ x: "2026-07-08", y: 1 }, { x: "2026-07-09", y: 4 }] },
        ],
      },
      {
        id: "region_changes",
        kind: "table",
        title: "التغير في عدد الشكاوى حسب المنطقة",
        table: {
          id: "region_changes",
          title: "التغير في عدد الشكاوى حسب المنطقة",
          columns: [
            { key: "regionName", label: "المنطقة", format: "text" },
            { key: "difference", label: "الفرق", format: "text" },
            { key: "direction", label: "الاتجاه", format: "text" },
          ],
          rows: [{ regionName: "منطقة الرياض", difference: "+12", direction: "↑ ارتفاع" }],
          truncated: false,
          totalMatched: 1,
        },
      },
      {
        id: "dept_class_rises",
        kind: "table",
        title: "الإدارات والتصنيفات التي شهدت ارتفاعًا عن الأسبوع السابق",
        table: {
          id: "dept_class_rises",
          title: "الإدارات والتصنيفات التي شهدت ارتفاعًا عن الأسبوع السابق",
          columns: [{ key: "departmentName", label: "الإدارة", format: "text" }],
          rows: [{ departmentName: "إدارة الرعاية الصحية" }],
          truncated: false,
          totalMatched: 1,
        },
      },
    ];
  }

  function executiveReport(): ReportData {
    return baseReport({
      previousPeriod: { from: "2026-07-01", to: "2026-07-07" },
      reportRunId: "abcd1234efgh5678",
      sections: executiveSections(),
    });
  }

  it("produces a non-empty PDF buffer", async () => {
    const { buffer } = await renderReportPdf(executiveReport());
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("references the new comparative section titles in the document metadata", async () => {
    const { buffer } = await renderReportPdf(executiveReport());
    expect(bufferContainsText(buffer, "الاتجاه الزمني للشكاوى حسب المنطقة")).toBe(true);
    expect(bufferContainsText(buffer, "التغير في عدد الشكاوى حسب المنطقة")).toBe(true);
    expect(bufferContainsText(buffer, "الإدارات والتصنيفات التي شهدت ارتفاعًا عن الأسبوع السابق")).toBe(true);
    expect(bufferContainsText(buffer, "الملخص التنفيذي")).toBe(true);
  });

  it("does not reference channel distribution anywhere", async () => {
    const { buffer } = await renderReportPdf(executiveReport());
    expect(bufferContainsText(buffer, "توزيع القنوات")).toBe(false);
    expect(buffer.toString("binary")).not.toContain("channel_distribution");
  });

  it("never renders [object Object]", async () => {
    const { buffer } = await renderReportPdf(executiveReport());
    expect(buffer.toString("binary")).not.toContain("[object Object]");
  });

  it("omits the removed methodology wording", async () => {
    const { buffer } = await renderReportPdf(executiveReport());
    expect(bufferContainsText(buffer, "منهجية الاحتساب")).toBe(false);
  });

  it("renders a visible placeholder instead of crashing when a chart has no data", async () => {
    const report = baseReport({
      sections: [
        {
          id: "region_trend_chart",
          kind: "chart",
          chartType: "line",
          title: "الاتجاه الزمني للشكاوى حسب المنطقة",
          series: [],
          emptyState: "لا توجد بيانات",
        },
      ],
    });
    const { buffer } = await renderReportPdf(report);
    // Empty series still renders (empty-state PNG), producing a valid PDF.
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("keeps a chart whose valid points all have zero values", async () => {
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    try {
      const report = baseReport({
        sections: [{
          id: "zero_trend",
          kind: "chart",
          chartType: "line",
          title: "اتجاه صفري صالح",
          series: [{
            name: "الفترة الحالية",
            points: Array.from({ length: 7 }, (_, index) => ({
              x: `2026-07-${String(index + 1).padStart(2, "0")}`,
              y: 0,
            })),
          }],
        }],
      });

      await renderReportPdf(report);

      expect(chartSpy).toHaveBeenCalledTimes(1);
    } finally {
      chartSpy.mockRestore();
    }
  });

  it("omits a chart when every series has no points", async () => {
    const chartSpy = vi.spyOn(chartService, "renderLineChartPng");
    try {
      const report = baseReport({
        sections: [{
          id: "empty_trend",
          kind: "chart",
          chartType: "line",
          title: "اتجاه بلا نقاط",
          series: [{ name: "الفترة الحالية", points: [] }],
        }],
      });

      await renderReportPdf(report);

      expect(chartSpy).not.toHaveBeenCalled();
    } finally {
      chartSpy.mockRestore();
    }
  });
});
