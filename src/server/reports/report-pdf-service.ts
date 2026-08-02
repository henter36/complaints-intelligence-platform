import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { ReportType } from "@prisma/client";
import { getReportDefinition } from "./report-definition-service";
import { renderExecutiveBriefPdf } from "./report-executive-brief-pdf-service";
import type {
  ReportChartSection,
  ReportData,
  ReportKpiCard,
  ReportMatrixSection,
  ReportSection,
  ReportTable,
  ReportTableColumn,
  ReportTextSection,
} from "./report-data-service";
import { isFullAnalyticalData } from "./report-data-service";
import { renderLineChartPng } from "./report-chart-service";
import { formatRiyadhDateTime } from "./report-time";
import { MAX_TREND_SERIES, DEPT_CLASS_RISES_LIMIT } from "./report-comparison";
import { buildMatrixTruncationMessage } from "@/lib/reports/matrix-truncation";
import {
  formatReportNumber,
  REPORT_DESIGN_TOKENS,
} from "@/lib/reports/design-tokens";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const PAGE_MARGIN = 40;
const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4 points
const CONTENT_WIDTH = PAGE_SIZE[0] - PAGE_MARGIN * 2;
const FOOTER_HEIGHT = 30;

// Flex-width table layout hints (points).
const COL_MIN_TEXT_WIDTH = 80;
const COL_NUMBER_WIDTH = 55;
const COL_DATE_WIDTH = 70;
const COL_PERCENT_WIDTH = 50;
const COL_DIRECTION_WIDTH = 45;
const TABLE_ROW_MAX_LINES = 2;

let fontRegularBuffer: Buffer | null = null;
let fontBoldBuffer: Buffer | null = null;
const COLORS = REPORT_DESIGN_TOKENS.colors;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!fontRegularBuffer) fontRegularBuffer = fs.readFileSync(FONT_REGULAR_PATH);
  if (!fontBoldBuffer) fontBoldBuffer = fs.readFileSync(FONT_BOLD_PATH);
  return { regular: fontRegularBuffer, bold: fontBoldBuffer };
}

const KPI_FORMAT_SUFFIX: Record<ReportKpiCard["format"], string> = {
  number: "",
  percent: "%",
  days: " يوم",
  hours: " ساعة",
};

function formatKpiValue(card: ReportKpiCard): string {
  const value = formatReportNumber(card.value);
  return `${value}${KPI_FORMAT_SUFFIX[card.format]}`;
}

const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  EXECUTIVE_SUMMARY: "التقرير التنفيذي الشامل",
  DEPARTMENT_PERFORMANCE: "أداء الإدارات",
  REGION_FACILITY_PERFORMANCE: "أداء المناطق والمواقع",
  CLASSIFICATION_ANALYSIS: "تحليل التصنيفات",
  COMPLAINT_DETAIL: "الشكاوى التفصيلي",
  OVERDUE_COMPLAINTS: "المتأخرات",
};

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

/** Renders any value to text without relying on the default
 * `[object Object]` stringification of a bare template-literal/String() call. */
function toDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function formatSignedNumber(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return formatReportNumber(n, { sign: true });
}

function formatCellValue(value: unknown, format?: ReportTableColumn["format"]): string {
  if (value === null || value === undefined || value === "") return "-";
  if (format === "percent" && typeof value === "number") {
    return formatReportNumber(value, { percent: true });
  }
  if (format === "signed-number") return formatSignedNumber(value);
  if (format === "number" && typeof value === "number") return formatReportNumber(value);
  if (format === "date") {
    const date = new Date(toDisplayText(value));
    if (Number.isNaN(date.getTime())) return "-";
    return date.toISOString().slice(0, 10);
  }
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  return toDisplayText(value);
}

function shortRunId(runId?: string): string {
  return runId ? runId.slice(0, 8) : "";
}

export type PdfRenderResult = {
  buffer: Buffer;
  warnings: string[];
};

