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
import { drawComplaintsReportCover } from "./report-cover";
import { getComparisonModeDescription } from "@/lib/reports/comparison-mode-labels";
import { preparePdfText } from "./arabic-pdf-text";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const COLORS = REPORT_DESIGN_TOKENS.colors;
const PAGE_COUNT = 4;
const MAX_EXECUTIVE_REGION_ROWS = 100;
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
  headerFontSize?: number;
  maxRows: number;
  formatCell: (row: Row, key: keyof Row) => string;
  directionForRow?: (row: Row) => ExecutiveDirection;
  directionKey?: keyof Row;
  darkHeader?: boolean;
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
  const safeRegionCount = Math.min(regionCount, MAX_EXECUTIVE_REGION_ROWS);
  // Page 3 needs: banner (220) + header title area (70) + chart (360) + card rows + table rows + footer (50)
  const cardRows = Math.ceil(safeRegionCount / 4);
  const requiredHeight = 880 + cardRows * 118 + safeRegionCount * 28;
  const pageSize = [baseSize[0], Math.max(baseSize[1], requiredHeight)] as const;
  const margin = 42;
  return {
    pageSize,
    margin,
    contentWidth: pageSize[0] - margin * 2,
    compact,
  };
}

function visibleRegionRows(brief: ExecutiveBriefData): readonly RegionReferenceRow[] {
  return brief.allRegions.slice(0, MAX_EXECUTIVE_REGION_ROWS);
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

// ── Decorative drawing helpers ──────────────────────────────────────────────

function drawPageGoldDots(doc: PDFKit.PDFDocument, x: number, y: number): void {
  const spacing = 13;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      doc.circle(x + col * spacing, y + row * spacing, 2.5).fill(COLORS.gold);
    }
  }
  doc.fillColor(COLORS.primary);
}

function drawPageDiamond(doc: PDFKit.PDFDocument, cx: number, cy: number, r: number): void {
  doc
    .moveTo(cx, cy - r)
    .lineTo(cx + r, cy)
    .lineTo(cx, cy + r)
    .lineTo(cx - r, cy)
    .closePath()
    .fill(COLORS.gold);
  doc.fillColor(COLORS.primary);
}

function drawPageGoldSeparator(
  doc: PDFKit.PDFDocument,
  cx: number,
  y: number,
  halfW: number
): void {
  const gap = 14;
  doc.moveTo(cx - halfW, y).lineTo(cx - gap, y).strokeColor(COLORS.gold).lineWidth(1).stroke();
  doc.moveTo(cx + gap, y).lineTo(cx + halfW, y).strokeColor(COLORS.gold).lineWidth(1).stroke();
  drawPageDiamond(doc, cx, y, 6);
  doc.strokeColor(COLORS.border).lineWidth(1);
}

// ── KPI formatting ──────────────────────────────────────────────────────────

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

// ── Page header (draws background + banner for pages 2-4) ──────────────────

function drawPageHeader(
  context: ExecutiveBriefRenderContext,
  pageTitle: string
): number {
  const { doc, layout } = context;
  const { pageSize, margin, contentWidth } = layout;
  const PW = pageSize[0];
  const PH = pageSize[1];

  // Cream background for entire page
  doc.rect(0, 0, PW, PH).fill(COLORS.background);

  // Curved green banner at top-left (triangular wave shape)
  const bannerH = Math.round(PH * 0.18);
  doc
    .moveTo(0, 0)
    .lineTo(PW * 0.5, 0)
    .bezierCurveTo(PW * 0.38, bannerH * 0.52, PW * 0.22, bannerH * 0.8, 0, bannerH * 0.72)
    .closePath()
    .fill(COLORS.primary);

  // Gold accent line along banner edge
  doc
    .moveTo(0, bannerH * 0.72)
    .bezierCurveTo(PW * 0.22, bannerH * 0.8, PW * 0.38, bannerH * 0.52, PW * 0.5, 0)
    .lineWidth(2.5)
    .strokeColor(COLORS.gold)
    .stroke();
  doc.lineWidth(1);

  // Gold dots top-right
  drawPageGoldDots(doc, PW - margin - 38, margin + 16);

  // Page title (right-aligned, below banner)
  const titleY = Math.round(bannerH * 0.82);
  const titleSize = fontSize(layout, REPORT_DESIGN_TOKENS.fontSize.reportTitle, 20);
  const pageTitleOptions = {
    width: contentWidth,
    align: "right" as const,
    wordSpacing: ARABIC_WORD_SPACING,
  };
  const preparedPageTitle = preparePdfText(pageTitle);
  doc.font("Bold").fontSize(titleSize).fillColor(COLORS.primary).text(
    preparedPageTitle,
    margin,
    titleY,
    pageTitleOptions
  );
  const titleH = doc.heightOfString(preparedPageTitle, pageTitleOptions);

  // Gold separator with diamond below title
  const sepY = titleY + titleH + 14;
  drawPageGoldSeparator(doc, PW / 2, sepY, contentWidth * 0.35);

  resetInk(doc);
  return sepY + 20;
}

