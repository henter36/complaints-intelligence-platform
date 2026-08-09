import fs from "node:fs/promises";
import path from "node:path";
import { ReportType } from "@prisma/client";
import type { ExecutiveBriefData, ExecutiveBriefV2Data, FullAnalyticalData, ReportData } from "@/server/reports/report-data-service";
import { renderExecutiveBriefPdf } from "@/server/reports/report-executive-brief-pdf-service";
import { renderReportPdf } from "@/server/reports/report-pdf-service";
import { renderExecutiveBriefV2Pdf } from "@/server/reports/report-executive-brief-v2-pdf-service";
import { assertTrendEndsAtOrBeforeReportEnd } from "@/server/reports/report-monthly-trend-sanitize";

const outputDir = path.join(process.cwd(), "output/pdf");

const briefData: ExecutiveBriefData = {
  briefKpis: [
    { key: "total", label: "إجمالي الشكاوى", value: 3, previousValue: 1, difference: 2, changeRate: 200, format: "number", assessment: "negative" },
    { key: "open", label: "المفتوحة أو تحت الإجراء", value: 2, previousValue: 1, difference: 1, changeRate: 100, format: "number", assessment: "negative" },
    { key: "closed", label: "المغلقة", value: 1, previousValue: 0, difference: 1, changeRate: null, format: "number", assessment: "positive" },
    { key: "currentlyLate", label: "المتأخرة حاليًا", value: 1, previousValue: 0, difference: 1, changeRate: null, format: "number", assessment: "negative" },
    { key: "complianceRate", label: "نسبة الالتزام بالمهلة", value: 100, previousValue: 90, difference: 10, changeRate: 11.1, format: "percent", assessment: "positive" },
    { key: "averageResolutionDays", label: "متوسط زمن الإغلاق", value: 8, previousValue: 10, difference: -2, changeRate: -20, format: "days", assessment: "positive" },
    { key: "closedLate", label: "المغلقة بعد المهلة", value: 0, previousValue: 0, difference: 0, changeRate: 0, format: "number", assessment: "neutral" },
    { key: "netChange", label: "صافي التغير", value: 2, previousValue: null, difference: null, changeRate: null, format: "number", assessment: "neutral" },
  ],
  allRegions: [
    { regionName: "منطقة الرياض", currentCount: 2, previousCount: 0, difference: 2, changeRate: null, complianceRate: 100, averageResolutionDays: 8, openCount: 1, closedCount: 1, currentlyLate: 1, direction: "ارتفاع" },
    { regionName: "منطقة مكة المكرمة", currentCount: 1, previousCount: 0, difference: 1, changeRate: null, complianceRate: null, averageResolutionDays: null, openCount: 1, closedCount: 0, currentlyLate: 0, direction: "ارتفاع" },
    { regionName: "المنطقة الشرقية", currentCount: 0, previousCount: 1, difference: -1, changeRate: -100, complianceRate: null, averageResolutionDays: null, openCount: 0, closedCount: 0, currentlyLate: 0, direction: "انخفاض" },
  ],
  topClassifications: [
    { classificationId: "c1", classificationName: "طلب نقل", categoryId: "cat1", categoryName: "الخدمات", classificationPath: "الخدمات / طلب نقل", currentCount: 2, previousCount: 0, difference: 2, changeRate: null, shareOfTotal: 66.7 },
    { classificationId: "c2", classificationName: "طلب علاج", categoryId: "cat1", categoryName: "الخدمات", classificationPath: "الخدمات / طلب علاج", currentCount: 1, previousCount: 0, difference: 1, changeRate: null, shareOfTotal: 33.3 },
    { classificationId: "c3", classificationName: "خدمات تشغيلية", categoryId: "cat1", categoryName: "الخدمات", classificationPath: "الخدمات / خدمات تشغيلية", currentCount: 0, previousCount: 1, difference: -1, changeRate: -100, shareOfTotal: 0 },
  ],
  comparativeTimeline: {
    current: { label: "الفترة الحالية", points: [{ relativeDay: 1, count: 1 }, { relativeDay: 2, count: 2 }] },
    previous: { label: "الفترة السابقة", points: [{ relativeDay: 1, count: 1 }, { relativeDay: 2, count: 0 }] },
    periodDays: 2,
  },
  concentrationBands: [
    { entityType: "classification", top1SharePercent: 66.7, top3SharePercent: 100, top5SharePercent: 100, totalEntities: 3 },
  ],
  topDepartments: [
    { name: "إدارة المتابعة", total: 2, open: 1, closed: 1, currentlyLate: 1, shareOfTotal: 66.7 },
    { name: "إدارة الخدمات", total: 1, open: 1, closed: 0, currentlyLate: 0, shareOfTotal: 33.3 },
  ],
  conclusions: [
    "منطقة الرياض الأعلى حجماً بعدد شكويين وتمثل 66.7% من الإجمالي.",
    "أعلى زيادة مطلقة في منطقة الرياض: شكويان.",
  ],
  notes: ["شكوى واحدة بلا موعد مستهدف ولا تدخل في مقام الالتزام."],
};

