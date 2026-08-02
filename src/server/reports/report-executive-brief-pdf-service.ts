import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  EXECUTIVE_BRIEF_PAGE_PLAN,
  type ClassificationBriefRow,
  type ExecutiveBriefKpiCard,
  type ExecutiveBriefPreviewPage,
  type KpiAssessment,
  type RegionReferenceRow,
} from "@/lib/reports/report-contract";
import {
  DIGITAL_EXECUTIVE_PAGE_SIZE,
  directionColor,
  directionFromAssessment,
  formatNullableReportNumber,
  formatReportNumber,
  PRINT_EXECUTIVE_PAGE_SIZE,
  REPORT_DESIGN_TOKENS,
  type ExecutiveDirection,
} from "@/lib/reports/design-tokens";
import { getReportDefinition } from "./report-definition-service";
import type { ExecutiveBriefData, ReportData } from "./report-data-service";
import { renderLineChartPng } from "./report-chart-service";
import { formatRiyadhDateTime } from "./report-time";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const COLORS = REPORT_DESIGN_TOKENS.colors;
const PAGE_COUNT = 3;

let fontRegularBuffer: Buffer | null = null;
let fontBoldBuffer: Buffer | null = null;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!fontRegularBuffer) fontRegularBuffer = fs.readFileSync(FONT_REGULAR_PATH);
  if (!fontBoldBuffer) fontBoldBuffer = fs.readFileSync(FONT_BOLD_PATH);
  return { regular: fontRegularBuffer, bold: fontBoldBuffer };
}

export type ExecutiveBriefPdfResult = {
  buffer: Buffer;
  warnings: string[];
};

type ExecutiveBriefMode = "DIGITAL_EXECUTIVE_BRIEF" | "PRINT_EXECUTIVE_BRIEF";

type ExecutiveVisual =
  | "comparison-cards"
  | "bar-chart"
  | "line-chart"
  | "status-distribution"
  | "category-donut"
  | "commitment-gauge";

type BriefPageLayout = {
  pageSize: readonly [number, number];
  margin: number;
  contentWidth: number;
  compact: boolean;
};

type ExecutiveBriefRenderContext = {
  doc: PDFKit.PDFDocument;
  data: ReportData;
  brief: ExecutiveBriefData;
  warnings: string[];
  layout: BriefPageLayout;
  mode: ExecutiveBriefMode;
};

type ColumnDefinition<Row> = {
  key: keyof Row;
  label: string;
  weight: number;
};

type DrawTableOptions<Row> = {
  doc: PDFKit.PDFDocument;
  rows: readonly Row[];
  columns: readonly ColumnDefinition<Row>[];
  x: number;
  y: number;
  width: number;
  rowHeight: number;
  fontSize: number;
  maxRows: number;
  formatCell: (row: Row, key: keyof Row) => string;
  directionForRow?: (row: Row) => ExecutiveDirection;
  directionKey?: keyof Row;
};

const EMPTY_BRIEF: ExecutiveBriefData = {
  briefKpis: [],
  allRegions: [],
  topClassifications: [],
  comparativeTimeline: {
    current: { label: "الفترة الحالية", points: [] },
    previous: null,
    periodDays: 0,
  },
  concentrationBands: [],
};

function shortRunId(runId?: string): string {
  return runId?.slice(0, 8) ?? "—";
}

function modeLabel(mode: ExecutiveBriefMode): string {
  return mode === "DIGITAL_EXECUTIVE_BRIEF"
    ? "تنفيذي مختصر — عرض رقمي"
    : "تنفيذي مختصر — طباعة";
}

function createLayout(mode: ExecutiveBriefMode): BriefPageLayout {
  const compact = mode === "PRINT_EXECUTIVE_BRIEF";
  const pageSize = compact ? PRINT_EXECUTIVE_PAGE_SIZE : DIGITAL_EXECUTIVE_PAGE_SIZE;
  const margin = compact ? 30 : 48;
  return {
    pageSize,
    margin,
    contentWidth: pageSize[0] - margin * 2,
    compact,
  };
}

function fontSize(layout: BriefPageLayout, digital: number, print: number): number {
  return layout.compact ? print : digital;
}

function resetInk(doc: PDFKit.PDFDocument): void {
  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
}

function drawDirectionIcon(
  doc: PDFKit.PDFDocument,
  direction: ExecutiveDirection,
  x: number,
  y: number,
  size: number
): void {
  const centerX = x + size / 2;
  const top = y + 2;
  const bottom = y + size - 2;
  const wing = size * 0.28;
  doc.lineWidth(Math.max(1.2, size * 0.12)).lineCap("round").strokeColor(directionColor(direction));
  if (direction === "positive") {
    doc.moveTo(centerX, bottom).lineTo(centerX, top).stroke();
    doc.moveTo(centerX, top).lineTo(centerX - wing, top + wing).stroke();
    doc.moveTo(centerX, top).lineTo(centerX + wing, top + wing).stroke();
  } else if (direction === "negative") {
    doc.moveTo(centerX, top).lineTo(centerX, bottom).stroke();
    doc.moveTo(centerX, bottom).lineTo(centerX - wing, bottom - wing).stroke();
    doc.moveTo(centerX, bottom).lineTo(centerX + wing, bottom - wing).stroke();
  } else {
    doc.moveTo(x + 2, y + size / 2).lineTo(x + size - 2, y + size / 2).stroke();
  }
  doc.lineWidth(1).lineCap("butt");
  resetInk(doc);
}

