import ExcelJS from "exceljs";
import { getReportDefinition } from "./report-definition-service";
import type {
  ReportData,
  ReportTable,
  ExecutiveBriefData,
  FullAnalyticalData,
} from "./report-data-service";
import { isFullAnalyticalData } from "./report-data-service";
import type { ComparisonResult } from "./report-comparison";
import type { NetBacklogFlow, PerfVolumeRow, ContinuityRow } from "@/lib/reports/report-contract";
import { formatRiyadhDateTime } from "./report-time";

const FORMULA_INJECTION_PATTERN = /^[=+\-@]/;

/** Defense-in-depth: a leading =, +, -, or @ is neutralized so spreadsheet
 * applications never interpret user/data-sourced text as a formula. */
function sanitizeText(value: string): string {
  return FORMULA_INJECTION_PATTERN.test(value) ? `'${value}` : value;
}

function sanitizeSheetName(name: string, usedNames: Set<string>): string {
  let base = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || "ورقة";
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base.slice(0, 28)} ${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

const FILTER_LABELS: Record<string, string> = {
  region: "المنطقة",
  department: "الإدارة",
  facility: "الموقع",
  classificationId: "التصنيف",
  categoryId: "الفئة",
  priority: "الأولوية",
  severity: "الخطورة",
  channel: "القناة",
  status: "الحالة",
};

const KPI_LABELS: Record<string, string> = {
  totalComplaints: "إجمالي الشكاوى",
  openComplaints: "المفتوحة",
  closedComplaints: "المغلقة",
  cancelledComplaints: "الملغاة",
  currentlyLateComplaints: "المتأخرة حالياً",
  closedLateComplaints: "المغلقة بعد المهلة",
  closedWithinDueDate: "المغلقة ضمن المهلة",
  withoutDueDate: "بدون تاريخ استحقاق",
  unclassifiedComplaints: "غير المصنفة",
  highPriorityOpenComplaints: "عالية الأولوية المفتوحة",
  averageResolutionDays: "متوسط زمن الإغلاق (يوم)",
  medianResolutionDays: "وسيط زمن الإغلاق (يوم)",
  averageOpenAgeDays: "متوسط عمر الشكاوى المفتوحة (يوم)",
  dueDateComplianceRate: "نسبة الالتزام بالمهلة%",
  closureRate: "نسبة الإغلاق%",
  reopenCount: "عدد إعادة الفتح",
};

function applyRtlView(worksheet: ExcelJS.Worksheet): void {
  worksheet.views = [{ rightToLeft: true, state: "frozen", ySplit: 1 }];
}

function buildSummarySheet(workbook: ExcelJS.Workbook, data: ReportData): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet("الملخص");
  applyRtlView(sheet);
  sheet.columns = [
    { header: "الحقل", key: "field", width: 28 },
    { header: "القيمة", key: "value", width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } };

  const definition = getReportDefinition(data.type);
  const filterEntries = Object.entries(data.filters).filter(([key]) => key !== "from" && key !== "to");
  const filtersText = filterEntries.length
    ? filterEntries.map(([key, value]) => `${FILTER_LABELS[key] ?? key}: ${String(value)}`).join(" | ")
    : "لا توجد فلاتر إضافية";

  const rows: [string, string][] = [
    ["عنوان التقرير", data.title],
    ["نوع التقرير", definition.title],
    ["الوصف", definition.description],
    ["الفترة من", data.period.from],
    ["الفترة إلى", data.period.to],
    ["تاريخ الإنشاء", formatRiyadhDateTime(new Date(data.generatedAt))],
    ["الفلاتر المطبقة", filtersText],
    ["ملاحظة", "تقرير مولّد آلياً بواسطة نظام ذكاء الشكاوى"],
  ];
  for (const [field, value] of rows) {
    sheet.addRow({ field: sanitizeText(field), value: sanitizeText(value) });
  }

  return sheet;
}

/** Appended after every table sheet has been built, so failures collected
 * while building them are reflected here too, not just the warnings the
 * report started with. */
