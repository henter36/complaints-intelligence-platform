import fs from "node:fs/promises";
import path from "node:path";
import { ReportType } from "@prisma/client";
import type { ExecutiveBriefData, FullAnalyticalData, ReportData } from "@/server/reports/report-data-service";
import { renderExecutiveBriefPdf } from "@/server/reports/report-executive-brief-pdf-service";
import { renderReportPdf } from "@/server/reports/report-pdf-service";

const outputDir = path.join(process.cwd(), "output/pdf");

const briefData: ExecutiveBriefData = {
  briefKpis: [
    { key: "total", label: "إجمالي الشكاوى", value: 3, previousValue: 1, difference: 2, changeRate: 200, format: "number", assessment: "negative" },
    { key: "open", label: "المفتوحة أو تحت الإجراء", value: 2, previousValue: 1, difference: 1, changeRate: 100, format: "number", assessment: "negative" },
    { key: "closed", label: "المغلقة", value: 1, previousValue: 0, difference: 1, changeRate: null, format: "number", assessment: "positive" },
    { key: "currentlyLate", label: "المتأخرة حاليًا", value: 1, previousValue: 0, difference: 1, changeRate: null, format: "number", assessment: "negative" },
    { key: "complianceRate", label: "نسبة الالتزام بالمهلة", value: 100, previousValue: 90, difference: 10, changeRate: 11.1, format: "percent", assessment: "positive" },
    { key: "averageResolutionDays", label: "متوسط زمن الإغلاق", value: 8, previousValue: 10, difference: -2, changeRate: -20, format: "days", assessment: "positive" },
    { key: "highPriorityOpen", label: "عالية الأولوية المفتوحة", value: 1, previousValue: 0, difference: 1, changeRate: null, format: "number", assessment: "warning" },
  ],
  allRegions: [
    { regionName: "الرياض", currentCount: 2, previousCount: 0, difference: 2, changeRate: null, complianceRate: 100, averageResolutionDays: 8, currentlyLate: 1, direction: "ارتفاع" },
    { regionName: "مكة المكرمة", currentCount: 1, previousCount: 0, difference: 1, changeRate: null, complianceRate: 100, averageResolutionDays: null, currentlyLate: 0, direction: "ارتفاع" },
    { regionName: "المنطقة الشرقية", currentCount: 0, previousCount: 1, difference: -1, changeRate: -100, complianceRate: null, averageResolutionDays: null, currentlyLate: 0, direction: "انخفاض" },
  ],
  topClassifications: [
    { classificationId: "c1", classificationName: "طلب نقل", currentCount: 2, previousCount: 0, difference: 2, changeRate: null, shareOfTotal: 66.7 },
    { classificationId: "c2", classificationName: "طلب علاج", currentCount: 1, previousCount: 0, difference: 1, changeRate: null, shareOfTotal: 33.3 },
    { classificationId: "c3", classificationName: "خدمات تشغيلية", currentCount: 0, previousCount: 1, difference: -1, changeRate: -100, shareOfTotal: 0 },
  ],
  comparativeTimeline: {
    current: { label: "الفترة الحالية", points: [{ relativeDay: 1, count: 1 }, { relativeDay: 2, count: 2 }] },
    previous: { label: "الفترة السابقة", points: [{ relativeDay: 1, count: 1 }, { relativeDay: 2, count: 0 }] },
    periodDays: 2,
  },
  concentrationBands: [
    { entityType: "classification", top1SharePercent: 66.7, top3SharePercent: 100, top5SharePercent: 100, totalEntities: 3 },
  ],
};