function formatKpiValue(card: ExecutiveBriefKpiCard): string {
  if (card.format === "percent") {
    return formatReportNumber(card.value, { percent: true });
  }
  if (card.format === "days") {
    return `${formatReportNumber(card.value)} يوم`;
  }
  return formatReportNumber(card.value);
}

function formatKpiDelta(difference: number, changeRate: number | null): string {
  const differenceText = formatReportNumber(difference, { sign: true });
  if (changeRate === null) return differenceText;
  return `${differenceText}  (${formatReportNumber(changeRate, { sign: true, percent: true })})`;
}

function drawPageHeader(
  context: ExecutiveBriefRenderContext,
  pageTitle: string
): number {
  const { doc, data, layout, mode } = context;
  const { margin, contentWidth } = layout;
  const titleSize = fontSize(layout, REPORT_DESIGN_TOKENS.fontSize.reportTitle, 20);
  doc.font("Bold").fontSize(titleSize).fillColor(COLORS.primary);
  doc.text(pageTitle, margin, margin, { width: contentWidth, align: "right" });

  const metaY = margin + fontSize(layout, 42, 30);
  doc.font("Body").fontSize(fontSize(layout, 10.5, 8.5)).fillColor(COLORS.neutral);
  const previous = data.previousPeriod
    ? ` | المرجع: ${data.previousPeriod.from} – ${data.previousPeriod.to}`
    : " | لا تتوفر فترة مرجعية للمقارنة";
  const meta = `نظام ذكاء الشكاوى | نوع التقرير: ${modeLabel(mode)} | الفترة: ${data.period.from} – ${data.period.to}${previous}`;
  doc.text(meta, margin, metaY, { width: contentWidth, align: "right" });
  const generated = `الإنشاء بتوقيت الرياض: ${formatRiyadhDateTime(new Date(data.generatedAt))} | التشغيل: ${shortRunId(data.reportRunId)}`;
  doc.text(generated, margin, metaY + fontSize(layout, 18, 14), {
    width: contentWidth,
    align: "right",
  });
  const lineY = metaY + fontSize(layout, 42, 32);
  doc.moveTo(margin, lineY)
    .lineTo(margin + contentWidth, lineY)
    .strokeColor(COLORS.border)
    .stroke();
  resetInk(doc);
  return lineY + fontSize(layout, 16, 10);
}

function drawSectionTitle(
  doc: PDFKit.PDFDocument,
  title: string,
  x: number,
  y: number,
  width: number,
  layout: BriefPageLayout
): number {
  doc.font("Bold").fontSize(fontSize(layout, 15, 11)).fillColor(COLORS.primary);
  doc.text(title, x, y, { width, align: "right" });
  return y + fontSize(layout, 25, 18);
}

function drawCommitmentGauge(
  doc: PDFKit.PDFDocument,
  card: ExecutiveBriefKpiCard,
  x: number,
  y: number,
  compact: boolean
): void {
  const gaugeWidth = compact ? 52 : 76;
  const centerX = x + gaugeWidth / 2;
  const baseline = y + (compact ? 40 : 54);
  const radius = gaugeWidth / 2 - 4;
  const thickness = compact ? 5 : 7;
  const clamped = Math.max(0, Math.min(100, card.value));
  const endX = centerX - radius * Math.cos(Math.PI * clamped / 100);
  const endY = baseline - radius * Math.sin(Math.PI * clamped / 100);
  doc.lineWidth(thickness).lineCap("round");
  doc.path(`M ${centerX - radius} ${baseline} A ${radius} ${radius} 0 0 1 ${centerX + radius} ${baseline}`)
    .strokeColor(COLORS.border)
    .stroke();
  doc.path(`M ${centerX - radius} ${baseline} A ${radius} ${radius} 0 0 1 ${endX} ${endY}`)
    .strokeColor(directionColor(directionFromAssessment(card.assessment)))
    .stroke();
  doc.lineWidth(1).lineCap("butt");
  resetInk(doc);
  doc.font("Bold").fontSize(compact ? 8 : 10).fillColor(COLORS.primary);
  doc.text(formatReportNumber(card.value, { percent: true }), x, baseline - 3, {
    width: gaugeWidth,
    align: "center",
    lineBreak: false,
  });
}