function appendWarningsToSummarySheet(sheet: ExcelJS.Worksheet, warnings: string[]): void {
  if (warnings.length === 0) return;
  sheet.addRow({ field: "", value: "" });
  sheet.addRow({ field: "تنبيهات", value: "" }).font = { bold: true };
  for (const warning of warnings) {
    sheet.addRow({ field: "", value: sanitizeText(warning) });
  }
}

function buildKpiSheet(workbook: ExcelJS.Workbook, data: ReportData): void {
  const sheet = workbook.addWorksheet("المؤشرات");
  applyRtlView(sheet);
  sheet.columns = [
    { header: "المؤشر", key: "label", width: 32 },
    { header: "القيمة الحالية", key: "current", width: 18 },
    { header: "القيمة السابقة", key: "previous", width: 18 },
    { header: "نسبة التغير%", key: "change", width: 16 },
  ];
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 4 } };

  for (const [key, kpiValue] of Object.entries(data.kpis)) {
    const row = sheet.addRow({
      label: sanitizeText(KPI_LABELS[key] ?? key),
      current: kpiValue.currentValue,
      previous: kpiValue.previousValue ?? null,
      change: kpiValue.percentageChange ?? null,
    });
    row.getCell("change").numFmt = '0.0"%"';
  }
}

function columnNumFmt(format: ReportTable["columns"][number]["format"]): string | undefined {
  if (format === "percent") return '0.0"%"';
  if (format === "date") return "yyyy-mm-dd";
  if (format === "number") return "#,##0.##";
  if (format === "signed-number") return '+#,##0;-#,##0;0';
  return undefined;
}

/** Renders any value to text for display, without relying on the default
 * `[object Object]` stringification of a bare `String(value)` call. */
function toDisplayText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function parseDateCell(raw: unknown): Date | null {
  if (!raw) return null;
  const date = new Date(toDisplayText(raw));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNumericCell(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function toCellValue(column: ReportTable["columns"][number], raw: unknown): unknown {
  if (column.format === "date") return parseDateCell(raw);
  if (column.format === "number" || column.format === "percent" || column.format === "signed-number") return parseNumericCell(raw);
  return sanitizeText(toDisplayText(raw));
}

function buildTableRowData(table: ReportTable, row: Record<string, unknown>): Record<string, unknown> {
  const rowData: Record<string, unknown> = {};
  for (const column of table.columns) {
    rowData[column.key] = toCellValue(column, row[column.key]);
  }
  return rowData;
}

function applyRowNumberFormats(table: ReportTable, addedRow: ExcelJS.Row): void {
  for (const column of table.columns) {
    const numFmt = columnNumFmt(column.format);
    if (numFmt) addedRow.getCell(column.key).numFmt = numFmt;
  }
}

function appendTruncationNote(sheet: ExcelJS.Worksheet, table: ReportTable): void {
  if (!table.truncated) return;
  const noteRow = sheet.addRow({});
  noteRow.getCell(1).value = sanitizeText(
    `تم عرض ${table.rows.length} من أصل ${table.totalMatched} صفاً وفق الحد الأقصى المسموح.`
  );
  noteRow.getCell(1).font = { italic: true, color: { argb: "FFB45309" } };
}

function buildTableSheet(
  workbook: ExcelJS.Workbook,
  table: ReportTable,
  usedNames: Set<string>
): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName(table.title, usedNames));
  applyRtlView(sheet);
  sheet.columns = table.columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: Math.max(14, Math.min(40, column.label.length * 2 + 6)),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: table.columns.length },
  };

  for (const row of table.rows) {
    const addedRow = sheet.addRow(buildTableRowData(table, row));
    applyRowNumberFormats(table, addedRow);
  }

  appendTruncationNote(sheet, table);
}

// The comparison result is threaded through `ReportData.comparisonData` (set
// only by the EXECUTIVE_SUMMARY builder). We chose this over a separate return
// value so the XLSX and PDF renderers share one immutable data object and the
// export orchestrator does not have to plumb an extra argument through every
// format.
function buildRegionTrendSheet(workbook: ExcelJS.Workbook, comparison: ComparisonResult, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("اتجاه المناطق", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "المنطقة", key: "region", width: 26 },
    { header: "اليوم", key: "date", width: 16 },
    { header: "عدد الشكاوى", key: "count", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 3 } };
  for (const series of comparison.regionTrend.series) {
    for (const point of series.points) {
      sheet.addRow({ region: sanitizeText(series.regionName), date: point.date, count: point.count });
    }
  }
}

