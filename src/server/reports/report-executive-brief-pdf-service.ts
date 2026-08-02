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
import type { ExecutiveBriefData, ReportData } from "./report-data-service";
import { renderLineChartPng } from "./report-chart-service";
import { formatRiyadhDateTime } from "./report-time";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const COLORS = REPORT_DESIGN_TOKENS.colors;
const PAGE_COUNT = 4;
const ARABIC_WORD_SPACING = REPORT_DESIGN_TOKENS.typography.wordSpacing;

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
  topDepartments: [],
  conclusions: [],
  notes: [],
};

function createLayout(mode: ExecutiveBriefMode, regionCount: number): BriefPageLayout {
  const compact = false;
  const baseSize = mode === "PRINT_EXECUTIVE_BRIEF"
    ? PRINT_EXECUTIVE_PAGE_SIZE
    : DIGITAL_EXECUTIVE_PAGE_SIZE;
  const requiredHeight = 650 + Math.ceil(regionCount / 3) * 78 + (regionCount + 1) * 31;
  const pageSize = [baseSize[0], Math.max(baseSize[1], requiredHeight)] as const;
  const margin = 42;
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
  if (card.value === null) return "غير متاح";
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
  const { doc, data, layout } = context;
  const { margin, contentWidth } = layout;
  const titleSize = fontSize(layout, REPORT_DESIGN_TOKENS.fontSize.reportTitle, 20);
  doc.font("Bold").fontSize(titleSize).fillColor(COLORS.primary);
  doc.text(pageTitle, margin, margin, {
    width: contentWidth,
    align: "right",
    wordSpacing: ARABIC_WORD_SPACING,
  });

  const titleHeight = doc.heightOfString(pageTitle, { width: contentWidth, align: "right" });
  const metaY = margin + titleHeight + 10;
  doc.font("Body").fontSize(fontSize(layout, 10.5, 8.5)).fillColor(COLORS.neutral);
  const previous = data.previousPeriod
    ? ` | الفترة السابقة: ${data.previousPeriod.from} – ${data.previousPeriod.to}`
    : " | لا تتوفر فترة سابقة للمقارنة";
  const meta = `الفترة: ${data.period.from} – ${data.period.to}${previous}`;
  doc.text(meta, margin, metaY, {
    width: contentWidth,
    align: "right",
    wordSpacing: ARABIC_WORD_SPACING,
  });
  const generated = `تاريخ الإنشاء: ${formatRiyadhDateTime(new Date(data.generatedAt))}`;
  doc.text(generated, margin, metaY + fontSize(layout, 18, 14), {
    width: contentWidth,
    align: "right",
    wordSpacing: ARABIC_WORD_SPACING,
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
  doc.text(title, x, y, { width, align: "right", wordSpacing: ARABIC_WORD_SPACING });
  return y + fontSize(layout, 25, 18);
}

function drawCommitmentGauge(
  doc: PDFKit.PDFDocument,
  card: ExecutiveBriefKpiCard,
  x: number,
  y: number,
  compact: boolean
): void {
  if (card.value === null) return;
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
    wordSpacing: ARABIC_WORD_SPACING,
    height: fontSize(layout, 18, 13),
    ellipsis: true,
  });
  doc.font("Bold").fontSize(fontSize(layout, 24, 17)).fillColor(COLORS.primary);
  doc.text(formatKpiValue(card), x + padding + gaugeWidth, y + fontSize(layout, 34, 25), {
    width: width - padding * 2 - gaugeWidth,
    align: "right",
    height: fontSize(layout, 32, 22),
    lineBreak: false,
    wordSpacing: ARABIC_WORD_SPACING,
  });
  if (hasGauge && card.value !== null) drawCommitmentGauge(doc, card, x + padding, y + 5, layout.compact);
  if (card.difference !== null) {
    const direction = directionFromAssessment(card.assessment);
    const deltaY = y + height - fontSize(layout, 25, 18);
    drawDirectionIcon(doc, direction, x + padding, deltaY - 2, fontSize(layout, 13, 10));
    doc.font("Body").fontSize(10.5).fillColor(directionColor(direction));
    const previous = card.previousValue === null
      ? ""
      : ` | السابق ${formatReportNumber(card.previousValue)}`;
    doc.text(`${formatKpiDelta(card.difference, card.changeRate)}${previous}`, x + padding + 20, deltaY, {
      width: width - padding * 2 - 20,
      align: "right",
      lineBreak: false,
      ellipsis: true,
      wordSpacing: ARABIC_WORD_SPACING,
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
  const selectedCards = cards.slice(0, 8);
  const columns = 4;
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

function hasReferencePeriod(context: ExecutiveBriefRenderContext): boolean {
  return context.data.previousPeriod != null;
}

function briefPageTitle(page: ExecutiveBriefPreviewPage): string {
  return EXECUTIVE_BRIEF_PAGE_PLAN[page - 1].title;
}

function selectPage1Visual(context: ExecutiveBriefRenderContext): ExecutiveVisual {
  const points = context.brief.comparativeTimeline.current.points;
  const total = points.reduce((sum, point) => sum + point.count, 0);
  return points.length >= 3 && total >= 5
    ? "line-chart"
    : "comparison-cards";
}

async function drawPage1Visual(
  context: ExecutiveBriefRenderContext,
  startY: number
): Promise<void> {
  const { doc, data, warnings, layout } = context;
  const visual = selectPage1Visual(context);
  const titleY = drawSectionTitle(
    doc,
    visual === "line-chart" ? "الاتجاه الزمني للشكاوى" : "قراءة سريعة للأداء الحالي",
    layout.margin,
    startY,
    layout.contentWidth,
    layout
  );
  const available = layout.pageSize[1] - layout.margin - 34 - titleY;
  if (visual === "comparison-cards") {
    const cards = [
      context.brief.briefKpis.find((card) => card.key === "total"),
      context.brief.briefKpis.find((card) => card.key === "currentlyLate"),
      context.brief.briefKpis.find((card) => card.key === "complianceRate"),
    ].filter((card): card is ExecutiveBriefKpiCard => card !== undefined);
    const gap = 12;
    const width = (layout.contentWidth - gap * 2) / 3;
    cards.forEach((card, index) => {
      const x = layout.margin + (2 - index) * (width + gap);
      doc.roundedRect(x, titleY, width, 126, REPORT_DESIGN_TOKENS.card.radius)
        .fillAndStroke(COLORS.background, COLORS.border);
      doc.font("Body").fontSize(11).fillColor(COLORS.neutral)
        .text(card.label, x + 12, titleY + 22, { width: width - 24, align: "center" });
      doc.font("Bold").fontSize(25).fillColor(COLORS.primary)
        .text(formatKpiValue(card), x + 12, titleY + 62, { width: width - 24, align: "center" });
    });
    doc.font("Body").fontSize(11).fillColor(COLORS.neutral).text(
      data.previousPeriod
        ? "حجم البيانات لا يكفي لإظهار اتجاه زمني موثوق."
        : "لا تتوفر فترة سابقة، ويعرض هذا الملخص قيم الفترة الحالية فقط.",
      layout.margin,
      titleY + 148,
      { width: layout.contentWidth, align: "center" }
    );
    return;
  }
  const timeline = context.brief.comparativeTimeline;
  const chartHeight = Math.max(90, Math.round(available));
  const chart = {
    id: "executive-region-comparison",
    kind: "chart" as const,
    chartType: "line" as const,
    title: timeline.previous ? "الفترة الحالية مقارنة بالفترة السابقة" : "اتجاه الفترة الحالية",
    series: [
      { name: timeline.current.label, points: timeline.current.points.map((point) => ({ x: String(point.relativeDay), y: point.count })) },
      ...(hasReferencePeriod(context) && timeline.previous
        ? [{ name: timeline.previous.label, points: timeline.previous.points.map((point) => ({ x: String(point.relativeDay), y: point.count })) }]
        : []),
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

function drawCoverMetric(
  context: ExecutiveBriefRenderContext,
  label: string,
  key: string,
  x: number,
  y: number,
  width: number
): void {
  const { doc, brief } = context;
  const card = brief.briefKpis.find((item) => item.key === key);
  doc.roundedRect(x, y, width, 104, REPORT_DESIGN_TOKENS.card.radius)
    .fillAndStroke(COLORS.background, COLORS.border);
  doc.font("Body").fontSize(12).fillColor(COLORS.neutral)
    .text(label, x + 12, y + 18, {
      width: width - 24,
      align: "center",
      wordSpacing: ARABIC_WORD_SPACING,
    });
  doc.font("Bold").fontSize(28).fillColor(COLORS.primary)
    .text(card ? formatKpiValue(card) : "غير متاح", x + 12, y + 50, {
      width: width - 24,
      align: "center",
      lineBreak: false,
    });
}

function renderCoverPage(context: ExecutiveBriefRenderContext): void {
  const { doc, data, layout } = context;
  doc.rect(0, 0, layout.pageSize[0], layout.pageSize[1]).fill(COLORS.background);
  doc.rect(layout.pageSize[0] - 32, 0, 32, layout.pageSize[1]).fill(COLORS.primary);
  doc.rect(0, 0, 10, layout.pageSize[1]).fill(COLORS.gold);
  const titleY = layout.pageSize[1] * 0.26;
  doc.font("Bold").fontSize(36).fillColor(COLORS.primary)
    .text("تقرير الشكاوى", layout.margin, titleY, {
      width: layout.contentWidth,
      align: "center",
      wordSpacing: ARABIC_WORD_SPACING,
    });
  doc.font("Body").fontSize(16).fillColor(COLORS.text)
    .text(`الفترة من ${data.period.from} إلى ${data.period.to}`, layout.margin, titleY + 72, {
      width: layout.contentWidth,
      align: "center",
      wordSpacing: ARABIC_WORD_SPACING,
    });
  const comparison = data.previousPeriod
    ? `مقارنة مع الفترة المماثلة السابقة: ${data.previousPeriod.from} إلى ${data.previousPeriod.to}`
    : "لا تتوفر فترة مماثلة سابقة للمقارنة";
  doc.text(comparison, layout.margin, titleY + 108, {
    width: layout.contentWidth,
    align: "center",
    wordSpacing: ARABIC_WORD_SPACING,
  });
  doc.fontSize(12).fillColor(COLORS.neutral)
    .text(`تاريخ الإنشاء: ${formatRiyadhDateTime(new Date(data.generatedAt))}`, layout.margin, titleY + 150, {
      width: layout.contentWidth,
      align: "center",
      wordSpacing: ARABIC_WORD_SPACING,
    });
  const gap = 18;
  const width = (layout.contentWidth - gap * 2) / 3;
  const cardsY = titleY + 230;
  drawCoverMetric(context, "إجمالي الشكاوى", "total", layout.margin + (width + gap) * 2, cardsY, width);
  drawCoverMetric(context, "المفتوحة", "open", layout.margin + width + gap, cardsY, width);
  drawCoverMetric(context, "المغلقة", "closed", layout.margin, cardsY, width);
}

async function renderPage2(context: ExecutiveBriefRenderContext): Promise<void> {
  let y = drawPageHeader(context, briefPageTitle(2));
  y = drawSectionTitle(context.doc, "ملخص المؤشرات", context.layout.margin, y, context.layout.contentWidth, context.layout);
  y = drawKpiGrid(context.doc, context.brief.briefKpis, context.layout, y);
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
      wordSpacing: ARABIC_WORD_SPACING,
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
        wordSpacing: ARABIC_WORD_SPACING,
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
  { key: "openCount", label: "المفتوحة", weight: 0.9 },
  { key: "closedCount", label: "المغلقة", weight: 0.9 },
  { key: "currentlyLate", label: "المتأخرة", weight: 0.9 },
  { key: "complianceRate", label: "الالتزام", weight: 1 },
  { key: "direction", label: "الاتجاه", weight: 0.75 },
];

function resolveRegionRowHeight(layout: BriefPageLayout, regionCount: number): number {
  if (regionCount <= 3) return layout.compact ? 30 : 58;
  if (regionCount <= 5) return layout.compact ? 25 : 40;
  return layout.compact ? 22 : 28;
}

function drawAllRegionCards(
  context: ExecutiveBriefRenderContext,
  startY: number
): number {
  const { doc, brief, layout } = context;
  const columns = 3;
  const gap = 10;
  const width = (layout.contentWidth - gap * (columns - 1)) / columns;
  const height = 68;
  brief.allRegions.forEach((region, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = layout.margin + (columns - 1 - column) * (width + gap);
    const y = startY + row * (height + gap);
    doc.roundedRect(x, y, width, height, REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Bold").fontSize(12).fillColor(COLORS.primary)
      .text(region.regionName, x + 8, y + 7, {
        width: width - 16,
        align: "right",
        ellipsis: true,
        wordSpacing: ARABIC_WORD_SPACING,
      });
    doc.font("Body").fontSize(10.5).fillColor(COLORS.text)
      .text(
        `الإجمالي ${formatReportNumber(region.currentCount)} | المفتوحة ${formatReportNumber(region.openCount ?? 0)} | المغلقة ${formatReportNumber(region.closedCount ?? 0)}`,
        x + 8,
        y + 29,
        {
          width: width - 16,
          align: "right",
          lineBreak: false,
          ellipsis: true,
          wordSpacing: ARABIC_WORD_SPACING,
        }
      );
    const comparison = hasReferencePeriod(context)
      ? `المتأخرة ${formatReportNumber(region.currentlyLate)} | الفرق ${formatReportNumber(region.difference, { sign: true })} | ${region.previousCount === 0 && region.currentCount > 0 ? "جديد" : formatNullableReportNumber(region.changeRate, { percent: true })}`
      : `المتأخرة ${formatReportNumber(region.currentlyLate)} | لا تتوفر مقارنة`;
    doc.text(comparison, x + 8, y + 48, {
      width: width - 16,
      align: "right",
      lineBreak: false,
      ellipsis: true,
      wordSpacing: ARABIC_WORD_SPACING,
    });
  });
  return startY + Math.ceil(brief.allRegions.length / columns) * (height + gap);
}

function renderPage3(context: ExecutiveBriefRenderContext): void {
  const { doc, brief, layout } = context;
  let y = drawPageHeader(context, briefPageTitle(3));
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
  y = drawSectionTitle(doc, "بطاقات المناطق", layout.margin, y, layout.contentWidth, layout);
  y = drawAllRegionCards(context, y) + 8;
  y = drawSectionTitle(doc, "جميع المناطق", layout.margin, y, layout.contentWidth, layout);
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
    fontSize: 10.5,
    maxRows: tableRows.length,
    formatCell: formatRegionCell,
    directionForRow: hasReferencePeriod(context) ? regionDirection : undefined,
    directionKey: hasReferencePeriod(context) ? "direction" : undefined,
  });
  y += 14;
  if (tableRows.length === 0) {
    doc.font("Body").fontSize(fontSize(layout, 11, 9)).fillColor(COLORS.neutral);
    doc.text("لا توجد بيانات مناطق ضمن الفترة المحددة.", layout.margin, y, {
      width: layout.contentWidth,
      align: "center",
    });
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
    doc.font("Body").fontSize(10.5).fillColor(COLORS.neutral);
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
  if (late?.value != null && late.value > 0) {
    items.push({ text: `توجد ${formatReportNumber(late.value)} شكوى متأخرة تتطلب المتابعة.`, assessment: late.assessment });
  }
  const priority = brief.briefKpis.find((card) => card.key === "highPriorityOpen");
  if (priority?.value != null && priority.value > 0) {
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
    doc.font("Body").fontSize(10.5).fillColor(COLORS.primary);
    doc.text(item.text, x + 10, cardY + fontSize(layout, 10, 7), {
      width: width - 42,
      height: height - 12,
      align: "right",
      ellipsis: true,
      wordSpacing: ARABIC_WORD_SPACING,
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
    doc.font("Body").fontSize(10.5).fillColor(COLORS.neutral);
    doc.text("لا تتوفر فترة مرجعية؛ يعرض هذا القسم توزيع الفترة الحالية فقط.", x + 12, y + 24, {
      width: width - 24,
      align: "center",
      wordSpacing: ARABIC_WORD_SPACING,
    });
    return;
  }
  const rows = data.comparisonData?.deptClassRises.slice(0, 4) ?? [];
  if (rows.length === 0) {
    doc.font("Body").fontSize(10.5).fillColor(COLORS.neutral);
    doc.text("لا توجد ارتفاعات إدارية وتصنيفية مؤثرة.", x, y + 20, {
      width,
      align: "center",
      wordSpacing: ARABIC_WORD_SPACING,
    });
    return;
  }
  const rowHeight = layout.compact ? 29 : 38;
  rows.forEach((row, index) => {
    const rowY = y + index * rowHeight;
    if (index % 2 === 1) doc.rect(x, rowY, width, rowHeight).fill(COLORS.tableRowAlternate);
    doc.font("Body").fontSize(10.5).fillColor(COLORS.primary);
    doc.text(`${row.departmentName} × ${row.classificationName}`, x + 42, rowY + 7, {
      width: width - 50,
      align: "right",
      height: rowHeight - 10,
      ellipsis: true,
      wordSpacing: ARABIC_WORD_SPACING,
    });
    doc.font("Bold").fontSize(10.5).fillColor(COLORS.danger);
    doc.text(formatReportNumber(row.difference, { sign: true }), x + 6, rowY + 7, {
      width: 34,
      align: "center",
      lineBreak: false,
    });
  });
}

function drawDepartmentRows(
  context: ExecutiveBriefRenderContext,
  x: number,
  y: number,
  width: number
): number {
  const { doc, brief } = context;
  const rowHeight = 32;
  const departments = brief.topDepartments ?? [];
  departments.slice(0, 5).forEach((row, index) => {
    const rowY = y + index * rowHeight;
    if (index % 2 === 1) doc.rect(x, rowY, width, rowHeight).fill(COLORS.tableRowAlternate);
    doc.font("Body").fontSize(10.5).fillColor(COLORS.text)
      .text(row.name, x + 96, rowY + 7, {
        width: width - 104,
        align: "right",
        ellipsis: true,
        wordSpacing: ARABIC_WORD_SPACING,
      });
    doc.text(
      `${formatReportNumber(row.total)} | مفتوحة ${formatReportNumber(row.open)}`,
      x + 8,
      rowY + 7,
      { width: 84, align: "right", lineBreak: false, wordSpacing: ARABIC_WORD_SPACING }
    );
  });
  return y + Math.max(1, Math.min(5, departments.length)) * rowHeight;
}

function renderPage4(context: ExecutiveBriefRenderContext): void {
  const { doc, brief, layout } = context;
  let y = drawPageHeader(context, briefPageTitle(4));
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
    fontSize: 10.5,
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
  const attentionY = drawSectionTitle(doc, "ملاحظات", attentionX, lowerY, lowerWidth, layout);
  const noteItems = (brief.notes ?? []).map((text) => ({ text, assessment: "warning" as const }));
  drawAttentionCards(context, noteItems.length > 0 ? noteItems : buildAttentionItems(context).slice(0, 3), attentionX, attentionY, lowerWidth);
  const departmentsY = drawSectionTitle(doc, "أبرز الإدارات", layout.margin, lowerY, lowerWidth, layout);
  const departmentBottom = drawDepartmentRows(context, layout.margin, departmentsY, lowerWidth);
  if (hasReferencePeriod(context)) {
    const pairsY = drawSectionTitle(doc, "أبرز الارتفاعات", layout.margin, departmentBottom + 8, lowerWidth, layout);
    drawRisingPairs(context, layout.margin, pairsY, lowerWidth);
  }
  const conclusionY = Math.max(lowerY + 230, departmentBottom + 175);
  const conclusionsStart = drawSectionTitle(doc, "الاستنتاجات", layout.margin, conclusionY, layout.contentWidth, layout);
  doc.font("Body").fontSize(11).fillColor(COLORS.text);
  (brief.conclusions ?? []).slice(0, 4).forEach((point, index) => {
    doc.text(`• ${point}`, layout.margin, conclusionsStart + index * 28, {
      width: layout.contentWidth,
      align: "right",
      height: 24,
      ellipsis: true,
      wordSpacing: ARABIC_WORD_SPACING,
    });
  });
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
      `صفحة ${formatReportNumber(pageNumber)} من ${formatReportNumber(range.count)}`,
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
  const brief = data.briefData ?? EMPTY_BRIEF;
  const layout = createLayout(mode, brief.allRegions.length);
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
      Author: "تقارير الشكاوى",
      Subject: "تقرير الشكاوى",
      Keywords: "الشكاوى | المؤشرات | المناطق | التصنيفات",
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
    brief,
    warnings,
    layout,
  };
  renderCoverPage(context);
  doc.addPage();
  await renderPage2(context);
  doc.addPage();
  renderPage3(context);
  doc.addPage();
  renderPage4(context);
  drawBriefFooters(doc, data, layout);
  doc.end();
  return { buffer: await done, warnings };
}
