// @vitest-environment node
//
// Tests for the executive brief XLSX sheets.

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { ReportData, ExecutiveBriefData, FullAnalyticalData } from "./report-data-service";
import type { ReportType } from "@prisma/client";
import { renderReportXlsx } from "./report-xlsx-service";

const BRIEF_SHEETS = [
  "المؤشرات التنفيذية",
  "جميع المناطق",
  "أبرز التصنيفات",
  "الاتجاه الزمني المقارن",
  "التركز",
] as const;

function makeBriefData(): ExecutiveBriefData {
  return {
    briefKpis: [
      { key: "total", label: "إجمالي الشكاوى", value: 100, previousValue: 80, difference: 20, changeRate: 25.0, format: "number", assessment: "neutral" },
      { key: "open", label: "المفتوحة", value: 30, previousValue: 25, difference: 5, changeRate: 20.0, format: "number", assessment: "negative" },
    ],
    allRegions: [
      { regionName: "الرياض", currentCount: 40, previousCount: 30, difference: 10, changeRate: 33.3, complianceRate: 96.4, averageResolutionDays: 3.2, currentlyLate: 3, direction: "↑ ارتفاع" },
      { regionName: "جدة", currentCount: 30, previousCount: 35, difference: -5, changeRate: -14.3, complianceRate: 95.0, averageResolutionDays: 3.5, currentlyLate: 2, direction: "↓ انخفاض" },
    ],
    topClassifications: [
      { classificationId: "class-01", classificationName: "ضوضاء", categoryName: "بيئة", currentCount: 30, previousCount: 25, difference: 5, changeRate: 20.0, shareOfTotal: 30.0 },
    ],
    comparativeTimeline: {
      current: {
        label: "الفترة الحالية",
        points: [
          { relativeDay: 1, count: 12 },
          { relativeDay: 2, count: 15 },
        ],
      },
      previous: {
        label: "الفترة السابقة",
        points: [
          { relativeDay: 1, count: 10 },
          { relativeDay: 2, count: 12 },
        ],
      },
      periodDays: 2,
    },
    concentrationBands: [
      { entityType: "region", top1SharePercent: 40.0, top3SharePercent: 90.0, top5SharePercent: 100.0, totalEntities: 2 },
    ],
  };
}

function makeFullAnalyticalData(): FullAnalyticalData {
  return {
    ...makeBriefData(),
    netBacklogFlow: { inflow: 45, outflow: 30, net: 15, periodDays: 7 },
    perfVolumeRows: [
      { entityName: "الصحة", totalComplaints: 45, complianceRate: 93.5, averageResolutionDays: 3.8, currentlyLate: 4, share: 45.0 },
      { entityName: "التعليم", totalComplaints: 35, complianceRate: 95.8, averageResolutionDays: 3.2, currentlyLate: 2, share: 35.0 },
    ],
    continuityRows: [
      { departmentName: "الصحة", classificationName: "ضوضاء", currentCount: 15, previousCount: 10, appearsInBothPeriods: true, recurrenceType: "persistent" },
      { departmentName: "التعليم", classificationName: "مخلفات", currentCount: 5, previousCount: 0, appearsInBothPeriods: false, recurrenceType: "new" },
    ],
  };
}

function makeReport(withBriefData = true, mode: "DIGITAL_EXECUTIVE_BRIEF" | "FULL_ANALYTICAL" = "DIGITAL_EXECUTIVE_BRIEF"): ReportData {
  return {
    type: "EXECUTIVE_SUMMARY" as ReportType,
    title: "تقرير تنفيذي مختصر",
    generatedAt: new Date("2026-07-31T04:00:00Z").toISOString(),
    period: { from: "2026-07-01", to: "2026-07-07" },
    filters: { from: "2026-07-01", to: "2026-07-07" },
    kpis: {
      totalComplaints: { currentValue: 100, previousValue: 80, absoluteChange: 20, percentageChange: 25, trend: "up", direction: "neutral" },
    } as unknown as ReportData["kpis"],
    sections: [],
    warnings: [],
    rowCount: 0,
    reportMode: mode,
    briefData: withBriefData
      ? (mode === "FULL_ANALYTICAL" ? makeFullAnalyticalData() : makeBriefData())
      : undefined,
  };
}

async function readBack(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook;
}

function sheetNames(workbook: ExcelJS.Workbook): string[] {
  const names: string[] = [];
  workbook.eachSheet((ws) => names.push(ws.name));
  return names;
}

// ---------------------------------------------------------------------------
// Basic structure tests
// ---------------------------------------------------------------------------