function buildRegionChangesSheet(workbook: ExcelJS.Workbook, comparison: ComparisonResult, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("تغير المناطق", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "المنطقة", key: "region", width: 26 },
    { header: "الحالي", key: "current", width: 12 },
    { header: "السابق", key: "previous", width: 12 },
    { header: "الفرق", key: "difference", width: 12 },
    { header: "نسبة التغير%", key: "changeRate", width: 16 },
    { header: "الاتجاه", key: "direction", width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
  for (const row of comparison.regionChanges) {
    const added = sheet.addRow({
      region: sanitizeText(row.regionName),
      current: row.currentCount,
      previous: row.previousCount,
      difference: row.difference,
      changeRate: row.changeRate ?? null,
      direction: sanitizeText(row.direction),
    });
    added.getCell("changeRate").numFmt = '0.0"%"';
  }
}

function buildDeptClassRisesSheet(workbook: ExcelJS.Workbook, comparison: ComparisonResult, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("ارتفاع الإدارات والتصنيفات", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "الإدارة", key: "department", width: 28 },
    { header: "التصنيف", key: "classification", width: 28 },
    { header: "الحالي", key: "current", width: 12 },
    { header: "السابق", key: "previous", width: 12 },
    { header: "الفرق", key: "difference", width: 12 },
    { header: "نسبة التغير%", key: "changeRate", width: 16 },
    { header: "مساهمة التصنيف%", key: "contribution", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 7 } };
  for (const row of comparison.deptClassRises) {
    const added = sheet.addRow({
      department: sanitizeText(row.departmentName),
      classification: sanitizeText(row.classificationName),
      current: row.currentCount,
      previous: row.previousCount,
      difference: row.difference,
      changeRate: row.changeRate ?? null,
      contribution: row.classificationContribution,
    });
    added.getCell("changeRate").numFmt = '0.0"%"';
    added.getCell("contribution").numFmt = '0.0"%"';
  }
}

// ---------------------------------------------------------------------------
// Executive brief XLSX sheets
// ---------------------------------------------------------------------------