export async function renderReportPdf(data: ReportData): Promise<PdfRenderResult> {
  // Route to specialised executive brief renderers for the new modes.
  if (
    data.reportMode === "DIGITAL_EXECUTIVE_BRIEF" ||
    data.reportMode === "PRINT_EXECUTIVE_BRIEF"
  ) {
    return renderExecutiveBriefPdf(data, data.reportMode);
  }

  const { regular, bold } = loadFonts();
  const warnings = [...data.warnings];
  const definition = getReportDefinition(data.type);

  // Section titles are mirrored into the Info /Keywords field. PDFKit encodes
  // Info strings as UTF-16BE literals (searchable in the raw buffer), whereas
  // on-page text is glyph-subsetted and NOT searchable. This makes the report's
  // structure discoverable to tooling/tests without a PDF-parsing dependency.
  const fullAnalyticalSections = buildFullAnalyticalPdfSections(data);
  const keywordParts = [...data.sections, ...fullAnalyticalSections].map((section) => section.title);
  if (data.type === ReportType.EXECUTIVE_SUMMARY && data.reportMode !== "FULL_ANALYTICAL") {
    keywordParts.push("منهجية الاحتساب");
  }
  const sectionTitles = keywordParts.join(" | ");

  const doc = new PDFDocument({
    size: PAGE_SIZE,
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN + FOOTER_HEIGHT, left: PAGE_MARGIN, right: PAGE_MARGIN },
    bufferPages: true,
    info: {
      Title: data.title,
      Author: "نظام ذكاء الشكاوى",
      Subject: definition.description,
      Keywords: sectionTitles,
    },
  });

  doc.registerFont("Body", regular);
  doc.registerFont("Bold", bold);
  doc.font("Body");

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  renderCoverPage(doc, data);

  const visibleSections = [
    ...data.sections,
    ...fullAnalyticalSections,
  ].filter(sectionHasRenderableContent);
  const hasBody = visibleSections.length > 0
    || (data.type === ReportType.EXECUTIVE_SUMMARY && data.reportMode !== "FULL_ANALYTICAL")
    || warnings.length > 0;
  const continueBelowCover = data.reportMode === "FULL_ANALYTICAL";
  if (hasBody && !continueBelowCover) doc.addPage();

  for (const section of visibleSections) {
    await renderSection(doc, section, warnings);
    doc.moveDown(0.8);
  }

  if (data.type === ReportType.EXECUTIVE_SUMMARY && data.reportMode !== "FULL_ANALYTICAL") {
    renderMethodologyNote(doc);
  }

  // Rendered last so it reflects render-time failures collected above.
  if (warnings.length > 0) {
    renderWarnings(doc, warnings);
  }

  drawFooters(doc, data.title, shortRunId(data.reportRunId));
  doc.end();

  const buffer = await done;
  return { buffer, warnings };
}