// ── Section title ────────────────────────────────────────────────────────────

function drawSectionTitle(
  doc: PDFKit.PDFDocument,
  title: string,
  x: number,
  y: number,
  width: number,
  layout: BriefPageLayout
): number {
  const sz = fontSize(layout, REPORT_DESIGN_TOKENS.fontSize.sectionTitle, 13);
  doc.font("Bold").fontSize(sz).fillColor(COLORS.primary);
  doc.text(preparePdfText(title), x, y, { width, align: "right", wordSpacing: ARABIC_WORD_SPACING });
  return y + sz + 10;
}

// ── Commitment gauge ─────────────────────────────────────────────────────────

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

// ── KPI card ────────────────────────────────────────────────────────────────

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
  const hasGauge = card.key === "complianceRate" && card.value !== null;
  let gaugeWidth = 0;
  if (hasGauge) {
    gaugeWidth = layout.compact ? 60 : 86;
  }
  doc.font("Body").fontSize(fontSize(layout, 13, 10)).fillColor(COLORS.neutral);
  doc.text(preparePdfText(card.label), x + padding + gaugeWidth, y + padding, {
    width: width - padding * 2 - gaugeWidth,
    align: "right",
    wordSpacing: ARABIC_WORD_SPACING,
    height: fontSize(layout, 20, 14),
    ellipsis: true,
  });
  doc.font("Bold").fontSize(fontSize(layout, REPORT_DESIGN_TOKENS.fontSize.kpiValue, 18)).fillColor(COLORS.primary);
  doc.text(preparePdfText(formatKpiValue(card)), x + padding + gaugeWidth, y + fontSize(layout, 38, 27), {
    width: width - padding * 2 - gaugeWidth,
    align: "right",
    height: fontSize(layout, 32, 22),
    lineBreak: false,
    wordSpacing: ARABIC_WORD_SPACING,
  });
  if (hasGauge) drawCommitmentGauge(doc, card, x + padding, y + 5, layout.compact);
  if (card.difference !== null) {
    const direction = directionFromAssessment(card.assessment);
    const deltaY = y + height - fontSize(layout, 25, 18);
    drawDirectionIcon(doc, direction, x + padding, deltaY - 2, fontSize(layout, 13, 10));
    doc.font("Body").fontSize(10.5).fillColor(directionColor(direction));
    const previous = card.previousValue === null
      ? ""
      : ` | السابق ${formatReportNumber(card.previousValue)}`;
    doc.text(preparePdfText(`${formatKpiDelta(card.difference, card.changeRate)}${previous}`), x + padding + 20, deltaY, {
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
  const cardHeight = layout.compact ? 82 : 112;
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

function timelinePointLabel(
  aggregation: ExecutiveBriefData["comparativeTimeline"]["aggregation"],
  relativeDay: number
): string {
  if (aggregation === "monthly") return `الشهر ${Math.floor((relativeDay - 1) / 30) + 1}`;
  if (aggregation === "weekly") return `الأسبوع ${Math.floor((relativeDay - 1) / 7) + 1}`;
  return `اليوم ${relativeDay}`;
}

// ── Page 2: Timeline chart (bar) ────────────────────────────────────────────

async function drawTimelineVisual(
  context: ExecutiveBriefRenderContext,
  startY: number,
  chartHeight: number
): Promise<number> {
  const { doc, warnings, layout } = context;
  const titleY = drawSectionTitle(
    doc,
    "الاتجاه الزمني للشكاوى",
    layout.margin,
    startY,
    layout.contentWidth,
    layout
  );
  const timeline = context.brief.comparativeTimeline;
  const chart = {
    id: "executive-time-series",
    kind: "chart" as const,
    chartType: "bar" as const,
    title: timeline.previous ? "الفترة الحالية مقارنة بالفترة السابقة" : "اتجاه الفترة الحالية",
    series: [
      { name: timeline.current.label, points: timeline.current.points.map((point) => ({ x: point.label ?? timelinePointLabel(timeline.aggregation, point.relativeDay), y: point.count })) },
      ...(hasReferencePeriod(context) && timeline.previous
        ? [{ name: timeline.previous.label, points: timeline.previous.points.map((point) => ({ x: point.label ?? timelinePointLabel(timeline.aggregation, point.relativeDay), y: point.count })) }]
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
    warnings.push(`تعذر رسم مخطط الاتجاه الزمني: ${reason}`);
  }
  return titleY + chartHeight;
}

function buildPage2Notes(context: ExecutiveBriefRenderContext): string[] {
  const total = context.brief.briefKpis.find((card) => card.key === "total");
  const compliance = context.brief.briefKpis.find((card) => card.key === "complianceRate");
  const notes: string[] = [];
  if (total?.difference != null && hasReferencePeriod(context)) {
    notes.push(`صافي التغير في إجمالي الشكاوى ${formatReportNumber(total.difference, { sign: true })}.`);
  }
  if (compliance?.value === null) {
    notes.push("لا يتوفر مقام صالح لاحتساب الالتزام ضمن المهلة.");
  }
  if (notes.length === 0) {
    notes.push("يعرض الاتجاه إجمالي الشكاوى مجمعاً وفق طول الفترة المحددة.");
  }
  return notes.slice(0, 2);
}

function drawPage2Notes(context: ExecutiveBriefRenderContext, startY: number): void {
  const { doc, layout } = context;
  const titleY = drawSectionTitle(doc, "ملاحظات", layout.margin, startY, layout.contentWidth, layout);
  const notes = buildPage2Notes(context);
  const noteLineH = 24;
  const noteBoxH = Math.max(58, 16 + notes.length * noteLineH);
  doc.roundedRect(layout.margin, titleY, layout.contentWidth, noteBoxH, REPORT_DESIGN_TOKENS.card.radius)
    .fillAndStroke(COLORS.background, COLORS.border);
  doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.body).fillColor(COLORS.text);
  notes.forEach((note, index) => {
    doc.text(preparePdfText(`• ${note}`), layout.margin + 12, titleY + 9 + index * noteLineH, {
      width: layout.contentWidth - 24,
      height: noteLineH,
      align: "right",
      wordSpacing: ARABIC_WORD_SPACING,
      lineBreak: false,
      ellipsis: true,
    });
  });
}

// ── Cover page ───────────────────────────────────────────────────────────────

function renderCoverPage(context: ExecutiveBriefRenderContext): void {
  const { doc, data, brief, layout } = context;
  const comparison = getComparisonModeDescription(data.comparisonMode, data.previousPeriod);
  const valueFor = (key: string): number | null => (
    brief.briefKpis.find((item) => item.key === key)?.value ?? null
  );
  drawComplaintsReportCover({
    doc,
    pageSize: layout.pageSize,
    margin: layout.margin,
    title: data.title,
    periodText: `الفترة من ${data.period.from} إلى ${data.period.to}`,
    comparisonText: comparison,
    metrics: [
      { label: "إجمالي الشكاوى", value: valueFor("total") },
      { label: "المفتوحة", value: valueFor("open") },
      { label: "المغلقة", value: valueFor("closed") },
    ],
  });
}

async function renderPage2(context: ExecutiveBriefRenderContext): Promise<void> {
  let y = drawPageHeader(context, briefPageTitle(2));
  y = drawSectionTitle(context.doc, "ملخص المؤشرات", context.layout.margin, y, context.layout.contentWidth, context.layout);
  y = drawKpiGrid(context.doc, context.brief.briefKpis, context.layout, y);
  const notesHeight = 100;
  const chartHeight = Math.min(600, Math.max(
    340,
    Math.floor(context.layout.pageSize[1] - context.layout.margin - 26 - notesHeight - y)
  ));
  const chartBottom = await drawTimelineVisual(context, y, chartHeight);
  drawPage2Notes(context, chartBottom + 8);
}

// ── Page 3: Regions ──────────────────────────────────────────────────────────

function regionDirection(row: RegionReferenceRow): ExecutiveDirection {
  if (row.currentCount > row.previousCount) return "negative";
  if (row.currentCount < row.previousCount) return "positive";
  return "neutral";
}

function formatRegionCell(row: RegionReferenceRow, key: keyof RegionReferenceRow): string {
  if (key === "direction") return "";
  if (key === "changeRate") {
    if (row.changeRate === null && row.previousCount === 0 && row.currentCount > 0) return "جديد";
    return formatNullableReportNumber(row.changeRate, { percent: true });
  }
  if (key === "complianceRate") return formatNullableReportNumber(row.complianceRate, { percent: true });
  if (key === "difference") return formatReportNumber(row.difference, { sign: true });
  if (key === "averageResolutionDays") return formatNullableReportNumber(row.averageResolutionDays);
  if (key === "openCount") return formatReportNumber(row.openCount ?? 0);
  if (key === "closedCount") return formatReportNumber(row.closedCount ?? 0);
  const value = row[key];
  if (value === undefined || value === null) return "—";
  return typeof value === "number" ? formatReportNumber(value) : String(value);
}

function drawRtlTable<Row>(options: DrawTableOptions<Row>): number {
  const {
    doc, rows, columns, x, y, width, rowHeight, fontSize: tableFontSize,
    headerFontSize, maxRows, formatCell, directionForRow, directionKey, darkHeader,
  } = options;
  const hdrFontSize = headerFontSize ?? tableFontSize;
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
  const r = REPORT_DESIGN_TOKENS.card.radius;

  if (darkHeader) {
    // Dark green header with white text
    doc.roundedRect(x, y, width, headerHeight, r).fill(COLORS.primary);
    doc.font("Bold").fontSize(hdrFontSize).fillColor(COLORS.white);
  } else {
    doc.roundedRect(x, y, width, headerHeight, r)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Bold").fontSize(hdrFontSize).fillColor(COLORS.primary);
  }

  columns.forEach((column, index) => {
    doc.text(preparePdfText(column.label), offsets[index] + 4, y + 5, {
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
      doc.text(preparePdfText(formatCell(row, column.key)), offsets[columnIndex] + 4, rowY + 5, {
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

// Region table: المنطقة | الحالي | السابق | الفرق | نسبة التغير | المفتوحة | المتأخرة
const REGION_COLUMNS: readonly ColumnDefinition<RegionReferenceRow>[] = [
  { key: "regionName", label: "المنطقة", weight: 2.2 },
  { key: "currentCount", label: "الحالي", weight: 0.85 },
  { key: "previousCount", label: "السابق", weight: 0.85 },
  { key: "difference", label: "الفرق", weight: 0.8 },
  { key: "changeRate", label: "نسبة التغير", weight: 0.95 },
  { key: "openCount", label: "المفتوحة", weight: 0.9 },
  { key: "currentlyLate", label: "المتأخرة", weight: 0.9 },
];

function resolveRegionRowHeight(layout: BriefPageLayout, regionCount: number): number {
  if (regionCount <= 3) return layout.compact ? 34 : 60;
  if (regionCount <= 5) return layout.compact ? 28 : 42;
  return layout.compact ? 22 : 28;
}

function stripRegionPrefix(name: string): string {
  return name.replace(/^منطقة\s+/, "").replace(/^المنطقة\s+/, "");
}

function drawAllRegionCards(
  context: ExecutiveBriefRenderContext,
  startY: number
): number {
  const { doc, brief, layout } = context;
  const regions = visibleRegionRows(brief);
  const columns = 4;
  const gap = 10;
  const cardW = (layout.contentWidth - gap * (columns - 1)) / columns;
  const headerH = 28;
  const cardH = 105;
  const r = REPORT_DESIGN_TOKENS.card.radius;

  regions.forEach((region, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const x = layout.margin + (columns - 1 - col) * (cardW + gap);
    const y = startY + row * (cardH + gap);

    // Card background with border
    doc.roundedRect(x, y, cardW, cardH, r).fillAndStroke(COLORS.background, COLORS.border);

    // Dark green header strip (top-rounded corners)
    doc
      .moveTo(x + r, y)
      .lineTo(x + cardW - r, y)
      .quadraticCurveTo(x + cardW, y, x + cardW, y + r)
      .lineTo(x + cardW, y + headerH)
      .lineTo(x, y + headerH)
      .lineTo(x, y + r)
      .quadraticCurveTo(x, y, x + r, y)
      .closePath()
      .fill(COLORS.primary);

    // Region name in header (white text) — use short name (strip prefix)
    doc.font("Bold").fontSize(12).fillColor(COLORS.white).text(
      preparePdfText(stripRegionPrefix(region.regionName)),
      x + 8,
      y + (headerH - 13) / 2,
      {
        width: cardW - 16,
        align: "right",
        ellipsis: true,
        wordSpacing: ARABIC_WORD_SPACING,
        lineBreak: false,
      }
    );

    // Body: 3 metric columns (إجمالي | مفتوحة | متأخرة)
    const metricW = cardW / 3;
    const bodyY = y + headerH + 4;
    const metrics: Array<{ label: string; value: number }> = [
      { label: "متأخرة", value: region.currentlyLate },
      { label: "مفتوحة", value: region.openCount ?? 0 },
      { label: "إجمالي", value: region.currentCount },
    ];

    metrics.forEach((metric, mi) => {
      const mx = x + mi * metricW;
      // Vertical divider (except after last)
      if (mi < 2) {
        doc.moveTo(mx + metricW, bodyY + 4).lineTo(mx + metricW, y + cardH - 8)
          .strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.lineWidth(1);
      }
      doc.font("Body").fontSize(11).fillColor(COLORS.neutral).text(
        preparePdfText(metric.label),
        mx + 2,
        bodyY + 8,
        { width: metricW - 4, align: "center", wordSpacing: ARABIC_WORD_SPACING }
      );
      doc.font("Bold").fontSize(18).fillColor(COLORS.primary).text(
        formatReportNumber(metric.value),
        mx + 2,
        bodyY + 24,
        { width: metricW - 4, align: "center", wordSpacing: ARABIC_WORD_SPACING }
      );
    });
  });

  resetInk(doc);
  return startY + Math.ceil(regions.length / columns) * (cardH + gap);
}

async function drawRegionComparisonChart(
  context: ExecutiveBriefRenderContext,
  startY: number
): Promise<number> {
  const { doc, brief, layout, warnings } = context;
  const regions = visibleRegionRows(brief);
  const titleY = drawSectionTitle(doc, "مقارنة المناطق", layout.margin, startY, layout.contentWidth, layout);
  const chartHeight = 360;
  const currentPoints = regions.map((row) => ({
    x: stripRegionPrefix(row.regionName),
    y: row.currentCount,
  }));
  const series = [{ name: "الفترة الحالية", points: currentPoints }];
  if (hasReferencePeriod(context)) {
    series.push({
      name: "الفترة المقارنة",
      points: regions.map((row) => ({ x: stripRegionPrefix(row.regionName), y: row.previousCount })),
    });
  }
  try {
    const png = await renderLineChartPng({
      id: "executive-region-comparison",
      kind: "chart",
      chartType: "bar",
      title: hasReferencePeriod(context)
        ? "الحالي مقارنة بالفترة المرجعية حسب المنطقة"
        : "إجمالي الفترة الحالية حسب المنطقة",
      series,
      emptyState: "لا توجد بيانات مناطق ضمن الفترة المحددة.",
    }, Math.round(layout.contentWidth), chartHeight);
    doc.image(png, layout.margin, titleY, {
      width: layout.contentWidth,
      height: chartHeight,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`تعذر رسم مقارنة المناطق: ${reason}`);
  }
  return titleY + chartHeight + 10;
}

async function renderPage3(context: ExecutiveBriefRenderContext): Promise<void> {
  const { doc, brief, layout } = context;
  let y = drawPageHeader(context, briefPageTitle(3));
  if (!hasReferencePeriod(context)) {
    doc.roundedRect(layout.margin, y, layout.contentWidth, fontSize(layout, 54, 38), REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Body").fontSize(fontSize(layout, 12, 9)).fillColor(COLORS.neutral);
    doc.text(preparePdfText("لا تتوفر فترة مرجعية للمقارنة. يعرض الجدول أداء الفترة الحالية فقط."), layout.margin + 12, y + 16, {
      width: layout.contentWidth - 24,
      align: "center",
    });
    y += fontSize(layout, 66, 48);
  }
  y = await drawRegionComparisonChart(context, y);
  y = drawSectionTitle(doc, "بطاقات المناطق", layout.margin, y, layout.contentWidth, layout);
  y = drawAllRegionCards(context, y) + 8;
  y = drawSectionTitle(doc, "جميع المناطق", layout.margin, y, layout.contentWidth, layout);
  const tableRows = visibleRegionRows(brief);
  const regionCount = tableRows.length;
  const rowHeight = resolveRegionRowHeight(layout, regionCount);
  const rowsForDisplay = hasReferencePeriod(context)
    ? tableRows
    : tableRows.map((row) => ({ ...row, previousCount: 0, difference: 0, changeRate: null }));
  y = drawRtlTable({
    doc,
    rows: rowsForDisplay,
    columns: hasReferencePeriod(context)
      ? REGION_COLUMNS
      : REGION_COLUMNS.filter((col) => !["previousCount", "difference", "changeRate"].includes(String(col.key))),
    x: layout.margin,
    y,
    width: layout.contentWidth,
    rowHeight,
    fontSize: REPORT_DESIGN_TOKENS.fontSize.table,
    headerFontSize: REPORT_DESIGN_TOKENS.fontSize.tableHeader,
    maxRows: tableRows.length,
    formatCell: formatRegionCell,
    darkHeader: true,
  });
  y += 14;
  if (tableRows.length === 0) {
    doc.font("Body").fontSize(fontSize(layout, 11, 9)).fillColor(COLORS.neutral);
    doc.text(preparePdfText("لا توجد بيانات مناطق ضمن الفترة المحددة."), layout.margin, y, {
      width: layout.contentWidth,
      align: "center",
    });
  }
}

// ── Page 4: Classifications & Departments ────────────────────────────────────

type RiseTableRow = {
  departmentName: string;
  classificationName: string;
  currentCount: number;
  previousCount: number;
  difference: number;
};

const RISES_COLUMNS: readonly ColumnDefinition<RiseTableRow>[] = [
  { key: "departmentName", label: "الإدارة", weight: 2 },
  { key: "classificationName", label: "التصنيف", weight: 2 },
  { key: "currentCount", label: "الحالي", weight: 0.75 },
  { key: "previousCount", label: "السابق", weight: 0.75 },
  { key: "difference", label: "الفرق", weight: 0.75 },
];

function formatRiseCell(row: RiseTableRow, key: keyof RiseTableRow): string {
  if (key === "difference") return formatReportNumber(row.difference, { sign: true });
  const value = row[key];
  return typeof value === "number" ? formatReportNumber(value) : String(value);
}

const BRIEF_CLASS_COLUMNS: readonly ColumnDefinition<ClassificationBriefRow>[] = [
  { key: "classificationPath", label: "التصنيف", weight: 2.4 },
  { key: "currentCount", label: "الحالي", weight: 0.85 },
  { key: "previousCount", label: "السابق", weight: 0.85 },
  { key: "difference", label: "الفرق", weight: 0.85 },
];

function formatClassificationCell(
  row: ClassificationBriefRow,
  key: keyof ClassificationBriefRow
): string {
  if (key === "difference") return formatReportNumber(row.difference, { sign: true });
  if (key === "shareOfTotal") return formatReportNumber(row.shareOfTotal, { percent: true });
  if (key === "changeRate") return formatNullableReportNumber(row.changeRate, { percent: true });
  if (key === "classificationPath") return row.classificationPath;
  const value = row[key];
  return typeof value === "number" ? formatReportNumber(value) : String(value ?? "");
}

type DeptTableRow = {
  name: string;
  total: number;
  open: number;
  currentlyLate: number;
};

const DEPT_COLUMNS: readonly ColumnDefinition<DeptTableRow>[] = [
  { key: "name", label: "الإدارة", weight: 2.2 },
  { key: "total", label: "الإجمالي", weight: 0.85 },
  { key: "open", label: "المفتوحة", weight: 0.85 },
  { key: "currentlyLate", label: "المتأخرة", weight: 0.85 },
];

function formatDeptCell(row: DeptTableRow, key: keyof DeptTableRow): string {
  const value = row[key];
  return typeof value === "number" ? formatReportNumber(value) : String(value);
}

type DrawBulletBoxOptions = {
  title: string;
  points: readonly string[];
  x: number;
  y: number;
  width: number;
  height: number;
  layout: BriefPageLayout;
};

function drawBulletBox(doc: PDFKit.PDFDocument, options: DrawBulletBoxOptions): void {
  const { title, points, x, y, width, height, layout } = options;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const headerH = 30;

  // Card background
  doc.roundedRect(x, y, width, height, r).fillAndStroke(COLORS.background, COLORS.border);

  // Dark green header strip (top-rounded)
  doc
    .moveTo(x + r, y)
    .lineTo(x + width - r, y)
    .quadraticCurveTo(x + width, y, x + width, y + r)
    .lineTo(x + width, y + headerH)
    .lineTo(x, y + headerH)
    .lineTo(x, y + r)
    .quadraticCurveTo(x, y, x + r, y)
    .closePath()
    .fill(COLORS.primary);

  // Header title (white)
  doc.font("Bold").fontSize(fontSize(layout, 12, 9)).fillColor(COLORS.white).text(
    preparePdfText(title),
    x + 8,
    y + (headerH - fontSize(layout, 12, 9)) / 2,
    { width: width - 16, align: "right", wordSpacing: ARABIC_WORD_SPACING, lineBreak: false }
  );

  // Bullet points
  const bodyFontSize = REPORT_DESIGN_TOKENS.fontSize.body;
  const lineH = Math.ceil(bodyFontSize * 2);
  doc.font("Body").fontSize(bodyFontSize).fillColor(COLORS.text);
  const bodyY = y + headerH + 8;
  const bodyH = height - headerH - 12;
  const maxLines = Math.max(1, Math.floor(bodyH / lineH));
  const displayPoints = points.slice(0, maxLines);
  displayPoints.forEach((point, idx) => {
    doc.text(preparePdfText(`• ${point}`), x + 10, bodyY + idx * lineH, {
      width: width - 20,
      height: lineH - 2,
      align: "right",
      wordSpacing: ARABIC_WORD_SPACING,
      lineBreak: false,
      ellipsis: true,
    });
  });

  if (displayPoints.length === 0) {
    doc.font("Body").fontSize(bodyFontSize).fillColor(COLORS.neutral).text(
      preparePdfText("لا توجد بيانات."),
      x + 10,
      bodyY,
      { width: width - 20, align: "center" }
    );
  }

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
      text: `ارتفاع مؤثر في ${topRise.departmentName} / ${topRise.classificationPath ?? topRise.classificationName} بمقدار ${formatReportNumber(topRise.difference, { sign: true })}.`,
      assessment: "warning",
    });
  }
  if (items.length === 0) {
    items.push({ text: "لا توجد إشارات استثنائية إضافية ضمن البيانات المتاحة.", assessment: "neutral" });
  }
  return items.slice(0, 5);
}

function renderPage4(context: ExecutiveBriefRenderContext): void {
  const { doc, brief, data, layout } = context;
  let y = drawPageHeader(context, briefPageTitle(4));
  const gap = 16;
  const rowH = layout.compact ? 24 : 30;

  // ── Section 1: Full-width "الارتفاعات الملحوظة" table ────────────────────
  y = drawSectionTitle(doc, "الارتفاعات الملحوظة", layout.margin, y, layout.contentWidth, layout);

  const rises = hasReferencePeriod(context) ? (data.comparisonData?.deptClassRises ?? []) : [];
  if (rises.length > 0) {
    const riseRows: RiseTableRow[] = rises.slice(0, 8).map((r) => ({
      departmentName: r.departmentName,
      classificationName: r.classificationPath ?? r.classificationName,
      currentCount: r.currentCount,
      previousCount: r.previousCount,
      difference: r.difference,
    }));
    y = drawRtlTable({
      doc,
      rows: riseRows,
      columns: RISES_COLUMNS,
      x: layout.margin,
      y,
      width: layout.contentWidth,
      rowHeight: rowH,
      fontSize: REPORT_DESIGN_TOKENS.fontSize.table,
      headerFontSize: REPORT_DESIGN_TOKENS.fontSize.tableHeader,
      maxRows: 8,
      formatCell: formatRiseCell,
      darkHeader: true,
    });
  } else {
    doc.roundedRect(layout.margin, y, layout.contentWidth, 48, REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Body").fontSize(11).fillColor(COLORS.neutral).text(
      preparePdfText("لا توجد ارتفاعات إدارية وتصنيفية مؤثرة في هذه الفترة."),
      layout.margin + 12, y + 16,
      { width: layout.contentWidth - 24, align: "center" }
    );
    y += 48;
  }
  y += gap;

  // ── Section 2: Two side-by-side tables ───────────────────────────────────
  const halfW = (layout.contentWidth - gap) / 2;
  const rightX = layout.margin + halfW + gap; // right = classifications
  const leftX = layout.margin;                // left  = departments

  const rightTableY = drawSectionTitle(doc, "أعلى التصنيفات", rightX, y, halfW, layout);
  const classRows = hasReferencePeriod(context)
    ? brief.topClassifications
    : brief.topClassifications.map((r) => ({ ...r, previousCount: 0, difference: 0 }));
  const classTableCols = hasReferencePeriod(context)
    ? BRIEF_CLASS_COLUMNS
    : BRIEF_CLASS_COLUMNS.filter((c) => !["previousCount", "difference"].includes(String(c.key)));
  const classBottom = drawRtlTable({
    doc,
    rows: classRows,
    columns: classTableCols,
    x: rightX,
    y: rightTableY,
    width: halfW,
    rowHeight: rowH,
    fontSize: REPORT_DESIGN_TOKENS.fontSize.table,
    headerFontSize: REPORT_DESIGN_TOKENS.fontSize.tableHeader,
    maxRows: 8,
    formatCell: formatClassificationCell,
    darkHeader: true,
  });

  const leftTableY = drawSectionTitle(doc, "أعلى الإدارات", leftX, y, halfW, layout);
  const deptRows: DeptTableRow[] = (brief.topDepartments ?? []).slice(0, 8).map((d) => ({
    name: d.name,
    total: d.total,
    open: d.open,
    currentlyLate: d.currentlyLate,
  }));
  const deptBottom = drawRtlTable({
    doc,
    rows: deptRows,
    columns: DEPT_COLUMNS,
    x: leftX,
    y: leftTableY,
    width: halfW,
    rowHeight: rowH,
    fontSize: REPORT_DESIGN_TOKENS.fontSize.table,
    headerFontSize: REPORT_DESIGN_TOKENS.fontSize.tableHeader,
    maxRows: 8,
    formatCell: formatDeptCell,
    darkHeader: true,
  });

  y = Math.max(classBottom, deptBottom) + gap;

  // ── Section 3: Two side-by-side boxes (الاستنتاجات + ملاحظات) ────────────
  const conclusions = (brief.conclusions ?? []).slice(0, 6);
  const notes = (brief.notes ?? []).length > 0
    ? (brief.notes ?? []).slice(0, 5)
    : buildAttentionItems(context).map((item) => item.text).slice(0, 5);

  const boxLineH = Math.ceil(REPORT_DESIGN_TOKENS.fontSize.body * 2);
  const boxHeaderH = 30;
  const boxPaddingV = 8 + 12;
  const contentLinesMax = Math.max(conclusions.length, notes.length, 1);
  const contentBasedH = boxHeaderH + boxPaddingV + contentLinesMax * boxLineH;
  const availableH = layout.pageSize[1] - layout.margin * 2 - 26 - y;
  const minimumBoxH = boxHeaderH + boxPaddingV + boxLineH;
  const boxH = Math.max(minimumBoxH, Math.min(contentBasedH, availableH));

  // Right: الاستنتاجات
  drawBulletBox(doc, { title: "الاستنتاجات", points: conclusions, x: rightX, y, width: halfW, height: boxH, layout });
  // Left: ملاحظات
  drawBulletBox(doc, { title: "ملاحظات", points: notes, x: leftX, y, width: halfW, height: boxH, layout });
}

// ── Footers ───────────────────────────────────────────────────────────────────

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
      preparePdfText(`صفحة ${formatReportNumber(pageNumber)} من ${formatReportNumber(range.count)}`),
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
  if (brief.allRegions.length > MAX_EXECUTIVE_REGION_ROWS) {
    warnings.push(
      `تم عرض أول ${MAX_EXECUTIVE_REGION_ROWS} تسمية منطقة فقط بسبب وجود عدد غير اعتيادي من التسميات.`
    );
  }
  renderCoverPage(context);
  doc.addPage();
  await renderPage2(context);
  doc.addPage();
  await renderPage3(context);
  doc.addPage();
  renderPage4(context);
  drawBriefFooters(doc, data, layout);
  doc.end();
  return { buffer: await done, warnings };
}
