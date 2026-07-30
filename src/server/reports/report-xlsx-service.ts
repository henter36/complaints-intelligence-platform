import ExcelJS from "exceljs";
import { getReportDefinition } from "./report-definition-service";
import type { ReportData, ReportTable } from "./report-data-service";
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

function buildSummarySheet(workbook: ExcelJS.Workbook, data: ReportData, warnings: string[]): void {
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

  if (warnings.length > 0) {
    sheet.addRow({ field: "", value: "" });
    sheet.addRow({ field: "تنبيهات", value: "" }).font = { bold: true };
    for (const warning of warnings) {
      sheet.addRow({ field: "", value: sanitizeText(warning) });
    }
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
      previous: kpiValue.previousValue ?? "-",
      change: kpiValue.percentageChange ?? "-",
    });
    row.getCell("change").numFmt = '0.0"%"';
  }
}

function columnNumFmt(format: ReportTable["columns"][number]["format"]): string | undefined {
  if (format === "percent") return '0.0"%"';
  if (format === "date") return "yyyy-mm-dd";
  if (format === "number") return "#,##0.##";
  return undefined;
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
    const rowData: Record<string, unknown> = {};
    for (const column of table.columns) {
      const raw = row[column.key];
      if (column.format === "date") {
        const date = raw ? new Date(String(raw)) : null;
        rowData[column.key] = date && !Number.isNaN(date.getTime()) ? date : null;
      } else if (column.format === "number" || column.format === "percent") {
        rowData[column.key] = typeof raw === "number" ? raw : raw === null || raw === undefined ? null : Number(raw);
      } else {
        rowData[column.key] = raw === null || raw === undefined ? "" : sanitizeText(String(raw));
      }
    }
    const addedRow = sheet.addRow(rowData);
    for (const column of table.columns) {
      const numFmt = columnNumFmt(column.format);
      if (numFmt) addedRow.getCell(column.key).numFmt = numFmt;
    }
  }

  if (table.truncated) {
    const noteRow = sheet.addRow({});
    noteRow.getCell(1).value = sanitizeText(
      `تم عرض ${table.rows.length} من أصل ${table.totalMatched} صفاً وفق الحد الأقصى المسموح.`
    );
    noteRow.getCell(1).font = { italic: true, color: { argb: "FFB45309" } };
  }
}

export type XlsxRenderResult = {
  buffer: Buffer;
  warnings: string[];
};

export async function renderReportXlsx(data: ReportData): Promise<XlsxRenderResult> {
  const warnings = [...data.warnings];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "نظام ذكاء الشكاوى";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = false;

  buildSummarySheet(workbook, data, warnings);
  buildKpiSheet(workbook, data);

  const usedNames = new Set<string>(["الملخص", "المؤشرات"]);
  for (const section of data.sections) {
    if (section.kind !== "table") continue;
    try {
      buildTableSheet(workbook, section.table, usedNames);
    } catch {
      warnings.push(`تعذر إنشاء ورقة بيانات لقسم "${section.title}".`);
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return { buffer: Buffer.from(arrayBuffer), warnings };
}