function drawKpiCard(
  doc: PDFKit.PDFDocument,
  card: ExecutiveBriefKpiCard,
  x: number,
  y: number,
  width: number,
  height: number,
  layout: BriefPageLayout
): void {
  const radius = REPORT_DESIGN_TOKENS.card.radius;
  const padding = layout.compact ? 8 : REPORT_DESIGN_TOKENS.card.padding;
  doc.roundedRect(x, y, width, height, radius)
    .fillAndStroke(COLORS.background, COLORS.border);
  const hasGauge = card.key === "complianceRate";
  let gaugeWidth = 0;
  if (hasGauge) {
    gaugeWidth = layout.compact ? 60 : 86;
  }
  doc.font("Body").fontSize(fontSize(layout, 10.5, 8.5)).fillColor(COLORS.neutral);
  doc.text(card.label, x + padding + gaugeWidth, y + padding, {
    width: width - padding * 2 - gaugeWidth,
    align: "right",
    height: fontSize(layout, 18, 13),
    ellipsis: true,
  });
  doc.font("Bold").fontSize(fontSize(layout, 24, 17)).fillColor(COLORS.primary);
  doc.text(formatKpiValue(card), x + padding + gaugeWidth, y + fontSize(layout, 34, 25), {
    width: width - padding * 2 - gaugeWidth,
    align: "right",
    height: fontSize(layout, 32, 22),
    lineBreak: false,
  });
  if (hasGauge) drawCommitmentGauge(doc, card, x + padding, y + 5, layout.compact);
  if (card.difference !== null) {
    const direction = directionFromAssessment(card.assessment);
    const deltaY = y + height - fontSize(layout, 25, 18);
    drawDirectionIcon(doc, direction, x + padding, deltaY - 2, fontSize(layout, 13, 10));
    doc.font("Body").fontSize(fontSize(layout, 9, 7.8)).fillColor(directionColor(direction));
    const previous = card.previousValue === null
      ? ""
      : ` | السابق ${formatReportNumber(card.previousValue)}`;
    doc.text(`${formatKpiDelta(card.difference, card.changeRate)}${previous}`, x + padding + 20, deltaY, {
      width: width - padding * 2 - 20,
      align: "right",
      lineBreak: false,
      ellipsis: true,
    });
  }
  resetInk(doc);
}

function drawKpiGrid(
  doc: PDFKit.PDFDocument,
  cards: readonly ExecutiveBriefKpiCard[],
  layout: BriefPageLayout,
  startY: number
): number {
  const selectedCards = cards.slice(0, layout.compact ? 6 : 7);
  const columns = layout.compact ? 3 : 4;
  const gap = layout.compact ? 8 : 12;
  const cardHeight = layout.compact ? 68 : 92;
  const width = (layout.contentWidth - gap * (columns - 1)) / columns;
  selectedCards.forEach((card, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const slot = columns - 1 - col;
    const x = layout.margin + slot * (width + gap);
    drawKpiCard(doc, card, x, startY + row * (cardHeight + gap), width, cardHeight, layout);
  });
  const rows = Math.max(1, Math.ceil(selectedCards.length / columns));
  return startY + rows * cardHeight + (rows - 1) * gap + gap;
}

function drawExecutiveSummary(
  context: ExecutiveBriefRenderContext,
  startY: number
): number {
  const { doc, data, layout } = context;
  const section = data.sections.find((candidate) => candidate.kind === "text");
  const points = section?.kind === "text"
    ? section.points.filter((point) => point.trim()).slice(0, 5)
    : [];
  let y = drawSectionTitle(doc, "الملخص التنفيذي", layout.margin, startY, layout.contentWidth, layout);
  if (points.length === 0) {
    doc.font("Body").fontSize(fontSize(layout, 10, 8.5)).fillColor(COLORS.neutral);
    doc.text("لا توجد بيانات كافية لصياغة ملخص تنفيذي موثوق.", layout.margin, y, {
      width: layout.contentWidth,
      align: "right",
    });
    return y + fontSize(layout, 28, 20);
  }
  const columns = points.length > 3 && !layout.compact ? 2 : 1;
  const gap = layout.compact ? 4 : 10;
  const columnWidth = (layout.contentWidth - gap) / columns;
  const rowHeight = fontSize(layout, 28, 20);
  points.forEach((point, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = layout.margin + (columns - 1 - column) * (columnWidth + gap);
    doc.font("Body").fontSize(fontSize(layout, 10.5, 8.5)).fillColor(COLORS.primary);
    doc.text(`• ${point}`, x, y + row * rowHeight, {
      width: columnWidth,
      height: rowHeight,
      align: "right",
      ellipsis: true,
    });
  });
  return y + Math.ceil(points.length / columns) * rowHeight + gap;
}

function hasReferencePeriod(context: ExecutiveBriefRenderContext): boolean {
  return context.data.previousPeriod != null;
}

function hasUsefulComparison(context: ExecutiveBriefRenderContext): boolean {
  if (!hasReferencePeriod(context)) return false;
  const totalCurrent = context.brief.allRegions.reduce((sum, row) => sum + row.currentCount, 0);
  return context.brief.allRegions.length >= 3
    && totalCurrent >= 10;
}

function briefPageTitle(page: ExecutiveBriefPreviewPage): string {
  return EXECUTIVE_BRIEF_PAGE_PLAN[page - 1].title;
}

function selectPage1Visual(context: ExecutiveBriefRenderContext): ExecutiveVisual {
  return hasUsefulComparison(context) ? "line-chart" : "comparison-cards";
}