function baseReport(mode: "DIGITAL_EXECUTIVE_BRIEF" | "PRINT_EXECUTIVE_BRIEF" | "PRINT_EXECUTIVE_BRIEF_V2"): ReportData {
  return {
    type: ReportType.EXECUTIVE_SUMMARY,
    title: "تقرير الشكاوى",
    generatedAt: "2026-08-02T08:00:00.000Z",
    period: { from: "2026-07-01", to: "2026-07-31" },
    previousPeriod: { from: "2026-06-01", to: "2026-06-30" },
    filters: { from: "2026-07-01", to: "2026-07-31" },
    kpis: {} as ReportData["kpis"],
    sections: [{
      id: "executive_summary",
      kind: "text",
      title: "الملخص",
      points: [
        "ارتفع إجمالي الشكاوى من شكوى واحدة إلى ثلاث شكاوى.",
        "تركز الارتفاع في الرياض ومكة المكرمة.",
        "توجد شكوى متأخرة حاليًا.",
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
      currentTotal: briefData.allRegions.reduce((s, r) => s + r.currentCount, 0),
      previousTotal: briefData.allRegions.reduce((s, r) => s + r.previousCount, 0),
      regionTrend: { allDates: [], series: [], truncated: false, otherSeriesName: null },
      regionChanges: briefData.allRegions.map((row) => ({
        regionName: row.regionName,
        currentCount: row.currentCount,
        previousCount: row.previousCount,
        difference: row.difference,
        changeRate: row.changeRate,
        direction: row.difference > 0 ? "ارتفاع" : "انخفاض",
      })),
      regionSubjectChanges: [
      { regionName: "منطقة الرياض", subject: "عرضه على الطبيب", currentCount: 18, previousCount: 7, difference: 11, changeRate: 157.1, direction: "ارتفاع" },
      { regionName: "منطقة مكة المكرمة", subject: "انقطاع العلاج", currentCount: 9, previousCount: 3, difference: 6, changeRate: 200, direction: "ارتفاع" },
      { regionName: "المنطقة الشرقية", subject: "استفسار عن معاملة", currentCount: 1, previousCount: 8, difference: -7, changeRate: -87.5, direction: "انخفاض" },
    ],
    deptClassRises: [{
        departmentId: "d1", departmentName: "إدارة المتابعة", classificationId: "c1",
        classificationName: "طلب نقل", classificationPath: "الخدمات / طلب نقل", currentCount: 2, previousCount: 0,
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
      departmentName: "إدارة المتابعة", classificationName: "طلب نقل", classificationPath: "الخدمات / طلب نقل",
      currentCount: 2, previousCount: 1, appearsInBothPeriods: true, recurrenceType: "persistent",
    }],
  };
  const base = baseReport("DIGITAL_EXECUTIVE_BRIEF");
  return {
    ...base,
    title: "تقرير الشكاوى",
    reportMode: "FULL_ANALYTICAL",
    briefData: fullData,
    sections: [
      { id: "kpis", kind: "kpi", title: "المؤشرات الرئيسية", cards: [
        { key: "total", label: "إجمالي الشكاوى", value: 3, format: "number" },
        { key: "late", label: "المتأخرة", value: 1, format: "number" },
      ] },
      { id: "summary", kind: "text", title: "الملخص", points: ["قراءة تحليلية موسعة للفترة المحددة."] },
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

function reportWithCompliance(value: number): ReportData {
  const report = baseReport("DIGITAL_EXECUTIVE_BRIEF");
  report.briefData = {
    ...briefData,
    briefKpis: briefData.briefKpis.map((card) => (
      card.key === "complianceRate" ? { ...card, value } : card
    )),
  };
  return report;
}

function reportWithoutReference(): ReportData {
  const report = baseReport("DIGITAL_EXECUTIVE_BRIEF");
  report.previousPeriod = null;
  report.comparisonData = undefined;
  report.briefData = {
    ...briefData,
    allRegions: briefData.allRegions.map((row, index) => ({
      ...row,
      currentCount: 10 + index,
      previousCount: 0,
      difference: 0,
      changeRate: null,
    })),
    comparativeTimeline: {
      current: briefData.comparativeTimeline.current,
      previous: null,
      periodDays: briefData.comparativeTimeline.periodDays,
    },
  };
  return report;
}

function zeroTrendReport(): ReportData {
  const report = fullReport();
  return {
    ...report,
    title: "تقرير اتجاه صفري صالح",
    reportMode: "STANDARD",
    briefData: undefined,
    comparisonData: undefined,
    sections: [{
      id: "zero_trend",
      kind: "chart",
      chartType: "line",
      title: "الاتجاه الزمني — جميع القيم صفر",
      series: [{
        name: "الفترة الحالية",
        points: Array.from({ length: 7 }, (_, index) => ({
          x: `2026-07-${String(index + 1).padStart(2, "0")}`,
          y: 0,
        })),
      }],
    }],
  };
}

// ── V2 test data helpers ──────────────────────────────────────────────────────

/** V2-specific extension with realistic 5-month stock/flow data matching the design reference. */
const v2BriefData: ExecutiveBriefV2Data = {
  ...briefData,
  allTimeTotal: 18560,
  topFacilities: [
    { name: "سجن نشط ذو شكاوى", total: 22, open: 5, closed: 17, currentlyLate: 2, shareOfTotal: 7.3 },
  ],
  bottomFacilities: [
    { name: "سجن نشط بلا شكاوى", total: 0, open: 0, closed: 0, currentlyLate: 0, shareOfTotal: 0 },
    { name: "سجن نشط برصيد سابق", total: 0, open: 4, closed: 0, currentlyLate: 1, shareOfTotal: 0 },
  ],
  classificationOpenLate: {
    c1: { openAtEnd: 41, lateAtEnd: 11 },
    c2: { openAtEnd: 26, lateAtEnd: 4 },
    c3: { openAtEnd: 18, lateAtEnd: 5 },
  },
  classificationChanges: [
    { classificationId: "change-rise", classificationName: "طلب نقل", classificationPath: "الخدمات / طلب نقل", currentCount: 60, previousCount: 20, difference: 40, changeRate: 200, direction: "ارتفاع" },
    { classificationId: "change-decline", classificationName: "طلب علاج", classificationPath: "الخدمات / طلب علاج", currentCount: 5, previousCount: 30, difference: -25, changeRate: -83.3, direction: "انخفاض" },
    { classificationId: "change-new", classificationName: "استفسار جديد", classificationPath: "الاستفسارات / استفسار جديد", currentCount: 12, previousCount: 0, difference: 12, changeRate: null, direction: "جديد" },
    { classificationId: "change-zero", classificationName: "معاملة قديمة", classificationPath: "المعاملات / معاملة قديمة", currentCount: 0, previousCount: 18, difference: -18, changeRate: -100, direction: "انخفاض إلى صفر" },
  ],
  monthlyStockFlow: [
    { monthKey: "2025-08", monthLabel: "أغسطس 2025", receivedCount: 1552, closedDuringMonthCount: 1412, openAtMonthEndCount: 158, lateAtMonthEndCount: 34 },
    { monthKey: "2025-09", monthLabel: "سبتمبر 2025", receivedCount: 1468, closedDuringMonthCount: 1300, openAtMonthEndCount: 150, lateAtMonthEndCount: 32 },
    { monthKey: "2025-10", monthLabel: "أكتوبر 2025", receivedCount: 1314, closedDuringMonthCount: 1170, openAtMonthEndCount: 140, lateAtMonthEndCount: 29 },
    { monthKey: "2025-11", monthLabel: "نوفمبر 2025", receivedCount: 1231, closedDuringMonthCount: 1085, openAtMonthEndCount: 134, lateAtMonthEndCount: 27 },
    { monthKey: "2025-12", monthLabel: "ديسمبر 2025", receivedCount: 1207, closedDuringMonthCount: 1145, openAtMonthEndCount: 128, lateAtMonthEndCount: 26 },
    { monthKey: "2026-01", monthLabel: "يناير 2026", receivedCount: 1180, closedDuringMonthCount: 1100, openAtMonthEndCount: 130, lateAtMonthEndCount: 28 },
    { monthKey: "2026-02", monthLabel: "فبراير 2026", receivedCount: 1095, closedDuringMonthCount: 1020, openAtMonthEndCount: 125, lateAtMonthEndCount: 25 },
    { monthKey: "2026-03", monthLabel: "مارس 2026", receivedCount: 1210, closedDuringMonthCount: 1150, openAtMonthEndCount: 122, lateAtMonthEndCount: 24 },
    { monthKey: "2026-04", monthLabel: "أبريل 2026", receivedCount: 980, closedDuringMonthCount: 940, openAtMonthEndCount: 118, lateAtMonthEndCount: 22 },
    { monthKey: "2026-05", monthLabel: "مايو 2026", receivedCount: 1050, closedDuringMonthCount: 990, openAtMonthEndCount: 115, lateAtMonthEndCount: 21 },
    { monthKey: "2026-06", monthLabel: "يونيو 2026", receivedCount: 1120, closedDuringMonthCount: 1080, openAtMonthEndCount: 110, lateAtMonthEndCount: 20 },
    { monthKey: "2026-07", monthLabel: "يوليو 2026", receivedCount: 990, closedDuringMonthCount: 920, openAtMonthEndCount: 108, lateAtMonthEndCount: 19 },
    { monthKey: "2026-08", monthLabel: "أغسطس 2026", receivedCount: 420, closedDuringMonthCount: 310, openAtMonthEndCount: 105, lateAtMonthEndCount: 18 },
  ],
};

const ALL_SAUDI_REGIONS = [
  "منطقة الرياض",
  "منطقة مكة المكرمة",
  "منطقة المدينة المنورة",
  "منطقة القصيم",
  "المنطقة الشرقية",
  "منطقة عسير",
  "منطقة تبوك",
  "منطقة حائل",
  "منطقة الحدود الشمالية",
  "منطقة جازان",
  "منطقة نجران",
  "منطقة الباحة",
  "منطقة الجوف",
];

function v2BaseReport(): ReportData {
  const base = baseReport("PRINT_EXECUTIVE_BRIEF_V2");
  // Report window ends in August 2026 so the 13-month fixture (2025-08…2026-08) is valid.
  base.period = { from: "2026-07-05", to: "2026-08-04" };
  base.previousPeriod = { from: "2026-06-04", to: "2026-07-04" };
  base.filters = { from: "2026-07-05", to: "2026-08-04" };
  base.comparisonMode = "PREVIOUS_EQUIVALENT_PERIOD";
  base.comparisonData = {
    ...base.comparisonData!,
    currentPeriod: {
      from: new Date("2026-07-05T00:00:00.000Z"),
      toExclusive: new Date("2026-08-05T00:00:00.000Z"),
    },
    previousPeriod: {
      from: new Date("2026-06-04T00:00:00.000Z"),
      toExclusive: new Date("2026-07-05T00:00:00.000Z"),
    },
  };
  base.briefData = v2BriefData;
  assertTrendEndsAtOrBeforeReportEnd(v2BriefData.monthlyStockFlow, base.period.to);
  return base;
}

function v2NoReferenceReport(): ReportData {
  const base = v2BaseReport();
  base.previousPeriod = null;
  base.comparisonData = undefined;
  base.briefData = {
    ...v2BriefData,
    classificationChanges: [],
    allRegions: v2BriefData.allRegions.map((row) => ({
      ...row,
      previousCount: 0,
      difference: 0,
      changeRate: null,
    })),
    comparativeTimeline: {
      current: v2BriefData.comparativeTimeline.current,
      previous: null,
      periodDays: v2BriefData.comparativeTimeline.periodDays,
    },
  };
  return base;
}

function v2ComplianceReport(value: number): ReportData {
  const base = v2BaseReport();
  base.briefData = {
    ...v2BriefData,
    briefKpis: v2BriefData.briefKpis.map((card) =>
      card.key === "complianceRate" ? { ...card, value } : card
    ),
  };
  return base;
}

function v2AllSaudiRegionsReport(): ReportData {
  const base = v2BaseReport();
  base.briefData = {
    ...v2BriefData,
    allRegions: ALL_SAUDI_REGIONS.map((regionName, index) => ({
      regionName,
      currentCount: 10 + index * 3,
      previousCount: index * 2 + 1,
      difference: 10 + index,
      changeRate: Math.round((10 + index) / (index * 2 + 1) * 100),
      complianceRate: 80 + index,
      averageResolutionDays: 5 + index,
      openCount: 4 + index,
      closedCount: 6 + index,
      currentlyLate: index % 3,
      direction: "ارتفاع",
    })),
  };
  return base;
}

// Tests "جديد" display: current > 0, previous = 0.
function v2NewEntitiesReport(): ReportData {
  const base = v2BaseReport();
  base.briefData = {
    ...v2BriefData,
    briefKpis: v2BriefData.briefKpis.map((card) => ({
      ...card,
      previousValue: card.key === "total" ? 0 : (card.previousValue ?? 0),
      changeRate: card.key === "total" ? null : card.changeRate,
    })),
    topClassifications: v2BriefData.topClassifications.map((row) => ({
      ...row,
      previousCount: 0,
      difference: row.currentCount,
      changeRate: null,
    })),
  };
  return base;
}

// Numeric accuracy: 484 total / 1207 previous → changeRate ≈ −59.9%.
function v2HighVolumeReport(): ReportData {
  const base = v2BaseReport();
  base.title = "تقرير الشكاوى — حجم مرتفع";
  base.briefData = {
    ...v2BriefData,
    allTimeTotal: 18560,
    briefKpis: [
      { key: "total", label: "شكاوى الفترة", value: 1207, previousValue: 1870, difference: -663, changeRate: -35.5, format: "number", assessment: "negative" },
      { key: "closed", label: "المغلقة خلال الفترة", value: 1145, previousValue: 1320, difference: -175, changeRate: -13.3, format: "number", assessment: "negative" },
      { key: "open", label: "المفتوحة نهاية الفترة", value: 128, previousValue: 92, difference: 36, changeRate: 39.1, format: "number", assessment: "negative" },
      { key: "currentlyLate", label: "المتأخرة نهاية الفترة", value: 26, previousValue: 14, difference: 12, changeRate: 85.7, format: "number", assessment: "negative" },
      { key: "netChange", label: "إجمالي الشكاوى في النظام", value: 18560, previousValue: null, difference: null, changeRate: null, format: "number", assessment: "neutral" },
      { key: "closedLate", label: "المغلقة بعد المهلة", value: 31, previousValue: 18, difference: 13, changeRate: 72.2, format: "number", assessment: "negative" },
      { key: "complianceRate", label: "الالتزام ضمن المهلة", value: 97.3, previousValue: 90, difference: 7.3, changeRate: 8.1, format: "percent", assessment: "positive" },
      { key: "averageResolutionDays", label: "متوسط الإغلاق", value: 3.2, previousValue: 22.6, difference: -19.4, changeRate: -85.8, format: "days", assessment: "positive" },
    ],
  };
  return base;
}

// V2 without conclusions or notes to verify the empty-state fallback rendering.
function v2NoNotesReport(): ReportData {
  const base = v2BaseReport();
  base.briefData = {
    ...v2BriefData,
    conclusions: [],
    notes: [],
  };
  return base;
}

async function main(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  // ── Existing modes ────────────────────────────────────────────────────────
  const digital = await renderExecutiveBriefPdf(baseReport("DIGITAL_EXECUTIVE_BRIEF"), "DIGITAL_EXECUTIVE_BRIEF");
  const print = await renderExecutiveBriefPdf(baseReport("PRINT_EXECUTIVE_BRIEF"), "PRINT_EXECUTIVE_BRIEF");
  const full = await renderReportPdf(fullReport());
  const gauge25 = await renderExecutiveBriefPdf(reportWithCompliance(25), "DIGITAL_EXECUTIVE_BRIEF");
  const gauge75 = await renderExecutiveBriefPdf(reportWithCompliance(75), "DIGITAL_EXECUTIVE_BRIEF");
  const gauge100 = await renderExecutiveBriefPdf(reportWithCompliance(100), "DIGITAL_EXECUTIVE_BRIEF");
  const noReference = await renderExecutiveBriefPdf(reportWithoutReference(), "DIGITAL_EXECUTIVE_BRIEF");
  const zeroTrend = await renderReportPdf(zeroTrendReport());

  // ── V2 test cases (8 scenarios) ───────────────────────────────────────────
  const v2Base = await renderExecutiveBriefV2Pdf(v2BaseReport());
  const v2NoRef = await renderExecutiveBriefV2Pdf(v2NoReferenceReport());
  const v2Compliance25 = await renderExecutiveBriefV2Pdf(v2ComplianceReport(25));
  const v2Compliance100 = await renderExecutiveBriefV2Pdf(v2ComplianceReport(100));
  const v2AllRegions = await renderExecutiveBriefV2Pdf(v2AllSaudiRegionsReport());
  const v2NewEntities = await renderExecutiveBriefV2Pdf(v2NewEntitiesReport());
  const v2HighVolume = await renderExecutiveBriefV2Pdf(v2HighVolumeReport());
  const v2NoNotes = await renderExecutiveBriefV2Pdf(v2NoNotesReport());

  await Promise.all([
    fs.writeFile(path.join(outputDir, "digital-executive-brief.pdf"), digital.buffer),
    fs.writeFile(path.join(outputDir, "print-executive-brief.pdf"), print.buffer),
    fs.writeFile(path.join(outputDir, "full-analytical-report.pdf"), full.buffer),
    fs.writeFile(path.join(outputDir, "digital-gauge-25.pdf"), gauge25.buffer),
    fs.writeFile(path.join(outputDir, "digital-gauge-75.pdf"), gauge75.buffer),
    fs.writeFile(path.join(outputDir, "digital-gauge-100.pdf"), gauge100.buffer),
    fs.writeFile(path.join(outputDir, "digital-no-reference.pdf"), noReference.buffer),
    fs.writeFile(path.join(outputDir, "zero-trend-report.pdf"), zeroTrend.buffer),
    // V2 scenarios
    fs.writeFile(path.join(outputDir, "v2-executive-brief.pdf"), v2Base.buffer),
    fs.writeFile(path.join(outputDir, "v2-no-reference.pdf"), v2NoRef.buffer),
    fs.writeFile(path.join(outputDir, "v2-compliance-25.pdf"), v2Compliance25.buffer),
    fs.writeFile(path.join(outputDir, "v2-compliance-100.pdf"), v2Compliance100.buffer),
    fs.writeFile(path.join(outputDir, "v2-all-saudi-regions.pdf"), v2AllRegions.buffer),
    fs.writeFile(path.join(outputDir, "v2-new-entities.pdf"), v2NewEntities.buffer),
    fs.writeFile(path.join(outputDir, "v2-high-volume.pdf"), v2HighVolume.buffer),
    fs.writeFile(path.join(outputDir, "v2-no-notes.pdf"), v2NoNotes.buffer),
  ]);
  process.stdout.write(`${outputDir}\n`);
}

void main();