describe("renderReportXlsx — executive brief mode", () => {
  it("produces a valid XLSX buffer", async () => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it.each(BRIEF_SHEETS)("includes %s sheet", async (sheetName) => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const names = sheetNames(wb);
    expect(names.some((n) => n.includes(sheetName))).toBe(true);
  });

  it("المؤشرات التنفيذية has correct number of data rows", async () => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("المؤشرات التنفيذية"));
    expect(sheet).toBeDefined();
    // 1 header row + 2 KPI cards = 3 rows total
    expect(sheet!.rowCount).toBe(3);
  });

  it("جميع المناطق has correct number of data rows", async () => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("جميع المناطق"));
    expect(sheet).toBeDefined();
    // 1 header row + 2 region rows = 3 rows
    expect(sheet!.rowCount).toBe(3);
  });

  it("الاتجاه الزمني المقارن has correct number of timeline rows", async () => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("الاتجاه الزمني المقارن"));
    expect(sheet).toBeDefined();
    // 1 header + 2 days = 3 rows
    expect(sheet!.rowCount).toBe(3);
  });

  it("no brief sheets when briefData is absent", async () => {
    const report = makeReport(false);
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const names = sheetNames(wb);
    expect(names.some((n) => n.includes("المؤشرات التنفيذية"))).toBe(false);
    expect(names.some((n) => n.includes("جميع المناطق"))).toBe(false);
  });

  it("التركز has correct column headers", async () => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("التركز"));
    expect(sheet).toBeDefined();
    const headerRow = sheet!.getRow(1);
    const headers = [1, 2, 3, 4, 5].map((col) => headerRow.getCell(col).value as string);
    expect(headers[0]).toBe("البُعد");
    expect(headers[1]).toBe("حصة أعلى 1%");
    expect(headers[2]).toBe("حصة أعلى 3%");
    expect(headers[3]).toBe("حصة أعلى 5%");
    expect(headers[4]).toBe("إجمالي الكيانات");
  });

  it("brief KPIs sheet includes assessment column", async () => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("المؤشرات التنفيذية"));
    expect(sheet).toBeDefined();
    const headerRow = sheet!.getRow(1);
    const headers = [1, 2, 3, 4, 5, 6].map((col) => headerRow.getCell(col).value as string);
    expect(headers).toContain("التقييم");
  });

  it("all regions sheet has 9 columns", async () => {
    const report = makeReport();
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("جميع المناطق"));
    expect(sheet).toBeDefined();
    const headerRow = sheet!.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((cell) => {
      if (cell.value) headers.push(String(cell.value));
    });
    expect(headers.length).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// FULL_ANALYTICAL XLSX tests
// ---------------------------------------------------------------------------

const FULL_ANALYTICAL_SHEETS = [
  "صافي التدفق",
  "الأداء والحجم",
  "الاستمرارية",
] as const;

describe("renderReportXlsx — FULL_ANALYTICAL mode", () => {
  it.each(FULL_ANALYTICAL_SHEETS)("includes %s sheet", async (sheetName) => {
    const report = makeReport(true, "FULL_ANALYTICAL");
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const names = sheetNames(wb);
    expect(names.some((n) => n.includes(sheetName))).toBe(true);
  });

  it("صافي التدفق has 4 data rows (inflow, outflow, net, periodDays)", async () => {
    const report = makeReport(true, "FULL_ANALYTICAL");
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("صافي التدفق"));
    expect(sheet).toBeDefined();
    // 1 header row + 4 data rows
    expect(sheet!.rowCount).toBe(5);
  });

  it("الأداء والحجم has correct number of data rows", async () => {
    const report = makeReport(true, "FULL_ANALYTICAL");
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("الأداء والحجم"));
    expect(sheet).toBeDefined();
    // 1 header row + 2 perf rows
    expect(sheet!.rowCount).toBe(3);
  });

  it("الاستمرارية has correct number of data rows", async () => {
    const report = makeReport(true, "FULL_ANALYTICAL");
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const sheet = wb.worksheets.find((ws) => ws.name.includes("الاستمرارية"));
    expect(sheet).toBeDefined();
    // 1 header row + 2 continuity rows
    expect(sheet!.rowCount).toBe(3);
  });

  it("does NOT include FULL_ANALYTICAL sheets when mode is DIGITAL_EXECUTIVE_BRIEF", async () => {
    const report = makeReport(true, "DIGITAL_EXECUTIVE_BRIEF");
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const names = sheetNames(wb);
    expect(names.some((n) => n.includes("صافي التدفق"))).toBe(false);
    expect(names.some((n) => n.includes("الأداء والحجم"))).toBe(false);
    expect(names.some((n) => n.includes("الاستمرارية"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reportMode option schema tests
// ---------------------------------------------------------------------------

describe("reportOptionsSchema — reportMode field", () => {
  it("accepts valid reportMode values", async () => {
    const { reportOptionsSchema } = await import("./report-definition-service");
    for (const mode of ["DIGITAL_EXECUTIVE_BRIEF", "FULL_ANALYTICAL", "PRINT_EXECUTIVE_BRIEF"]) {
      const result = reportOptionsSchema.safeParse({ reportMode: mode });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an invalid reportMode value", async () => {
    const { reportOptionsSchema } = await import("./report-definition-service");
    const result = reportOptionsSchema.safeParse({ reportMode: "INVALID_MODE" });
    expect(result.success).toBe(false);
  });

  it("allows reportMode to be absent", async () => {
    const { reportOptionsSchema } = await import("./report-definition-service");
    const result = reportOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reportMode).toBeUndefined();
    }
  });
});