async function drawPage1Visual(
  context: ExecutiveBriefRenderContext,
  startY: number
): Promise<void> {
  const { doc, data, warnings, layout } = context;
  const visual = selectPage1Visual(context);
  const titleY = drawSectionTitle(
    doc,
    visual === "line-chart" ? "المقارنة الإجمالية حسب المنطقة" : "قراءة سريعة للأداء الحالي",
    layout.margin,
    startY,
    layout.contentWidth,
    layout
  );
  const available = layout.pageSize[1] - layout.margin - 34 - titleY;
  if (visual === "comparison-cards") {
    doc.roundedRect(layout.margin, titleY, layout.contentWidth, Math.max(50, available), REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Body").fontSize(fontSize(layout, 11, 9)).fillColor(COLORS.neutral);
    doc.text(
      data.previousPeriod
        ? "لا توجد بيانات كافية لإظهار مقارنة بصرية موثوقة."
        : "لا تتوفر فترة مرجعية للمقارنة؛ تعرض المؤشرات أعلاه أداء الفترة الحالية.",
      layout.margin + 12,
      titleY + Math.max(18, available / 2 - 8),
      { width: layout.contentWidth - 24, align: "center" }
    );
    return;
  }
  const rows = context.brief.allRegions.slice(0, 8);
  const chartHeight = Math.max(90, Math.round(available));
  const chart = {
    id: "executive-region-comparison",
    kind: "chart" as const,
    chartType: "line" as const,
    title: "الحالي مقابل السابق حسب المنطقة",
    series: [
      { name: "الحالي", points: rows.map((row, index) => ({ x: String(index + 1), y: row.currentCount })) },
      { name: "السابق", points: rows.map((row, index) => ({ x: String(index + 1), y: row.previousCount })) },
    ],
  };
  try {
    const png = await renderLineChartPng(chart, Math.round(layout.contentWidth), chartHeight);
    doc.image(png, layout.margin, titleY, {
      width: layout.contentWidth,
      height: chartHeight,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`تعذر رسم مخطط المناطق: ${reason}`);
  }
}

async function renderPage1(context: ExecutiveBriefRenderContext): Promise<void> {
  let y = drawPageHeader(context, `التقرير التنفيذي المختصر — ${briefPageTitle(1)}`);
  y = drawSectionTitle(context.doc, "المؤشرات التنفيذية", context.layout.margin, y, context.layout.contentWidth, context.layout);
  y = drawKpiGrid(context.doc, context.brief.briefKpis, context.layout, y);
  y = drawExecutiveSummary(context, y);
  await drawPage1Visual(context, y);
}

function regionDirection(row: RegionReferenceRow): ExecutiveDirection {
  if (row.currentCount > row.previousCount) return "negative";
  if (row.currentCount < row.previousCount) return "positive";
  return "neutral";
}

function classificationDirection(row: ClassificationBriefRow): ExecutiveDirection {
  if (row.difference > 0) return "negative";
  if (row.difference < 0) return "positive";
  return "neutral";
}

function formatRegionCell(row: RegionReferenceRow, key: keyof RegionReferenceRow): string {
  if (key === "direction") return "";
  if (key === "changeRate" || key === "complianceRate") {
    return formatNullableReportNumber(row[key], { percent: true });
  }
  if (key === "difference") return formatReportNumber(row.difference, { sign: true });
  if (key === "averageResolutionDays") return formatNullableReportNumber(row.averageResolutionDays);
  const value = row[key];
  return typeof value === "number" ? formatReportNumber(value) : String(value);
}

function drawRtlTable<Row>(options: DrawTableOptions<Row>): number {
  const {
    doc, rows, columns, x, y, width, rowHeight, fontSize: tableFontSize,
    maxRows, formatCell, directionForRow, directionKey,
  } = options;
  const shownRows = rows.slice(0, maxRows);
  const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0);
  const widths = columns.map((column) => width * column.weight / totalWeight);
  const offsets: number[] = [];
  let cursor = x + width;
  widths.forEach((columnWidth) => {
    cursor -= columnWidth;
    offsets.push(cursor);
  });
  const headerHeight = rowHeight + 2;
  doc.roundedRect(x, y, width, headerHeight, REPORT_DESIGN_TOKENS.card.radius)
    .fillAndStroke(COLORS.background, COLORS.border);
  doc.font("Bold").fontSize(tableFontSize).fillColor(COLORS.primary);
  columns.forEach((column, index) => {
    doc.text(column.label, offsets[index] + 4, y + 5, {
      width: widths[index] - 8,
      height: headerHeight - 7,
      align: "right",
      ellipsis: true,
    });
  });
  let rowY = y + headerHeight;
  shownRows.forEach((row, rowIndex) => {
    if (rowIndex % 2 === 1) {
      doc.rect(x, rowY, width, rowHeight).fill(COLORS.tableRowAlternate);
    }
    doc.moveTo(x, rowY + rowHeight).lineTo(x + width, rowY + rowHeight)
      .strokeColor(COLORS.border).stroke();
    doc.font("Body").fontSize(tableFontSize).fillColor(COLORS.primary);
    columns.forEach((column, columnIndex) => {
      if (directionKey === column.key && directionForRow) {
        drawDirectionIcon(
          doc,
          directionForRow(row),
          offsets[columnIndex] + widths[columnIndex] / 2 - tableFontSize,
          rowY + 2,
          tableFontSize + 1
        );
        return;
      }
      doc.text(formatCell(row, column.key), offsets[columnIndex] + 4, rowY + 5, {
        width: widths[columnIndex] - 8,
        height: rowHeight - 6,
        align: "right",
        ellipsis: true,
      });
    });
    rowY += rowHeight;
  });
  resetInk(doc);
  return rowY;
}

const REGION_COLUMNS: readonly ColumnDefinition<RegionReferenceRow>[] = [
  { key: "regionName", label: "المنطقة", weight: 2.2 },
  { key: "currentCount", label: "الحالي", weight: 0.85 },
  { key: "previousCount", label: "السابق", weight: 0.85 },
  { key: "difference", label: "الفرق", weight: 0.8 },
  { key: "changeRate", label: "التغير", weight: 0.95 },
  { key: "currentlyLate", label: "المتأخرة", weight: 0.9 },
  { key: "complianceRate", label: "الالتزام", weight: 1 },
  { key: "direction", label: "الاتجاه", weight: 0.75 },
];

function drawComparisonCards(
  context: ExecutiveBriefRenderContext,
  startY: number
): void {
  const { doc, brief, layout } = context;
  const regions = brief.allRegions;
  const candidates = [
    { label: "أعلى ارتفاع", row: [...regions].sort((a, b) => b.difference - a.difference)[0] },
    { label: "أكبر انخفاض", row: [...regions].sort((a, b) => a.difference - b.difference)[0] },
    { label: "أعلى تأخر", row: [...regions].sort((a, b) => b.currentlyLate - a.currentlyLate)[0] },
    { label: "أفضل التزام", row: [...regions].sort((a, b) => (b.complianceRate ?? -1) - (a.complianceRate ?? -1))[0] },
  ];
  const gap = layout.compact ? 8 : 12;
  const columns = 2;
  const cardWidth = (layout.contentWidth - gap * (columns - 1)) / columns;
  const cardHeight = layout.compact ? 72 : 120;
  candidates.forEach((candidate, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = layout.margin + (columns - 1 - column) * (cardWidth + gap);
    const cardY = startY + row * (cardHeight + gap);
    doc.roundedRect(x, cardY, cardWidth, cardHeight, REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Body").fontSize(fontSize(layout, 9, 7.5)).fillColor(COLORS.neutral);
    doc.text(candidate.label, x + 8, cardY + 8, { width: cardWidth - 16, align: "right" });
    doc.font("Bold").fontSize(fontSize(layout, 13, 10)).fillColor(COLORS.primary);
    doc.text(candidate.row?.regionName ?? "لا توجد بيانات", x + 8, cardY + 27, {
      width: cardWidth - 34,
      align: "right",
      height: fontSize(layout, 22, 16),
      ellipsis: true,
    });
    if (candidate.row && hasReferencePeriod(context)) {
      drawDirectionIcon(doc, regionDirection(candidate.row), x + 8, cardY + 25, fontSize(layout, 13, 10));
      doc.font("Body").fontSize(fontSize(layout, 9.5, 8)).fillColor(COLORS.neutral);
      doc.text(
        `الحالي ${formatReportNumber(candidate.row.currentCount)} | الفرق ${formatReportNumber(candidate.row.difference, { sign: true })}`,
        x + 8,
        cardY + fontSize(layout, 58, 43),
        { width: cardWidth - 16, align: "right", height: fontSize(layout, 22, 17), ellipsis: true }
      );
    }
  });
}

function resolveRegionRowHeight(layout: BriefPageLayout, regionCount: number): number {
  if (regionCount <= 3) return layout.compact ? 30 : 58;
  if (regionCount <= 5) return layout.compact ? 25 : 40;
  return layout.compact ? 22 : 28;
}

function renderPage2(context: ExecutiveBriefRenderContext): void {
  const { doc, brief, layout } = context;
  let y = drawPageHeader(context, briefPageTitle(2));
  if (!hasReferencePeriod(context)) {
    doc.roundedRect(layout.margin, y, layout.contentWidth, fontSize(layout, 54, 38), REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Body").fontSize(fontSize(layout, 12, 9)).fillColor(COLORS.neutral);
    doc.text("لا تتوفر فترة مرجعية للمقارنة. يعرض الجدول أداء الفترة الحالية فقط.", layout.margin + 12, y + 16, {
      width: layout.contentWidth - 24,
      align: "center",
    });
    y += fontSize(layout, 66, 48);
  }
  y = drawSectionTitle(doc, "أداء المناطق", layout.margin, y, layout.contentWidth, layout);
  const maxRows = 8;
  const regionCount = brief.allRegions.length;
  const rowHeight = resolveRegionRowHeight(layout, regionCount);
  const tableRows = brief.allRegions;
  const rowsForDisplay = hasReferencePeriod(context)
    ? tableRows
    : tableRows.map((row) => ({ ...row, previousCount: 0, difference: 0, changeRate: null }));
  y = drawRtlTable({
    doc,
    rows: rowsForDisplay,
    columns: hasReferencePeriod(context)
      ? REGION_COLUMNS
      : REGION_COLUMNS.filter((column) => !["previousCount", "difference", "changeRate", "direction"].includes(String(column.key))),
    x: layout.margin,
    y,
    width: layout.contentWidth,
    rowHeight,
    fontSize: fontSize(layout, 9, 8.5),
    maxRows,
    formatCell: formatRegionCell,
    directionForRow: hasReferencePeriod(context) ? regionDirection : undefined,
    directionKey: hasReferencePeriod(context) ? "direction" : undefined,
  });
  if (tableRows.length > maxRows) {
    doc.font("Body").fontSize(fontSize(layout, 9, 8)).fillColor(COLORS.neutral);
    doc.text(
      `تم عرض ${formatReportNumber(maxRows)} من أصل ${formatReportNumber(tableRows.length)} منطقة.`,
      layout.margin,
      y + 6,
      { width: layout.contentWidth, align: "right" }
    );
    y += fontSize(layout, 28, 20);
  } else {
    y += fontSize(layout, 18, 12);
  }
  if (tableRows.length === 0) {
    doc.font("Body").fontSize(fontSize(layout, 11, 9)).fillColor(COLORS.neutral);
    doc.text("لا توجد بيانات مناطق ضمن الفترة المحددة.", layout.margin, y, {
      width: layout.contentWidth,
      align: "center",
    });
  } else {
    y = drawSectionTitle(doc, "بطاقات المقارنة التنفيذية", layout.margin, y, layout.contentWidth, layout);
    drawComparisonCards(context, y);
  }
}

const CLASSIFICATION_COLUMNS: readonly ColumnDefinition<ClassificationBriefRow>[] = [
  { key: "classificationName", label: "التصنيف", weight: 2.4 },
  { key: "currentCount", label: "الحالي", weight: 0.8 },
  { key: "previousCount", label: "السابق", weight: 0.8 },
  { key: "difference", label: "الفرق", weight: 0.8 },
  { key: "shareOfTotal", label: "المساهمة", weight: 1 },
  { key: "changeRate", label: "الاتجاه", weight: 0.75 },
];

function formatClassificationCell(
  row: ClassificationBriefRow,
  key: keyof ClassificationBriefRow
): string {
  if (key === "changeRate") return "";
  if (key === "difference") return formatReportNumber(row.difference, { sign: true });
  if (key === "shareOfTotal") return formatReportNumber(row.shareOfTotal, { percent: true });
  const value = row[key];
  return typeof value === "number" ? formatReportNumber(value) : String(value);
}

function drawCategoryDonut(
  doc: PDFKit.PDFDocument,
  rows: readonly ClassificationBriefRow[],
  x: number,
  y: number,
  width: number,
  layout: BriefPageLayout
): void {
  doc.roundedRect(x, y, width, fontSize(layout, 205, 155), REPORT_DESIGN_TOKENS.card.radius)
    .fillAndStroke(COLORS.background, COLORS.border);
  doc.font("Bold").fontSize(fontSize(layout, 13, 10)).fillColor(COLORS.primary);
  doc.text("توزيع أعلى التصنيفات", x + 10, y + 10, { width: width - 20, align: "right" });
  const useful = rows.filter((row) => row.shareOfTotal > 0);
  if (useful.length < 3) {
    const top = useful[0];
    doc.font("Body").fontSize(fontSize(layout, 10, 8.5)).fillColor(COLORS.neutral);
    doc.text(
      top
        ? `يتصدر ${top.classificationName} بنسبة ${formatReportNumber(top.shareOfTotal, { percent: true })}.`
        : "لا توجد بيانات كافية لإظهار توزيع موثوق.",
      x + 14,
      y + fontSize(layout, 82, 58),
      { width: width - 28, align: "center" }
    );
    return;
  }
  const radius = fontSize(layout, 60, 42);
  const centerX = x + width / 2;
  const centerY = y + fontSize(layout, 102, 78);
  const slices = useful.slice(0, 3).map((row) => row.shareOfTotal);
  slices.push(Math.max(0, 100 - slices.reduce((sum, value) => sum + value, 0)));
  const opacities = [1, 0.78, 0.56, 0.32];
  let angle = -Math.PI / 2;
  slices.forEach((share, index) => {
    const next = angle + Math.PI * 2 * share / 100;
    const startX = centerX + radius * Math.cos(angle);
    const startY = centerY + radius * Math.sin(angle);
    const endX = centerX + radius * Math.cos(next);
    const endY = centerY + radius * Math.sin(next);
    const large = next - angle > Math.PI ? 1 : 0;
    doc.save().fillOpacity(opacities[index]);
    doc.path(`M ${centerX} ${centerY} L ${startX} ${startY} A ${radius} ${radius} 0 ${large} 1 ${endX} ${endY} Z`)
      .fill(COLORS.primary);
    doc.restore();
    angle = next;
  });
  doc.circle(centerX, centerY, radius * 0.48).fill(COLORS.background);
  doc.font("Bold").fontSize(fontSize(layout, 12, 9)).fillColor(COLORS.primary);
  doc.text(
    formatReportNumber(slices.slice(0, 3).reduce((sum, value) => sum + value, 0), { percent: true }),
    centerX - radius * 0.45,
    centerY - fontSize(layout, 7, 6),
    { width: radius * 0.9, align: "center", lineBreak: false }
  );
  resetInk(doc);
}

type AttentionItem = { text: string; assessment: KpiAssessment };

function buildAttentionItems(context: ExecutiveBriefRenderContext): AttentionItem[] {
  const { brief, data } = context;
  const items: AttentionItem[] = [];
  const concentration = brief.concentrationBands.find((band) => band.entityType === "classification");
  if (concentration && concentration.top3SharePercent >= 50) {
    items.push({
      text: `تتركز ${formatReportNumber(concentration.top3SharePercent, { percent: true })} من الشكاوى في أعلى ثلاثة تصنيفات.`,
      assessment: "warning",
    });
  }
  const late = brief.briefKpis.find((card) => card.key === "currentlyLate");
  if (late && late.value > 0) {
    items.push({ text: `توجد ${formatReportNumber(late.value)} شكوى متأخرة تتطلب المتابعة.`, assessment: late.assessment });
  }
  const priority = brief.briefKpis.find((card) => card.key === "highPriorityOpen");
  if (priority && priority.value > 0) {
    items.push({ text: `${formatReportNumber(priority.value)} شكوى عالية الأولوية ما زالت مفتوحة.`, assessment: priority.assessment });
  }
  const topRise = data.comparisonData?.deptClassRises[0];
  if (topRise && hasReferencePeriod(context)) {
    items.push({
      text: `ارتفاع مؤثر في ${topRise.departmentName} / ${topRise.classificationName} بمقدار ${formatReportNumber(topRise.difference, { sign: true })}.`,
      assessment: "warning",
    });
  }
  if (items.length === 0) {
    items.push({ text: "لا توجد إشارات استثنائية إضافية ضمن البيانات المتاحة.", assessment: "neutral" });
  }
  return items.slice(0, 5);
}

function drawAttentionCards(
  context: ExecutiveBriefRenderContext,
  items: readonly AttentionItem[],
  x: number,
  y: number,
  width: number
): number {
  const { doc, layout } = context;
  const height = layout.compact ? 34 : 45;
  const gap = layout.compact ? 6 : 8;
  items.forEach((item, index) => {
    const cardY = y + index * (height + gap);
    doc.roundedRect(x, cardY, width, height, REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    const direction = directionFromAssessment(item.assessment);
    doc.font("Bold").fontSize(fontSize(layout, 12, 9)).fillColor(directionColor(direction));
    doc.text("!", x + width - 26, cardY + fontSize(layout, 11, 8), {
      width: 16,
      align: "center",
      lineBreak: false,
    });
    doc.font("Body").fontSize(fontSize(layout, 10, 8.5)).fillColor(COLORS.primary);
    doc.text(item.text, x + 10, cardY + fontSize(layout, 10, 7), {
      width: width - 42,
      height: height - 12,
      align: "right",
      ellipsis: true,
    });
  });
  return y + items.length * (height + gap);
}

function drawRisingPairs(
  context: ExecutiveBriefRenderContext,
  x: number,
  y: number,
  width: number
): void {
  const { doc, data, layout } = context;
  if (!hasReferencePeriod(context)) {
    doc.roundedRect(x, y, width, fontSize(layout, 100, 70), REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Body").fontSize(fontSize(layout, 10, 8.5)).fillColor(COLORS.neutral);
    doc.text("لا تتوفر فترة مرجعية؛ يعرض هذا القسم توزيع الفترة الحالية فقط.", x + 12, y + 24, {
      width: width - 24,
      align: "center",
    });
    return;
  }
  const rows = data.comparisonData?.deptClassRises.slice(0, 4) ?? [];
  if (rows.length === 0) {
    doc.font("Body").fontSize(fontSize(layout, 10, 8.5)).fillColor(COLORS.neutral);
    doc.text("لا توجد ارتفاعات إدارية وتصنيفية مؤثرة.", x, y + 20, { width, align: "center" });
    return;
  }
  const rowHeight = layout.compact ? 29 : 38;
  rows.forEach((row, index) => {
    const rowY = y + index * rowHeight;
    if (index % 2 === 1) doc.rect(x, rowY, width, rowHeight).fill(COLORS.tableRowAlternate);
    doc.font("Body").fontSize(fontSize(layout, 9.5, 8)).fillColor(COLORS.primary);
    doc.text(`${row.departmentName} × ${row.classificationName}`, x + 42, rowY + 7, {
      width: width - 50,
      align: "right",
      height: rowHeight - 10,
      ellipsis: true,
    });
    doc.font("Bold").fontSize(fontSize(layout, 10, 8.5)).fillColor(COLORS.danger);
    doc.text(formatReportNumber(row.difference, { sign: true }), x + 6, rowY + 7, {
      width: 34,
      align: "center",
      lineBreak: false,
    });
  });
}

function drawMethodology(context: ExecutiveBriefRenderContext): void {
  const { doc, layout } = context;
  const y = layout.pageSize[1] - layout.margin - fontSize(layout, 64, 48);
  doc.moveTo(layout.margin, y)
    .lineTo(layout.margin + layout.contentWidth, y)
    .strokeColor(COLORS.border)
    .stroke();
  doc.font("Bold").fontSize(fontSize(layout, 9.5, 8)).fillColor(COLORS.primary);
  doc.text("المنهجية", layout.margin, y + 7, { width: layout.contentWidth, align: "right" });
  doc.font("Body").fontSize(fontSize(layout, 8.5, 7.5)).fillColor(COLORS.neutral);
  const reference = hasReferencePeriod(context)
    ? "الفترة السابقة مماثلة زمنيًا وتسبق الحالية مباشرة."
    : "لا توجد فترة سابقة متاحة.";
  const continuity = hasReferencePeriod(context)
    ? "يستخدم وصف «جديد» فقط عند توفر مرجع وكانت القيمة السابقة صفرًا."
    : "لا تُنشأ تصنيفات استمرارية عند غياب المرجع.";
  const text = `${reference} الفرق = الحالي − السابق؛ نسبة التغير = الفرق ÷ السابق. ${continuity} تعرض الجداول أعلى الصفوف عند تجاوز المساحة.`;
  doc.text(text, layout.margin, y + fontSize(layout, 24, 18), {
    width: layout.contentWidth,
    align: "right",
    height: fontSize(layout, 26, 21),
    ellipsis: true,
  });
}

function renderPage3(context: ExecutiveBriefRenderContext): void {
  const { doc, brief, layout } = context;
  let y = drawPageHeader(context, briefPageTitle(3));
  const gap = layout.compact ? 10 : 16;
  const donutWidth = layout.contentWidth * 0.28;
  const tableWidth = layout.contentWidth - donutWidth - gap;
  y = drawSectionTitle(doc, "أبرز التصنيفات", layout.margin, y, tableWidth, layout);
  const classRows = hasReferencePeriod(context)
    ? brief.topClassifications
    : brief.topClassifications.map((row) => ({ ...row, previousCount: 0, difference: 0, changeRate: null }));
  const columns = hasReferencePeriod(context)
    ? CLASSIFICATION_COLUMNS
    : CLASSIFICATION_COLUMNS.filter((column) => !["previousCount", "difference", "changeRate"].includes(String(column.key)));
  const tableBottom = drawRtlTable({
    doc,
    rows: classRows,
    columns,
    x: layout.margin,
    y,
    width: tableWidth,
    rowHeight: layout.compact ? 21 : 28,
    fontSize: fontSize(layout, 9, 8.5),
    maxRows: 8,
    formatCell: formatClassificationCell,
    directionForRow: hasReferencePeriod(context) ? classificationDirection : undefined,
    directionKey: hasReferencePeriod(context) ? "changeRate" : undefined,
  });
  drawCategoryDonut(
    doc,
    brief.topClassifications,
    layout.margin + tableWidth + gap,
    y,
    donutWidth,
    layout
  );
  const lowerY = Math.max(tableBottom, y + fontSize(layout, 215, 165)) + gap;
  const lowerWidth = (layout.contentWidth - gap) / 2;
  const attentionX = layout.margin + lowerWidth + gap;
  const attentionY = drawSectionTitle(doc, "ما يستحق الانتباه", attentionX, lowerY, lowerWidth, layout);
  drawAttentionCards(context, buildAttentionItems(context), attentionX, attentionY, lowerWidth);
  const pairsY = drawSectionTitle(doc, "الإدارات والتصنيفات المرتفعة", layout.margin, lowerY, lowerWidth, layout);
  drawRisingPairs(context, layout.margin, pairsY, lowerWidth);
  drawMethodology(context);
}

function drawBriefFooters(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  layout: BriefPageLayout
): void {
  const range = doc.bufferedPageRange();
  if (range.count !== PAGE_COUNT) {
    throw new Error(`EXECUTIVE_BRIEF_PAGE_COUNT_MISMATCH:${range.count}`);
  }
  for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    const pageNumber = pageIndex - range.start + 1;
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.footer).fillColor(COLORS.neutral);
    doc.text(
      `${data.title} — صفحة ${formatReportNumber(pageNumber)} من ${formatReportNumber(range.count)}`,
      layout.margin,
      layout.pageSize[1] - layout.margin - 12,
      { width: layout.contentWidth, align: "center", lineBreak: false }
    );
    doc.page.margins.bottom = originalBottomMargin;
  }
  resetInk(doc);
}

export async function renderExecutiveBriefPdf(
  data: ReportData,
  mode: ExecutiveBriefMode
): Promise<ExecutiveBriefPdfResult> {
  const warnings = [...data.warnings];
  const { regular, bold } = loadFonts();
  const layout = createLayout(mode);
  const doc = new PDFDocument({
    size: [...layout.pageSize],
    margins: {
      top: layout.margin,
      bottom: layout.margin + 24,
      left: layout.margin,
      right: layout.margin,
    },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: data.title,
      Author: "نظام ذكاء الشكاوى",
      Subject: getReportDefinition(data.type).description,
      Keywords: [
        mode,
        "النظرة التنفيذية",
        "المقارنة والأداء",
        "التصنيفات والاستنتاجات",
        "الملخص التنفيذي",
        "المؤشرات التنفيذية",
        "المنهجية",
      ].join(" | "),
    },
  });
  doc.registerFont("Body", regular);
  doc.registerFont("Bold", bold);
  doc.font("Body");
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
  });
  const context: ExecutiveBriefRenderContext = {
    doc,
    data,
    brief: data.briefData ?? EMPTY_BRIEF,
    warnings,
    layout,
    mode,
  };
  await renderPage1(context);
  doc.addPage();
  renderPage2(context);
  doc.addPage();
  renderPage3(context);
  drawBriefFooters(doc, data, layout);
  doc.end();
  return { buffer: await done, warnings };
}
