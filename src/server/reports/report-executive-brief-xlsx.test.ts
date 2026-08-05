// @vitest-environment node
//
// Tests for the executive brief XLSX sheets.

import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { ReportData, ExecutiveBriefData, FullAnalyticalData } from "./report-data-service";
import type { ReportType } from "@prisma/client";
import { renderReportXlsx } from "./report-xlsx-service";

const BRIEF_SHEETS = [
  "المؤشرات المختصرة",
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
      { classificationId: "class-01", classificationName: "ضوضاء", categoryId: "cat-class-01", categoryName: "فئة", classificationPath: "فئة / ضوضاء", currentCount: 30, previousCount: 25, difference: 5, changeRate: 20.0, shareOfTotal: 30.0 },
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
  let briefBuffer: Buffer;
  let briefWorkbook: ExcelJS.Workbook;

  beforeAll(async () => {
    const result = await renderReportXlsx(makeReport());
    briefBuffer = result.buffer;
    briefWorkbook = await readBack(result.buffer);
  });

  it("produces a valid XLSX buffer", async () => {
    expect(briefBuffer).toBeInstanceOf(Buffer);
    expect(briefBuffer.length).toBeGreaterThan(0);
  });

  it("records the selected report mode in the summary sheet", () => {
    const summary = briefWorkbook.getWorksheet("الملخص")!;
    const values = summary.getSheetValues().flat();

    expect(values).toContain("نمط التقرير");
    expect(values).toContain("DIGITAL_EXECUTIVE_BRIEF");
  });

  it.each(BRIEF_SHEETS)("includes %s sheet", (sheetName) => {
    const names = sheetNames(briefWorkbook);
    expect(names.some((n) => n.includes(sheetName))).toBe(true);
  });

  it.each([
    ["المؤشرات المختصرة", 3],
    ["جميع المناطق", 3],
    ["الاتجاه الزمني المقارن", 3],
  ] as const)("%s has %i rows including its header", (sheetName, rowCount) => {
    const sheet = briefWorkbook.worksheets.find((ws) => ws.name.includes(sheetName));
    expect(sheet).toBeDefined();
    expect(sheet!.rowCount).toBe(rowCount);
  });

  it("no brief sheets when briefData is absent", async () => {
    const report = makeReport(false);
    const result = await renderReportXlsx(report);
    const wb = await readBack(result.buffer);
    const names = sheetNames(wb);
    expect(names.some((n) => n.includes("المؤشرات المختصرة"))).toBe(false);
    expect(names.some((n) => n.includes("جميع المناطق"))).toBe(false);
  });

  it("التركز has correct column headers", async () => {
    const sheet = briefWorkbook.worksheets.find((ws) => ws.name.includes("التركز"));
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
    const sheet = briefWorkbook.worksheets.find((ws) => ws.name.includes("المؤشرات المختصرة"));
    expect(sheet).toBeDefined();
    const headerRow = sheet!.getRow(1);
    const headers = [1, 2, 3, 4, 5, 6].map((col) => headerRow.getCell(col).value as string);
    expect(headers).toContain("التقييم");
  });

  it("all regions sheet has 9 columns", async () => {
    const sheet = briefWorkbook.worksheets.find((ws) => ws.name.includes("جميع المناطق"));
    expect(sheet).toBeDefined();
    const headerRow = sheet!.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((cell) => {
      if (cell.value) headers.push(String(cell.value));
    });
    expect(headers).toHaveLength(9);
  });

  it("keeps missing numeric values empty instead of writing text placeholders", async () => {
    const report = makeReport();
    const briefData = makeBriefData();
    briefData.briefKpis[1] = {
      ...briefData.briefKpis[1],
      previousValue: null,
      difference: null,
      changeRate: null,
    };
    briefData.allRegions[1] = {
      ...briefData.allRegions[1],
      changeRate: null,
      complianceRate: null,
      averageResolutionDays: null,
    };
    briefData.topClassifications[0] = {
      ...briefData.topClassifications[0],
      changeRate: null,
    };
    report.briefData = briefData;

    const result = await renderReportXlsx(report);
    const workbook = await readBack(result.buffer);
    const kpiRow = workbook.getWorksheet("المؤشرات المختصرة")!.getRow(3);
    expect(kpiRow.getCell(2).value).toBeTypeOf("number");
    expect(kpiRow.getCell(3).value).toBeNull();
    expect(kpiRow.getCell(4).value).toBeNull();
    expect(kpiRow.getCell(5).value).toBeNull();

    const regionRow = workbook.getWorksheet("جميع المناطق")!.getRow(3);
    expect(regionRow.getCell(5).value).toBeNull();
    expect(regionRow.getCell(6).value).toBeNull();
    expect(regionRow.getCell(7).value).toBeNull();

    const classificationRow = workbook.getWorksheet("أبرز التصنيفات")!.getRow(2);
    expect(classificationRow.getCell(5).value).toBeNull();
  });

  it("distinguishes a real zero from a missing previous timeline", async () => {
    const report = makeReport();
    const briefData = makeBriefData();
    briefData.comparativeTimeline = {
      current: { label: "الفترة الحالية", points: [{ relativeDay: 1, count: 0 }] },
      previous: null,
      periodDays: 1,
    };
    report.briefData = briefData;

    const result = await renderReportXlsx(report);
    const workbook = await readBack(result.buffer);
    const timelineRow = workbook.getWorksheet("الاتجاه الزمني المقارن")!.getRow(2);
    expect(timelineRow.getCell(2).value).toBe(0);
    expect(timelineRow.getCell(3).value).toBeNull();
  });

  it("isolates a failed brief sheet and writes its warning to the summary", async () => {
    const report = makeReport();
    const briefData = makeBriefData();
    Object.defineProperty(briefData, "allRegions", {
      configurable: true,
      get: () => {
        throw new Error("internal builder failure");
      },
    });
    report.briefData = briefData;

    const result = await renderReportXlsx(report);
    const expectedWarning = "تعذر إنشاء ورقة البيانات الإضافية (all_regions).";
    expect(result.warnings).toContain(expectedWarning);

    const workbook = await readBack(result.buffer);
    const names = sheetNames(workbook);
    expect(names).toContain("جميع المناطق");
    expect(names).toContain("أبرز التصنيفات");
    expect(names).toContain("التركز");

    const summaryValues: string[] = [];
    workbook.getWorksheet("الملخص")!.eachRow((row) => {
      row.eachCell((cell) => summaryValues.push(String(cell.value ?? "")));
    });
    expect(summaryValues).toContain(expectedWarning);
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
  let fullWorkbook: ExcelJS.Workbook;

  beforeAll(async () => {
    const result = await renderReportXlsx(makeReport(true, "FULL_ANALYTICAL"));
    fullWorkbook = await readBack(result.buffer);
  });

  it.each(FULL_ANALYTICAL_SHEETS)("includes %s sheet", (sheetName) => {
    const names = sheetNames(fullWorkbook);
    expect(names.some((n) => n.includes(sheetName))).toBe(true);
  });

  it.each([
    ["صافي التدفق", 5],
    ["الأداء والحجم", 3],
    ["الاستمرارية", 3],
  ] as const)("%s has %i rows including its header", (sheetName, rowCount) => {
    const sheet = fullWorkbook.worksheets.find((ws) => ws.name.includes(sheetName));
    expect(sheet).toBeDefined();
    expect(sheet!.rowCount).toBe(rowCount);
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

  it("omits the continuity sheet when no reference timeline is available", async () => {
    const report = makeReport(true, "FULL_ANALYTICAL");
    const fullData = report.briefData as FullAnalyticalData;
    fullData.comparativeTimeline.previous = null;
    fullData.continuityRows = [];

    const result = await renderReportXlsx(report);
    const workbook = await readBack(result.buffer);

    expect(sheetNames(workbook)).not.toContain("الاستمرارية");
    expect(sheetNames(workbook)).toContain("صافي التدفق");
    expect(sheetNames(workbook)).toContain("الأداء والحجم");
  });
});
