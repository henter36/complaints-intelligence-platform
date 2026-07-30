// @vitest-environment node
//
// pdfkit/fontkit parse binary font data using Node's real Buffer/typed-array
// globals; under the project's default jsdom environment those checks fail
// with "Not a supported font format", so this file opts back into node.
import { describe, expect, it } from "vitest";
import type { ReportData } from "./report-data-service";
import { renderReportPdf } from "./report-pdf-service";

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
