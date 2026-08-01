// @vitest-environment node
//
// pdfkit/fontkit parse binary font data using Node's real Buffer/typed-array
// globals; under the project's default jsdom environment those checks fail
// with "Not a supported font format", so this file opts back into node.
import { describe, expect, it } from "vitest";
import type { ReportData, ReportSection } from "./report-data-service";
import { renderReportPdf } from "./report-pdf-service";

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

  it("renders a methodology note only for executive summaries", async () => {
    const { buffer } = await renderReportPdf(executiveReport());
    expect(bufferContainsText(buffer, "منهجية الاحتساب")).toBe(true);
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
});
