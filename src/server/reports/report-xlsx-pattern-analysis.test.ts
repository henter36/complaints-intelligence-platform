// @vitest-environment node
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { ReportData, ExecutiveBriefData } from "./report-data-service";
import { renderReportXlsx } from "./report-xlsx-service";
import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";
import type { PeriodChangeDigest } from "@/lib/analytics/period-change-digest";

const PATTERN_SHEETS = ["الملاحظات التحليلية", "التغير منذ الفترة السابقة", "التكرار", "الانتشار", "التركيز", "السلاسل الزمنية"] as const;

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: overrides.id ?? "f",
    type: "CHRONIC_ISSUE",
    entityType: "CLASSIFICATION",
    entityId: "cls-1",
    entityName: "=DANGEROUS سجن — التغذية",
    currentValue: 46,
    previousValue: 43,
    difference: 3,
    changeRate: 7,
    severity: "HIGH",
    priorityScore: 80,
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: "مشكلة مزمنة بسبب: استمرار 5 فترات",
    supportingMetrics: {
      streakPeriods: 5,
      repeatRatePercent: 18.4,
      facilitySharePercent: 29,
      distinctComplainants: 8,
      periodCounts: JSON.stringify([8, 9, 8, 9, 46]),
      priorityReasons: JSON.stringify(["استمرار 5 فترات"]),
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: { facility: "سجن أ", classificationId: "cls-1" },
    firstDetectedAt: "2026-01-31T00:00:00.000Z",
    lastDetectedAt: "2026-01-31T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

const EMPTY_DIGEST: PeriodChangeDigest = {
  newProblems: [{ key: "k1", facility: "سجن أ", classificationLabel: "التغذية", pattern: "EMERGING", priorityBand: "MEDIUM" }],
  continuingProblems: [],
  worsenedProblems: [{ key: "k2", facility: "سجن ب", classificationLabel: "الاتصال", from: "MEDIUM", to: "HIGH" }],
  relapsedProblems: [],
  improvedFacilities: [],
  exitedPriorityList: [],
  newlySpreadingClassifications: ["الرعاية الصحية"],
};

function makeBriefData(
  patternAnalysis?: Omit<NonNullable<ExecutiveBriefData["patternAnalysis"]>, "facilityCurrentPeriodTotals">
): ExecutiveBriefData {
  return {
    briefKpis: [],
    allRegions: [],
    topClassifications: [],
    comparativeTimeline: { current: { label: "current", points: [] }, previous: null, periodDays: 30 },
    concentrationBands: [],
    patternAnalysis: patternAnalysis ? { ...patternAnalysis, facilityCurrentPeriodTotals: {} } : undefined,
  };
}

function makeReport(briefData: ExecutiveBriefData): ReportData {
  return {
    type: "EXECUTIVE_SUMMARY",
    title: "تقرير",
    generatedAt: new Date("2026-07-31T04:00:00Z").toISOString(),
    period: { from: "2026-07-01", to: "2026-07-31" },
    filters: { from: "2026-07-01", to: "2026-07-31" },
    kpis: {} as unknown as ReportData["kpis"],
    warnings: [],
    rowCount: 0,
    sections: [],
    reportMode: "DIGITAL_EXECUTIVE_BRIEF",
    briefData,
  };
}

async function readBack(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook;
}

describe("XLSX pattern-analysis sheets", () => {
  it("adds every pattern-analysis sheet when findings are present", async () => {
    const chronic = finding({});
    const repeat = finding({
      id: "repeat-1",
      type: "REPEAT_COMPLAINANT",
      entityType: "FACILITY",
      entityName: "سجن أ",
      supportingMetrics: {
        repeatEntries: JSON.stringify([{ anonymizedComplainant: "مشتكٍ-abc123", topicLabel: "التغذية", complaintCount: 5, periodsSpanned: 3 }]),
      },
    });
    const spread = finding({
      id: "spread-1",
      type: "CROSS_FACILITY_SPREAD",
      entityType: "CLASSIFICATION",
      entityName: "الرعاية الصحية",
      supportingMetrics: { topContributingFacilities: JSON.stringify(["سجن أ", "سجن ب", "سجن ج"]) },
    });
    const wing = finding({ id: "wing-1", type: "WING_CONCENTRATION", entityName: "سجن أ — التغذية" });

    const { buffer } = await renderReportXlsx(
      makeReport(
        makeBriefData({
          findings: [chronic, repeat, spread, wing],
          periodChangeDigest: EMPTY_DIGEST,
          periods: [{ from: "2026-01-01", to: "2026-01-31" }],
        })
      )
    );
    const workbook = await readBack(buffer);
    for (const sheetName of PATTERN_SHEETS) {
      expect(workbook.getWorksheet(sheetName)).toBeDefined();
    }
  });

  it("neutralizes formula-injection characters in facility/entity names", async () => {
    const { buffer } = await renderReportXlsx(
      makeReport(makeBriefData({ findings: [finding({})], periodChangeDigest: EMPTY_DIGEST, periods: [] }))
    );
    const workbook = await readBack(buffer);
    const sheet = workbook.getWorksheet("الملاحظات التحليلية")!;
    const facilityCell = String(sheet.getRow(2).getCell(2).value);
    expect(facilityCell.startsWith("=")).toBe(false);
  });

  it("expands anonymized repeat entries into individual rows without exposing raw identifiers", async () => {
    const repeat = finding({
      id: "repeat-1",
      type: "REPEAT_COMPLAINANT",
      entityType: "FACILITY",
      entityName: "سجن أ",
      supportingMetrics: {
        repeatEntries: JSON.stringify([{ anonymizedComplainant: "مشتكٍ-abc123", topicLabel: "التغذية", complaintCount: 5, periodsSpanned: 3 }]),
      },
    });
    const { buffer } = await renderReportXlsx(
      makeReport(makeBriefData({ findings: [repeat], periodChangeDigest: EMPTY_DIGEST, periods: [] }))
    );
    const workbook = await readBack(buffer);
    const sheet = workbook.getWorksheet("التكرار")!;
    const complainantCell = String(sheet.getRow(2).getCell(4).value);
    expect(complainantCell).toBe("مشتكٍ-abc123");
    expect(complainantCell).not.toMatch(/^\d{5,}$/); // never a raw numeric identifier
  });

  it("builds one timeline row per period from periodCounts, reusing the shared periods list", async () => {
    const { buffer } = await renderReportXlsx(
      makeReport(
        makeBriefData({
          findings: [finding({})],
          periodChangeDigest: EMPTY_DIGEST,
          periods: [
            { from: "2025-09-01", to: "2025-09-30" },
            { from: "2025-10-01", to: "2025-10-31" },
            { from: "2025-11-01", to: "2025-11-30" },
            { from: "2025-12-01", to: "2025-12-31" },
            { from: "2026-01-01", to: "2026-01-31" },
          ],
        })
      )
    );
    const workbook = await readBack(buffer);
    const sheet = workbook.getWorksheet("السلاسل الزمنية")!;
    expect(sheet.rowCount).toBe(6); // header + 5 periods
    expect(sheet.getRow(6).getCell(5).value).toBe(46); // last period's count
  });

  it("omits every pattern-analysis sheet when there is no pattern analysis at all", async () => {
    const { buffer } = await renderReportXlsx(makeReport(makeBriefData(undefined)));
    const workbook = await readBack(buffer);
    for (const sheetName of PATTERN_SHEETS) {
      expect(workbook.getWorksheet(sheetName)).toBeUndefined();
    }
  });

  it("omits the sheets when patternAnalysis has no findings, without failing the export", async () => {
    const { buffer, warnings } = await renderReportXlsx(
      makeReport(makeBriefData({ findings: [], periodChangeDigest: EMPTY_DIGEST, periods: [] }))
    );
    const workbook = await readBack(buffer);
    for (const sheetName of PATTERN_SHEETS) {
      expect(workbook.getWorksheet(sheetName)).toBeUndefined();
    }
    expect(warnings).toEqual([]);
  });
});