function buildBriefKpisSheet(workbook: ExcelJS.Workbook, briefData: ExecutiveBriefData, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("المؤشرات التنفيذية", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "المؤشر", key: "label", width: 28 },
    { header: "الحالي", key: "current", width: 14 },
    { header: "السابق", key: "previous", width: 14 },
    { header: "الفرق", key: "difference", width: 12 },
    { header: "نسبة التغير%", key: "changeRate", width: 16 },
    { header: "التقييم", key: "assessment", width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

  const assessmentLabels: Record<string, string> = {
    positive: "إيجابي",
    negative: "سلبي",
    warning: "تحذير",
    neutral: "محايد",
  };

  for (const card of briefData.briefKpis) {
    const row = sheet.addRow({
      label: sanitizeText(card.label),
      current: card.value,
      previous: card.previousValue ?? null,
      difference: card.difference ?? null,
      changeRate: card.changeRate ?? null,
      assessment: sanitizeText(assessmentLabels[card.assessment] ?? card.assessment),
    });
    if (typeof card.changeRate === "number") {
      row.getCell("changeRate").numFmt = '+0.0"%";-0.0"%";0"%"';
    }
  }
}

function buildAllRegionsSheet(workbook: ExcelJS.Workbook, briefData: ExecutiveBriefData, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("جميع المناطق", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "المنطقة", key: "regionName", width: 28 },
    { header: "الحالي", key: "current", width: 12 },
    { header: "السابق", key: "previous", width: 12 },
    { header: "الفرق", key: "difference", width: 12 },
    { header: "نسبة التغير%", key: "changeRate", width: 16 },
    { header: "الالتزام%", key: "complianceRate", width: 14 },
    { header: "متوسط الإغلاق", key: "avgResolution", width: 16 },
    { header: "المتأخرة", key: "currentlyLate", width: 12 },
    { header: "الاتجاه", key: "direction", width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };

  for (const row of briefData.allRegions) {
    const added = sheet.addRow({
      regionName: sanitizeText(row.regionName),
      current: row.currentCount,
      previous: row.previousCount,
      difference: row.difference,
      changeRate: row.changeRate ?? null,
      complianceRate: row.complianceRate ?? null,
      avgResolution: row.averageResolutionDays ?? null,
      currentlyLate: row.currentlyLate,
      direction: sanitizeText(row.direction),
    });
    if (typeof row.changeRate === "number") added.getCell("changeRate").numFmt = '0.0"%"';
    if (typeof row.complianceRate === "number") added.getCell("complianceRate").numFmt = '0.0"%"';
  }
}

function buildTopClassificationsSheet(workbook: ExcelJS.Workbook, briefData: ExecutiveBriefData, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("أبرز التصنيفات", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "التصنيف", key: "name", width: 30 },
    { header: "الحالي", key: "current", width: 12 },
    { header: "السابق", key: "previous", width: 12 },
    { header: "الفرق", key: "difference", width: 12 },
    { header: "نسبة التغير%", key: "changeRate", width: 16 },
    { header: "النسبة من الإجمالي%", key: "shareOfTotal", width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

  for (const row of briefData.topClassifications) {
    const added = sheet.addRow({
      name: sanitizeText(row.classificationName),
      current: row.currentCount,
      previous: row.previousCount,
      difference: row.difference,
      changeRate: row.changeRate ?? null,
      shareOfTotal: row.shareOfTotal,
    });
    if (typeof row.changeRate === "number") added.getCell("changeRate").numFmt = '0.0"%"';
    added.getCell("shareOfTotal").numFmt = '0.0"%"';
  }
}

function buildComparativeTimelineSheet(workbook: ExcelJS.Workbook, briefData: ExecutiveBriefData, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("الاتجاه الزمني المقارن", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "اليوم النسبي", key: "day", width: 14 },
    { header: "الفترة الحالية", key: "current", width: 16 },
    { header: "الفترة السابقة", key: "previous", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 3 } };

  const { current, previous } = briefData.comparativeTimeline;
  const currentMap = new Map(current.points.map((p) => [p.relativeDay, p.count]));
  const previousMap = previous
    ? new Map(previous.points.map((p) => [p.relativeDay, p.count]))
    : null;

  const allDays = new Set([
    ...current.points.map((p) => p.relativeDay),
    ...(previous?.points.map((p) => p.relativeDay) ?? []),
  ]);
  const sortedDays = Array.from(allDays).sort((a, b) => a - b);

  for (const day of sortedDays) {
    sheet.addRow({
      day,
      current: currentMap.get(day) ?? null,
      previous: previousMap ? (previousMap.get(day) ?? null) : null,
    });
  }
}

function buildConcentrationSheet(workbook: ExcelJS.Workbook, briefData: ExecutiveBriefData, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("التركز", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "البُعد", key: "type", width: 22 },
    { header: "حصة أعلى 1%", key: "top1", width: 18 },
    { header: "حصة أعلى 3%", key: "top3", width: 18 },
    { header: "حصة أعلى 5%", key: "top5", width: 18 },
    { header: "إجمالي الكيانات", key: "total", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };

  const typeLabels: Record<string, string> = {
    region: "المناطق",
    classification: "التصنيفات",
    department: "الإدارات",
  };

  for (const band of briefData.concentrationBands) {
    const row = sheet.addRow({
      type: sanitizeText(typeLabels[band.entityType] ?? band.entityType),
      top1: band.top1SharePercent,
      top3: band.top3SharePercent,
      top5: band.top5SharePercent,
      total: band.totalEntities,
    });
    row.getCell("top1").numFmt = '0.0"%"';
    row.getCell("top3").numFmt = '0.0"%"';
    row.getCell("top5").numFmt = '0.0"%"';
  }
}

// ---------------------------------------------------------------------------
// FULL_ANALYTICAL-only XLSX sheets
// ---------------------------------------------------------------------------

function buildNetBacklogSheet(workbook: ExcelJS.Workbook, flow: NetBacklogFlow, usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("صافي التدفق", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "البيان", key: "label", width: 28 },
    { header: "القيمة", key: "value", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({ label: "الوارد (inflow)", value: flow.inflow });
  sheet.addRow({ label: "المغلق (outflow)", value: flow.outflow });
  sheet.addRow({ label: "الصافي", value: flow.net });
  sheet.addRow({ label: "أيام الفترة", value: flow.periodDays });
}

function buildPerfVolumeSheet(workbook: ExcelJS.Workbook, rows: PerfVolumeRow[], usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("الأداء والحجم", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "الجهة", key: "entity", width: 28 },
    { header: "إجمالي الشكاوى", key: "total", width: 16 },
    { header: "نسبة الالتزام%", key: "compliance", width: 16 },
    { header: "متوسط الإغلاق (يوم)", key: "avgDays", width: 20 },
    { header: "المتأخرة", key: "late", width: 14 },
    { header: "الحصة%", key: "share", width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
  for (const row of rows) {
    const added = sheet.addRow({
      entity: sanitizeText(row.entityName),
      total: row.totalComplaints,
      compliance: row.complianceRate ?? null,
      avgDays: row.averageResolutionDays ?? null,
      late: row.currentlyLate,
      share: row.share,
    });
    added.getCell("compliance").numFmt = '0.0"%"';
    added.getCell("share").numFmt = '0.0"%"';
  }
}

function buildContinuitySheet(workbook: ExcelJS.Workbook, rows: ContinuityRow[], usedNames: Set<string>): void {
  const sheet = workbook.addWorksheet(sanitizeSheetName("الاستمرارية", usedNames));
  applyRtlView(sheet);
  sheet.columns = [
    { header: "الإدارة", key: "dept", width: 28 },
    { header: "التصنيف", key: "class", width: 28 },
    { header: "الحالي", key: "current", width: 12 },
    { header: "السابق", key: "previous", width: 12 },
    { header: "نوع التكرار", key: "type", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
  for (const row of rows) {
    sheet.addRow({
      dept: sanitizeText(row.departmentName),
      class: sanitizeText(row.classificationName),
      current: row.currentCount,
      previous: row.previousCount,
      type: sanitizeText(row.recurrenceType),
    });
  }
}

export type XlsxRenderResult = {
  buffer: Buffer;
  warnings: string[];
};

type WorkbookBuildContext = {
  workbook: ExcelJS.Workbook;
  data: ReportData;
  warnings: string[];
  usedNames: Set<string>;
};

type BriefSheetDefinition = {
  key: string;
  build: (
    workbook: ExcelJS.Workbook,
    data: ExecutiveBriefData,
    usedNames: Set<string>
  ) => void;
};

type ComparisonSheetDefinition = {
  failureMessage: string;
  build: (
    workbook: ExcelJS.Workbook,
    comparison: ComparisonResult,
    usedNames: Set<string>
  ) => void;
};

type FullAnalyticalSheetDefinition = {
  failureMessage: string;
  build: (
    workbook: ExcelJS.Workbook,
    data: FullAnalyticalData,
    usedNames: Set<string>
  ) => void;
};

const BRIEF_SHEET_BUILDERS: readonly BriefSheetDefinition[] = [
  { key: "brief_kpis", build: buildBriefKpisSheet },
  { key: "all_regions", build: buildAllRegionsSheet },
  { key: "top_classifications", build: buildTopClassificationsSheet },
  { key: "comparative_timeline", build: buildComparativeTimelineSheet },
  { key: "concentration", build: buildConcentrationSheet },
];

const COMPARISON_SHEET_BUILDERS: readonly ComparisonSheetDefinition[] = [
  { failureMessage: 'تعذر إنشاء ورقة "اتجاه المناطق".', build: buildRegionTrendSheet },
  { failureMessage: 'تعذر إنشاء ورقة "تغير المناطق".', build: buildRegionChangesSheet },
  {
    failureMessage: 'تعذر إنشاء ورقة "ارتفاع الإدارات والتصنيفات".',
    build: buildDeptClassRisesSheet,
  },
];

const FULL_ANALYTICAL_SHEET_BUILDERS: readonly FullAnalyticalSheetDefinition[] = [
  {
    failureMessage: 'تعذر إنشاء ورقة "صافي التدفق".',
    build: (workbook, data, usedNames) =>
      buildNetBacklogSheet(workbook, data.netBacklogFlow, usedNames),
  },
  {
    failureMessage: 'تعذر إنشاء ورقة "الأداء والحجم".',
    build: (workbook, data, usedNames) =>
      buildPerfVolumeSheet(workbook, data.perfVolumeRows, usedNames),
  },
  {
    failureMessage: 'تعذر إنشاء ورقة "الاستمرارية".',
    build: (workbook, data, usedNames) =>
      buildContinuitySheet(workbook, data.continuityRows, usedNames),
  },
];

function createWorkbookContext(data: ReportData): WorkbookBuildContext {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "نظام ذكاء الشكاوى";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = false;
  return {
    workbook,
    data,
    warnings: [...data.warnings],
    usedNames: new Set<string>(["الملخص", "المؤشرات"]),
  };
}

function buildCoreSheets(context: WorkbookBuildContext): ExcelJS.Worksheet {
  const summarySheet = buildSummarySheet(context.workbook, context.data);
  buildKpiSheet(context.workbook, context.data);
  return summarySheet;
}

function runSheetBuilder(
  warnings: string[],
  failureMessage: string,
  build: () => void
): void {
  try {
    build();
  } catch {
    warnings.push(failureMessage);
  }
}

function appendStandardTableSheets(context: WorkbookBuildContext): void {
  const { workbook, data, warnings, usedNames } = context;
  for (const section of data.sections) {
    if (section.kind !== "table") continue;
    runSheetBuilder(
      warnings,
      `تعذر إنشاء ورقة بيانات لقسم "${section.title}".`,
      () => buildTableSheet(workbook, section.table, usedNames)
    );
  }
}

function appendComparisonSheets(context: WorkbookBuildContext): void {
  const { workbook, data, warnings, usedNames } = context;
  const comparison = data.comparisonData;
  if (!comparison) return;
  for (const definition of COMPARISON_SHEET_BUILDERS) {
    runSheetBuilder(warnings, definition.failureMessage, () =>
      definition.build(workbook, comparison, usedNames)
    );
  }
}

function appendBriefSheets(
  context: WorkbookBuildContext,
  briefData: ExecutiveBriefData
): void {
  const { workbook, warnings, usedNames } = context;
  for (const definition of BRIEF_SHEET_BUILDERS) {
    runSheetBuilder(
      warnings,
      `تعذر إنشاء ورقة البيانات الإضافية (${definition.key}).`,
      () => definition.build(workbook, briefData, usedNames)
    );
  }
}

function appendFullAnalyticalSheets(
  context: WorkbookBuildContext,
  fullData: FullAnalyticalData
): void {
  const { workbook, warnings, usedNames } = context;
  for (const definition of FULL_ANALYTICAL_SHEET_BUILDERS) {
    runSheetBuilder(warnings, definition.failureMessage, () =>
      definition.build(workbook, fullData, usedNames)
    );
  }
}

async function writeWorkbookBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export async function renderReportXlsx(data: ReportData): Promise<XlsxRenderResult> {
  const context = createWorkbookContext(data);
  const summarySheet = buildCoreSheets(context);
  appendStandardTableSheets(context);
  appendComparisonSheets(context);

  const briefData = data.briefData;
  if (briefData) {
    appendBriefSheets(context, briefData);
    if (isFullAnalyticalData(briefData)) appendFullAnalyticalSheets(context, briefData);
  }

  appendWarningsToSummarySheet(summarySheet, context.warnings);
  const buffer = await writeWorkbookBuffer(context.workbook);
  return { buffer, warnings: context.warnings };
}
