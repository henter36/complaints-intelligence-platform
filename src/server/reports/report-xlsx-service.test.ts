// @vitest-environment node
//
// exceljs parses/writes real binary zip buffers using Node's Buffer; keep
// this file on the node environment for the same reason as the PDF tests.
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { ReportData } from "./report-data-service";
import { renderReportXlsx } from "./report-xlsx-service";

function baseReport(overrides: Partial<ReportData> = {}): ReportData {
  return {
    type: "EXECUTIVE_SUMMARY",
    title: "التقرير التنفيذي الشامل",
    generatedAt: new Date("2026-07-31T04:00:00Z").toISOString(),
    period: { from: "2026-07-01", to: "2026-07-31" },
    filters: { from: "2026-07-01", to: "2026-07-31" },
    kpis: {
      totalComplaints: {
        currentValue: 1240, previousValue: 1100, absoluteChange: 140,
        percentageChange: 12.7, trend: "up", direction: "positive",
      },
    } as unknown as ReportData["kpis"],
    warnings: [],
    rowCount: 3,
    sections: [
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
            { key: "complianceRate", label: "الالتزام%", format: "percent" },
            { key: "dueDate", label: "الاستحقاق", format: "date" },
          ],
          rows: [
            { name: "الرياض", total: 512, complianceRate: 92.1, dueDate: "2026-07-15T00:00:00.000Z" },
            { name: "=SUM(A1:A10)", total: 340, complianceRate: 88.4, dueDate: null },
            { name: "+DANGEROUS", total: 10, complianceRate: 10, dueDate: null },
            { name: "-DANGEROUS", total: 10, complianceRate: 10, dueDate: null },
            { name: "@DANGEROUS", total: 10, complianceRate: 10, dueDate: null },
          ],
          truncated: false,
          totalMatched: 5,
        },
      },
    ],
    ...overrides,
  };
}

async function readBack(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook;
}