async function renderSection(
  doc: PDFKit.PDFDocument,
  section: ReportSection,
  warnings: string[]
): Promise<void> {
  ensureSpace(doc, 60);
  if (section.kind === "kpi") {
    drawSectionTitle(doc, section.title);
    drawKpiGrid(doc, section.cards);
    return;
  }
  if (section.kind === "text") {
    drawTextSection(doc, section);
    return;
  }
  if (section.kind === "chart") {
    await drawChartSection(doc, section, warnings);
    return;
  }
  if (section.kind === "matrix") {
    drawMatrixSection(doc, section);
    return;
  }
  // table
  drawSectionTitle(doc, section.title);
  try {
    drawTable(doc, section.table);
  } catch {
    warnings.push(`تعذر عرض جدول "${section.title}" بالكامل.`);
  }
  if (section.table.truncated) {
    doc.moveDown(0.2);
    doc.font("Body").fontSize(8).fillColor(COLORS.danger);
    doc.text(`تم عرض ${section.table.rows.length} من أصل ${section.table.totalMatched} صفاً.`, { align: "right" });
    doc.fillColor(COLORS.primary);
  }
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function sectionHasRenderableContent(section: ReportSection): boolean {
  if (section.kind === "kpi") return section.cards.length > 0;
  if (section.kind === "text") return section.points.some((point) => point.trim().length > 0);
  if (section.kind === "chart") {
    return section.series.some((series) => series.points.length > 0);
  }
  if (section.kind === "matrix") {
    return section.rowHeaders.length > 0 && section.columnHeaders.length > 0;
  }
  return section.table.columns.length > 0 && section.table.rows.length > 0;
}

function buildFullAnalyticalPdfSections(data: ReportData): ReportSection[] {
  if (data.reportMode !== "FULL_ANALYTICAL" || !data.briefData || !isFullAnalyticalData(data.briefData)) {
    return [];
  }
  const full = data.briefData;
  const sections: ReportSection[] = [
    {
      id: "full_net_backlog_flow",
      kind: "kpi",
      title: "صافي تدفق التراكم",
      cards: [
        { key: "inflow", label: "الوارد", value: full.netBacklogFlow.inflow, format: "number" },
        { key: "outflow", label: "المغلق خلال الفترة", value: full.netBacklogFlow.outflow, format: "number" },
        { key: "net", label: "صافي التغير", value: full.netBacklogFlow.net, format: "number" },
      ],
    },
    {
      id: "full_performance_volume",
      kind: "table",
      title: "الأداء مقابل الحجم",
      table: {
        id: "full_performance_volume",
        title: "الأداء مقابل الحجم",
        columns: [
          { key: "entityName", label: "الجهة", format: "text" },
          { key: "totalComplaints", label: "إجمالي الشكاوى", format: "number" },
          { key: "complianceRate", label: "الالتزام", format: "percent" },
          { key: "averageResolutionDays", label: "متوسط الإغلاق", format: "number" },
          { key: "currentlyLate", label: "المتأخرة", format: "number" },
          { key: "share", label: "المساهمة", format: "percent" },
        ],
        rows: full.perfVolumeRows,
        truncated: false,
        totalMatched: full.perfVolumeRows.length,
      },
    },
  ];
  if (data.previousPeriod && full.continuityRows.length > 0) {
    sections.push({
      id: "full_continuity",
      kind: "table",
      title: "الاستمرارية",
      table: {
        id: "full_continuity",
        title: "الاستمرارية",
        columns: [
          { key: "departmentName", label: "الإدارة", format: "text" },
          { key: "classificationName", label: "التصنيف", format: "text" },
          { key: "currentCount", label: "الحالي", format: "number" },
          { key: "previousCount", label: "السابق", format: "number" },
          { key: "recurrenceType", label: "النوع", format: "text" },
        ],
        rows: full.continuityRows,
        truncated: false,
        totalMatched: full.continuityRows.length,
      },
    });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Cover page
// ---------------------------------------------------------------------------

function renderCoverPage(doc: PDFKit.PDFDocument, data: ReportData): void {
  const definition = getReportDefinition(data.type);
  const top = doc.y;

  doc.font("Bold").fontSize(12).fillColor(COLORS.primary);
  doc.text("نظام ذكاء الشكاوى", PAGE_MARGIN, top + 6, { width: CONTENT_WIDTH, align: "right" });

  doc.moveDown(1.2);
  doc.font("Bold").fontSize(22).fillColor(COLORS.primary);
  doc.text(data.title, { width: CONTENT_WIDTH, align: "right" });

  doc.font("Body").fontSize(11).fillColor(COLORS.neutral);
  doc.text(definition.description, { width: CONTENT_WIDTH, align: "right" });
  doc.moveDown(0.8);

  doc.fontSize(10).fillColor(COLORS.primary);
  const metaLines: string[] = [
    `نوع التقرير: ${REPORT_TYPE_LABEL[data.type]}`,
    `الفترة الحالية: من ${data.period.from} إلى ${data.period.to}`,
  ];
  if (data.previousPeriod) {
    metaLines.push(`الفترة المرجعية للمقارنة: من ${data.previousPeriod.from} إلى ${data.previousPeriod.to}`);
  }
  metaLines.push(`تاريخ الإنشاء: ${formatRiyadhDateTime(new Date(data.generatedAt))}`);
  const runId = shortRunId(data.reportRunId);
  if (runId) metaLines.push(`تشغيل: ${runId}`);
  for (const line of metaLines) {
    doc.text(line, { width: CONTENT_WIDTH, align: "right" });
  }

  renderFilterLine(doc, data);

  doc.fillColor(COLORS.primary);
  doc.moveDown(0.5);
  separator(doc);
  doc.moveDown(0.5);

}

function renderFilterLine(doc: PDFKit.PDFDocument, data: ReportData): void {
  const entries = Object.entries(data.filters).filter(([key, value]) => key !== "from" && key !== "to" && value);
  if (entries.length === 0) return;
  const text = entries.map(([key, value]) => `${FILTER_LABELS[key] ?? key}: ${toDisplayText(value)}`).join(" | ");
  doc.font("Body").fontSize(9).fillColor(COLORS.neutral);
  doc.text(`الفلاتر المطبقة: ${text}`, { width: CONTENT_WIDTH, align: "right" });
  doc.fillColor(COLORS.primary);
}

function separator(doc: PDFKit.PDFDocument): void {
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_SIZE[0] - PAGE_MARGIN, doc.y).strokeColor(COLORS.border).stroke();
  doc.strokeColor(COLORS.primary);
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderWarnings(doc: PDFKit.PDFDocument, warnings: string[]): void {
  ensureSpace(doc, 20 + warnings.length * 14);
  doc.font("Bold").fontSize(9).fillColor(COLORS.danger);
  doc.text("تنبيهات:", { width: CONTENT_WIDTH, align: "right" });
  doc.font("Body").fontSize(9);
  for (const warning of warnings) {
    doc.text(`• ${warning}`, { width: CONTENT_WIDTH, align: "right" });
  }
  doc.fillColor(COLORS.primary);
  doc.moveDown(0.6);
}

function renderMethodologyNote(doc: PDFKit.PDFDocument): void {
  const bullets = [
    "الفترة الحالية هي المدة المحددة في التقرير، والفترة السابقة هي مدة مماثلة لها في الطول وتسبقها مباشرة دون تداخل.",
    "الفرق = عدد الشكاوى في الفترة الحالية ناقص عددها في الفترة السابقة، ونسبة التغير = الفرق مقسوماً على عدد الفترة السابقة ضرب 100.",
    'عند غياب أي شكاوى في الفترة السابقة تُصنَّف الحالة كـ "جديد" ولا تُحتسب نسبة تغير تفادياً للقسمة على صفر.',
    "مساهمة التصنيف تعني نسبة ارتفاع هذا التصنيف من مجموع ارتفاعات تصنيفات الإدارة نفسها (الفروق الموجبة فقط).",
    "حجم الشكاوى مؤشر كمّي يوضّح الاتجاه، وليس حكماً منفرداً على الأداء.",
    `يعرض الرسم البياني أعلى ${MAX_TREND_SERIES} مناطق كحد أقصى، ويعرض جدول الارتفاعات ${DEPT_CLASS_RISES_LIMIT} صفاً كحد أقصى.`,
  ];
  ensureSpace(doc, 30 + bullets.length * 26);
  drawSectionTitle(doc, "منهجية الاحتساب");
  doc.font("Body").fontSize(9).fillColor(COLORS.primary);
  for (const bullet of bullets) {
    doc.text(`• ${bullet}`, { width: CONTENT_WIDTH, align: "right" });
    doc.moveDown(0.2);
  }
  doc.fillColor(COLORS.primary);
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 24);
  doc.font("Bold").fontSize(13).fillColor(COLORS.primary);
  doc.text(title, { width: CONTENT_WIDTH, align: "right" });
  doc.fillColor(COLORS.primary);
  doc.moveDown(0.3);
}

function drawTextSection(doc: PDFKit.PDFDocument, section: ReportTextSection): void {
  drawSectionTitle(doc, section.title);
  doc.font("Body").fontSize(10.5).fillColor(COLORS.primary);
  for (const point of section.points) {
    if (!point?.trim()) continue;
    ensureSpace(doc, 18);
    doc.text(`•  ${point}`, PAGE_MARGIN + 8, doc.y, { width: CONTENT_WIDTH - 8, align: "right" });
    doc.moveDown(0.2);
  }
  doc.fillColor(COLORS.primary);
}

function drawMatrixSection(
  doc: PDFKit.PDFDocument,
  section: ReportMatrixSection
): void {
  drawSectionTitle(doc, section.title);
  if (section.description) {
    doc.font("Body").fontSize(9).fillColor(COLORS.neutral);
    doc.text(section.description, { width: CONTENT_WIDTH, align: "right" });
    doc.fillColor(COLORS.primary);
    doc.moveDown(0.2);
  }

  const { rowHeaders, columnHeaders, cells } = section;
  if (rowHeaders.length === 0 || columnHeaders.length === 0) {
    doc.font("Body").fontSize(9).fillColor(COLORS.neutral);
    doc.text("لا توجد بيانات لعرضها.", { width: CONTENT_WIDTH, align: "right" });
    doc.fillColor(COLORS.primary);
    return;
  }

  const headerColWidth = 90;
  const cellWidth = Math.max(
    36,
    Math.floor((CONTENT_WIDTH - headerColWidth) / columnHeaders.length)
  );
  const rowHeight = 16;
  const headerHeight = 20;
  const fontSize = 7.5;

  // RTL layout: row label column at the right, data columns extend leftward.
  const tableRight = PAGE_SIZE[0] - PAGE_MARGIN;
  const rowLabelX = tableRight - headerColWidth;

  function drawColumnHeaders(): void {
    const top = doc.y;
    doc.font("Bold").fontSize(fontSize).fillColor(COLORS.primary);
    // Row/column label in the top-right corner cell
    doc.text(`${section.rowLabel} / ${section.columnLabel}`, rowLabelX + 2, top + 4, {
      width: headerColWidth - 4,
      height: headerHeight - 4,
      align: "right",
      lineBreak: false,
      ellipsis: true,
    });
    // Column headers extend leftward from rowLabelX
    columnHeaders.forEach((colHeader, ci) => {
      const x = rowLabelX - (ci + 1) * cellWidth;
      doc.text(colHeader, x + 2, top + 4, {
        width: cellWidth - 4,
        height: headerHeight - 4,
        align: "center",
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.y = top + headerHeight;
    doc.moveTo(PAGE_MARGIN, doc.y)
      .lineTo(tableRight, doc.y)
      .strokeColor(COLORS.border)
      .stroke();
    doc.strokeColor(COLORS.primary);
  }

  ensureSpace(doc, headerHeight + rowHeight * Math.min(rowHeaders.length + 1, 12));
  drawColumnHeaders();

  rowHeaders.forEach((rowHeader, ri) => {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawColumnHeaders();
    }
    const rowTop = doc.y;
    if (ri % 2 === 1) {
      doc.rect(PAGE_MARGIN, rowTop, CONTENT_WIDTH, rowHeight).fill(COLORS.tableRowAlternate);
      doc.fillColor(COLORS.primary);
    }
    // Row label at the right
    doc.font("Bold").fontSize(fontSize).fillColor(COLORS.primary);
    doc.text(rowHeader, rowLabelX + 2, rowTop + 3, {
      width: headerColWidth - 4,
      height: rowHeight - 3,
      align: "right",
      lineBreak: false,
      ellipsis: true,
    });
    // Data cells extend leftward
    doc.font("Body").fontSize(fontSize).fillColor(COLORS.primary);
    const row = cells[ri] ?? [];
    row.forEach((cellValue, ci) => {
      const x = rowLabelX - (ci + 1) * cellWidth;
      doc.text(formatReportNumber(cellValue), x + 2, rowTop + 3, {
        width: cellWidth - 4,
        height: rowHeight - 3,
        align: "center",
        lineBreak: false,
      });
    });
    doc.y = rowTop + rowHeight;
  });

  const truncMsg = buildMatrixTruncationMessage(section);
  if (truncMsg) {
    doc.moveDown(0.2);
    doc.font("Body").fontSize(8).fillColor(COLORS.danger);
    doc.text(truncMsg, { width: CONTENT_WIDTH, align: "right" });
    doc.fillColor(COLORS.primary);
  }
}

async function drawChartSection(
  doc: PDFKit.PDFDocument,
  section: ReportChartSection,
  warnings: string[]
): Promise<void> {
  drawSectionTitle(doc, section.title);
  if (section.description) {
    doc.font("Body").fontSize(9).fillColor(COLORS.neutral);
    doc.text(section.description, { width: CONTENT_WIDTH, align: "right" });
    doc.fillColor(COLORS.primary);
    doc.moveDown(0.2);
  }

  const widthPx = 1000;
  const heightPx = 560;
  const displayWidth = CONTENT_WIDTH;
  const displayHeight = (heightPx / widthPx) * displayWidth;

  ensureSpace(doc, displayHeight + 10);

  try {
    const png = await renderLineChartPng(section, widthPx, heightPx);
    doc.image(png, PAGE_MARGIN, doc.y, { width: displayWidth, height: displayHeight });
    doc.y += displayHeight;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Never leave a silent blank space: draw a visible placeholder box.
    const boxHeight = 60;
    const top = doc.y;
    doc.rect(PAGE_MARGIN, top, CONTENT_WIDTH, boxHeight).fillAndStroke(COLORS.background, COLORS.danger);
    doc.font("Body").fontSize(11).fillColor(COLORS.danger);
    doc.text("تعذر عرض الرسم البياني", PAGE_MARGIN + 8, top + 22, { width: CONTENT_WIDTH - 16, align: "center" });
    doc.fillColor(COLORS.primary);
    doc.y = top + boxHeight;
    warnings.push(`تعذر عرض الرسم البياني "${section.title}": ${reason}`);
  }

  if (section.truncated && section.truncatedMessage) {
    doc.moveDown(0.2);
    doc.font("Body").fontSize(8).fillColor(COLORS.danger);
    doc.text(section.truncatedMessage, { width: CONTENT_WIDTH, align: "right" });
    doc.fillColor(COLORS.primary);
  }
}

function drawKpiGrid(doc: PDFKit.PDFDocument, cards: ReportKpiCard[], columns = 3): void {
  const gap = 10;
  const cardWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const cardHeight = 46;

  for (let i = 0; i < cards.length; i += columns) {
    ensureSpace(doc, cardHeight + 8);
    const rowCards = cards.slice(i, i + columns);
    const rowTop = doc.y;
    rowCards.forEach((card, index) => {
      // Right-to-left grid: first card sits at the rightmost slot.
      const slot = columns - 1 - index;
      const x = PAGE_MARGIN + slot * (cardWidth + gap);
      doc.roundedRect(x, rowTop, cardWidth, cardHeight, REPORT_DESIGN_TOKENS.card.radius).fillAndStroke(COLORS.background, COLORS.border);
      doc.font("Body").fontSize(8).fillColor(COLORS.neutral);
      doc.text(card.label, x + 6, rowTop + 6, {
        width: cardWidth - 12,
        height: 14,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
      doc.font("Bold").fontSize(14).fillColor(COLORS.primary);
      doc.text(formatKpiValue(card), x + 6, rowTop + 20, {
        width: cardWidth - 12,
        height: 18,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
    doc.y = rowTop + cardHeight + 8;
  }
}

// ---------------------------------------------------------------------------
// Flex-width tables with 2-line wrapping
// ---------------------------------------------------------------------------

function columnFixedWidth(column: ReportTableColumn): number | null {
  switch (column.format) {
    case "number":
    case "signed-number":
      return COL_NUMBER_WIDTH;
    case "percent":
      return COL_PERCENT_WIDTH;
    case "date":
      return COL_DATE_WIDTH;
    default:
      return null; // text -> flexible
  }
}

/** Direction-style short text columns get a narrow fixed width. */
function isDirectionColumn(column: ReportTableColumn): boolean {
  return column.key === "direction";
}

function computeColumnWidths(columns: ReportTableColumn[]): number[] {
  const widths = columns.map((column) => {
    if (isDirectionColumn(column)) return COL_DIRECTION_WIDTH;
    return columnFixedWidth(column);
  });

  const fixedTotal = widths.reduce<number>((sum, width) => sum + (width ?? 0), 0);
  const flexCount = widths.filter((width) => width === null).length;
  const remaining = CONTENT_WIDTH - fixedTotal;

  if (flexCount === 0) {
    // No flexible columns: scale fixed columns to fill width.
    const scale = CONTENT_WIDTH / (fixedTotal || CONTENT_WIDTH);
    return widths.map((width) => (width ?? 0) * scale);
  }

  const flexWidth = Math.max(COL_MIN_TEXT_WIDTH, remaining / flexCount);
  return widths.map((width) => width ?? flexWidth);
}

/** Estimates the number of wrapped lines a cell will need (capped at max). */
function estimateLines(doc: PDFKit.PDFDocument, text: string, width: number, fontSize: number): number {
  doc.fontSize(fontSize);
  const textWidth = doc.widthOfString(text);
  const lines = Math.ceil(textWidth / Math.max(1, width - 4));
  return Math.min(Math.max(1, lines), TABLE_ROW_MAX_LINES);
}

function drawTable(doc: PDFKit.PDFDocument, table: ReportTable): void {
  if (table.columns.length === 0 || table.rows.length === 0) {
    doc.font("Body").fontSize(9).fillColor(COLORS.neutral);
    doc.text("لا توجد بيانات لعرضها.", { width: CONTENT_WIDTH, align: "right" });
    doc.fillColor(COLORS.primary);
    return;
  }

  const columns = table.columns;
  const widths = computeColumnWidths(columns);
  // Right-to-left x offset for a column (rightmost column = index 0).
  const xOffsets: number[] = [];
  {
    let cursor = PAGE_SIZE[0] - PAGE_MARGIN;
    for (let i = 0; i < columns.length; i++) {
      cursor -= widths[i];
      xOffsets.push(cursor);
    }
  }

  const headerHeight = 22;
  const lineHeight = 11;
  const cellPadding = 4;

  function drawHeaderRow(): void {
    const top = doc.y;
    doc.font("Bold").fontSize(8.5).fillColor(COLORS.primary);
    columns.forEach((column, index) => {
      doc.text(column.label, xOffsets[index] + 2, top + 5, {
        width: widths[index] - 4,
        height: headerHeight - 8,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.y = top + headerHeight;
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_SIZE[0] - PAGE_MARGIN, doc.y).strokeColor(COLORS.border).stroke();
    doc.strokeColor(COLORS.primary);
    doc.fillColor(COLORS.primary);
  }

  ensureSpace(doc, headerHeight + 24);
  drawHeaderRow();

  doc.font("Body").fontSize(8.5);
  table.rows.forEach((row, rowIndex) => {
    // Compute dynamic row height (up to 2 lines).
    const cellTexts = columns.map((column) => formatCellValue(row[column.key], column.format));
    const maxLines = columns.reduce(
      (max, column, index) => Math.max(max, estimateLines(doc, cellTexts[index], widths[index], 8.5)),
      1
    );
    const rowHeight = maxLines * lineHeight + cellPadding * 2;

    // Never split a row across pages: if it doesn't fit, start a new page.
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeaderRow();
      doc.font("Body").fontSize(8.5);
    }
    const top = doc.y;
    if (rowIndex % 2 === 1) {
      doc.rect(PAGE_MARGIN, top, CONTENT_WIDTH, rowHeight).fill(COLORS.tableRowAlternate);
      doc.fillColor(COLORS.primary);
    }
    columns.forEach((column, index) => {
      doc.text(cellTexts[index], xOffsets[index] + 2, top + cellPadding, {
        width: widths[index] - 4,
        height: rowHeight - cellPadding,
        align: "right",
        lineGap: 0,
        ellipsis: true,
      });
    });
    doc.y = top + rowHeight;
  });
}

function drawFooters(doc: PDFKit.PDFDocument, title: string, runId: string): void {
  const range = doc.bufferedPageRange();
  const runPart = runId ? ` — تشغيل: ${runId}` : "";
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const pageNumber = i - range.start + 1;
    const y = doc.page.height - PAGE_MARGIN - 14;
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Body").fontSize(8).fillColor(COLORS.neutral);
    doc.text(`${title}${runPart} — صفحة ${pageNumber} من ${range.count}`, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH,
      align: "center",
      lineBreak: false,
    });
    doc.page.margins.bottom = originalBottomMargin;
    doc.fillColor(COLORS.primary);
  }
}