function baseReport(mode: "DIGITAL_EXECUTIVE_BRIEF" | "PRINT_EXECUTIVE_BRIEF"): ReportData {
  return {
    type: ReportType.EXECUTIVE_SUMMARY,
    title: mode === "DIGITAL_EXECUTIVE_BRIEF"
      ? "تقرير تنفيذي مختصر — عرض رقمي"
      : "تقرير تنفيذي مختصر — طباعة",
    generatedAt: "2026-08-02T08:00:00.000Z",
    period: { from: "2026-07-01", to: "2026-07-31" },
    previousPeriod: { from: "2026-06-01", to: "2026-06-30" },
    reportRunId: "run-review-001",
    filters: { from: "2026-07-01", to: "2026-07-31" },
    kpis: {} as ReportData["kpis"],
    sections: [{
      id: "executive_summary",
      kind: "text",
      title: "الملخص التنفيذي",
      points: [
        "ارتفع إجمالي الشكاوى من شكوى واحدة إلى ثلاث شكاوى.",
        "تركز الارتفاع في الرياض ومكة المكرمة.",
        "تحتاج الشكوى المتأخرة إلى متابعة تنفيذية مباشرة.",
        "يمثل الحفاظ على الالتزام الكامل بالمهلة فرصة لتعزيز الأداء.",
      ],
    }],
    warnings: [],
    rowCount: 0,
    reportMode: mode,
    briefData,
    comparisonData: {
      currentPeriod: { from: new Date("2026-07-01"), toExclusive: new Date("2026-08-01") },
      previousPeriod: { from: new Date("2026-06-01"), toExclusive: new Date("2026-07-01") },
      regionTrend: { allDates: [], series: [], truncated: false, otherSeriesName: null },
      regionChanges: briefData.allRegions.map((row) => ({
        regionName: row.regionName,
        currentCount: row.currentCount,
        previousCount: row.previousCount,
        difference: row.difference,
        changeRate: row.changeRate,
        direction: row.difference > 0 ? "ارتفاع" : "انخفاض",
      })),
      deptClassRises: [{
        departmentId: "d1", departmentName: "إدارة المتابعة", classificationId: "c1",
        classificationName: "طلب نقل", currentCount: 2, previousCount: 0,
        difference: 2, changeRate: null, classificationContribution: 100,
      }],
      deptClassRisesTotal: 1,
      deptClassAllPairs: [],
      executiveSummaryPoints: [],
      warnings: [],
    },
  };
}

function fullReport(): ReportData {
  const fullData: FullAnalyticalData = {
    ...briefData,
    netBacklogFlow: { inflow: 3, outflow: 1, net: 2, periodDays: 31 },
    perfVolumeRows: briefData.allRegions.map((row) => ({
      entityName: row.regionName,
      totalComplaints: row.currentCount,
      complianceRate: row.complianceRate,
      averageResolutionDays: row.averageResolutionDays,
      currentlyLate: row.currentlyLate,
      share: row.currentCount / 3 * 100,
    })),
    continuityRows: [{
      departmentName: "إدارة المتابعة", classificationName: "طلب نقل",
      currentCount: 2, previousCount: 1, appearsInBothPeriods: true, recurrenceType: "persistent",
    }],
  };
  const base = baseReport("DIGITAL_EXECUTIVE_BRIEF");
  return {
    ...base,
    title: "التقرير التحليلي الكامل",
    reportMode: "FULL_ANALYTICAL",
    briefData: fullData,
    sections: [
      { id: "kpis", kind: "kpi", title: "المؤشرات الرئيسية", cards: [
        { key: "total", label: "إجمالي الشكاوى", value: 3, format: "number" },
        { key: "late", label: "المتأخرة", value: 1, format: "number" },
      ] },
      { id: "summary", kind: "text", title: "الملخص التنفيذي", points: ["قراءة تحليلية موسعة للفترة المحددة."] },
      { id: "regions", kind: "table", title: "مقارنة المناطق", table: {
        id: "regions", title: "مقارنة المناطق",
        columns: [
          { key: "regionName", label: "المنطقة", format: "text" },
          { key: "currentCount", label: "الحالي", format: "number" },
          { key: "previousCount", label: "السابق", format: "number" },
        ],
        rows: briefData.allRegions,
        truncated: false,
        totalMatched: briefData.allRegions.length,
      } },
    ],
  };
}

async function main(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  const digital = await renderExecutiveBriefPdf(baseReport("DIGITAL_EXECUTIVE_BRIEF"), "DIGITAL_EXECUTIVE_BRIEF");
  const print = await renderExecutiveBriefPdf(baseReport("PRINT_EXECUTIVE_BRIEF"), "PRINT_EXECUTIVE_BRIEF");
  const full = await renderReportPdf(fullReport());
  await Promise.all([
    fs.writeFile(path.join(outputDir, "digital-executive-brief.pdf"), digital.buffer),
    fs.writeFile(path.join(outputDir, "print-executive-brief.pdf"), print.buffer),
    fs.writeFile(path.join(outputDir, "full-analytical-report.pdf"), full.buffer),
  ]);
  process.stdout.write(`${outputDir}\n`);
}

void main();