describe("XLSX report rendering", () => {
  it("produces a valid, readable workbook", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const workbook = await readBack(buffer);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toContain("الملخص");
    expect(sheetNames).toContain("المؤشرات");
    expect(sheetNames).toContain("أعلى المناطق");
  });

  it("uses right-to-left sheet views with a frozen header row", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const workbook = await readBack(buffer);
    for (const sheet of workbook.worksheets) {
      const view = sheet.views?.[0] as { rightToLeft?: boolean; state?: string; ySplit?: number } | undefined;
      expect(view?.rightToLeft).toBe(true);
      expect(view?.state).toBe("frozen");
      expect(view?.ySplit).toBe(1);
    }
  });

  it("sets an autoFilter on every data sheet", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const workbook = await readBack(buffer);
    const dataSheet = workbook.getWorksheet("أعلى المناطق")!;
    expect(dataSheet.autoFilter).toBeTruthy();
  });

  it("neutralizes formula-injection payloads (=, +, -, @) as literal text", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const workbook = await readBack(buffer);
    const dataSheet = workbook.getWorksheet("أعلى المناطق")!;

    const values: string[] = [];
    dataSheet.eachRow((row) => {
      const cell = row.getCell(1);
      if (typeof cell.value === "string") values.push(cell.value);
    });

    expect(values).toContain("'=SUM(A1:A10)");
    expect(values).toContain("'+DANGEROUS");
    expect(values).toContain("'-DANGEROUS");
    expect(values).toContain("'@DANGEROUS");
    // None of these must have been stored as an actual Excel formula object.
    dataSheet.eachRow((row) => {
      const cell = row.getCell(1);
      expect(typeof cell.value === "object" && cell.value !== null && "formula" in (cell.value as object)).toBe(false);
    });
  });

  it("stores numbers and percentages as numeric cell types, not strings", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const workbook = await readBack(buffer);
    const dataSheet = workbook.getWorksheet("أعلى المناطق")!;
    const firstDataRow = dataSheet.getRow(2);
    expect(typeof firstDataRow.getCell(2).value).toBe("number"); // total
    expect(typeof firstDataRow.getCell(3).value).toBe("number"); // complianceRate
  });

  it("stores dates as real Date cells with a date number format", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const workbook = await readBack(buffer);
    const dataSheet = workbook.getWorksheet("أعلى المناطق")!;
    const firstDataRow = dataSheet.getRow(2);
    const dateCell = firstDataRow.getCell(4);
    expect(dateCell.value).toBeInstanceOf(Date);
    expect(dateCell.numFmt).toBe("yyyy-mm-dd");
  });

  it("does not embed a VBA project (no macros)", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    // A macro-enabled workbook (.xlsm) embeds a vbaProject.bin part; a plain
    // .xlsx produced by exceljs's default writer never does.
    expect(buffer.includes(Buffer.from("vbaProject.bin"))).toBe(false);
  });

  it("does not add external link parts", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    expect(buffer.includes(Buffer.from("externalLink"))).toBe(false);
  });

  it("does not include PII columns for non-detail report tables", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const text = buffer.toString("latin1");
    expect(text).not.toContain("complainantPhone");
    expect(text).not.toContain("complainantIdentifier");
  });

  it("annotates truncated tables with a visible note", async () => {
    const report = baseReport({
      sections: [
        {
          id: "top_regions",
          kind: "table",
          title: "أعلى المناطق",
          table: {
            id: "top_regions", title: "أعلى المناطق",
            columns: [{ key: "name", label: "المنطقة", format: "text" }],
            rows: [{ name: "الرياض" }],
            truncated: true,
            totalMatched: 500,
          },
        },
      ],
    });
    const { buffer } = await renderReportXlsx(report);
    const workbook = await readBack(buffer);
    const sheet = workbook.getWorksheet("أعلى المناطق")!;
    let foundNote = false;
    sheet.eachRow((row) => {
      const value = row.getCell(1).value;
      if (typeof value === "string" && value.includes("500")) foundNote = true;
    });
    expect(foundNote).toBe(true);
  });

  it("adds dedicated comparison worksheets when comparisonData is present", async () => {
    const report = baseReport({
      comparisonData: {
        currentPeriod: { from: new Date("2026-07-08T00:00:00Z"), toExclusive: new Date("2026-07-15T00:00:00Z") },
        previousPeriod: { from: new Date("2026-07-01T00:00:00Z"), toExclusive: new Date("2026-07-08T00:00:00Z") },
        regionTrend: {
          allDates: ["2026-07-08"],
          series: [{ regionName: "منطقة الرياض", points: [{ date: "2026-07-08", count: 3 }] }],
          truncated: false,
          otherSeriesName: null,
        },
        regionChanges: [
          { regionName: "منطقة الرياض", currentCount: 3, previousCount: 1, difference: 2, changeRate: 200, direction: "ارتفاع" },
        ],
        deptClassRises: [
          {
            departmentId: "d1",
            departmentName: "إدارة الرعاية الصحية",
            classificationId: "c1",
            classificationName: "تصنيف الرعاية الصحية",
            currentCount: 5,
            previousCount: 2,
            difference: 3,
            changeRate: 150,
            classificationContribution: 100,
          },
        ],
        deptClassRisesTotal: 1,
        deptClassAllPairs: [],
        executiveSummaryPoints: ["نقطة"],
        warnings: [],
      },
    });
    const { buffer } = await renderReportXlsx(report);
    const workbook = await readBack(buffer);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toContain("اتجاه المناطق");
    expect(sheetNames).toContain("تغير المناطق");
    expect(sheetNames).toContain("ارتفاع الإدارات والتصنيفات");
    // Existing sheets remain intact.
    expect(sheetNames).toContain("الملخص");
    expect(sheetNames).toContain("المؤشرات");
  });

  it("omits comparison worksheets when comparisonData is absent (no regression)", async () => {
    const { buffer } = await renderReportXlsx(baseReport());
    const workbook = await readBack(buffer);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).not.toContain("اتجاه المناطق");
  });

  describe("comparisonModeLabel in summary sheet", () => {
    async function getSummaryFieldValue(report: ReportData, fieldLabel: string): Promise<string | null> {
      const { buffer } = await renderReportXlsx(report);
      const workbook = await readBack(buffer);
      const sheet = workbook.getWorksheet("الملخص")!;
      let found: string | null = null;
      sheet.eachRow((row) => {
        if (row.getCell(1).value === fieldLabel) {
          found = String(row.getCell(2).value ?? "");
        }
      });
      return found;
    }

    it("shows 'لا توجد فترة مقارنة' when no previousPeriod", async () => {
      const value = await getSummaryFieldValue(baseReport({ previousPeriod: undefined }), "نوع المقارنة");
      expect(value).toBe("لا توجد فترة مقارنة");
    });

    it("shows correct label for SAME_PERIOD_LAST_YEAR", async () => {
      const report = baseReport({
        comparisonMode: "SAME_PERIOD_LAST_YEAR",
        previousPeriod: { from: "2025-07-01", to: "2025-07-31" },
      });
      const value = await getSummaryFieldValue(report, "نوع المقارنة");
      expect(value).toBe("الفترة المماثلة من السنة السابقة");
    });

    it("shows correct label for PREVIOUS_EQUIVALENT_PERIOD", async () => {
      const report = baseReport({
        comparisonMode: "PREVIOUS_EQUIVALENT_PERIOD",
        previousPeriod: { from: "2026-06-01", to: "2026-06-30" },
      });
      const value = await getSummaryFieldValue(report, "نوع المقارنة");
      expect(value).toBe("الفترة السابقة المماثلة في المدة");
    });

    it("does not classify undefined comparisonMode as PREVIOUS_EQUIVALENT_PERIOD", async () => {
      const report = baseReport({
        comparisonMode: undefined,
        previousPeriod: { from: "2026-06-01", to: "2026-06-30" },
      });
      const value = await getSummaryFieldValue(report, "نوع المقارنة");
      expect(value).not.toBe("الفترة السابقة المماثلة في المدة");
      expect(value).toBe("وضع المقارنة غير محدد");
    });
  });
});
