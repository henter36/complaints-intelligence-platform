/**
 * PRINT_EXECUTIVE_BRIEF_V2 — standalone 4-page PDF renderer.
 *
 * Page layout targets A4-portrait (PRINT_EXECUTIVE_PAGE_SIZE). createV2Layout may
 * expand the height when many regions need cards + table space so content fits.
 *
 *   1. Cover   — large title + 3 summary cards + all-time total
 *   2. KPIs    — 8 icon-KPI cards + monthly inflow/closed chart + notes
 *   3. Regions — comparison chart + volume cards + delta/topic table
 *   4. Dept/Class — notable rises + classification table + department table + conclusions + data notes
 */

import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  directionColor,
  directionFromAssessment,
  formatNullableReportNumber,
  formatReportNumber,
  PRINT_EXECUTIVE_PAGE_SIZE,
  REPORT_DESIGN_TOKENS,
  type ExecutiveDirection,
} from "@/lib/reports/design-tokens";
import type {
  ExecutiveBriefKpiCard,
  RegionReferenceRow,
  ClassificationBriefRow,
  ExecutiveEntityRow,
} from "@/lib/reports/report-contract";
import type { ExecutiveBriefV2Data, ReportData } from "./report-data-service";
import { isExecutiveBriefV2Data } from "./report-data-service";
import { renderLineChartPng } from "./report-chart-service";
import { preparePdfText } from "./arabic-pdf-text";
import { getComparisonModeDescription } from "@/lib/reports/comparison-mode-labels";

// ── Constants ─────────────────────────────────────────────────────────────────

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const COLORS = REPORT_DESIGN_TOKENS.colors;
const WORD_SPACING = REPORT_DESIGN_TOKENS.typography.wordSpacing;
const PAGE_COUNT = 4;
const MAX_REGION_ROWS = 13;

let fontRegularBuffer: Buffer | null = null;
let fontBoldBuffer: Buffer | null = null;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!fontRegularBuffer) fontRegularBuffer = fs.readFileSync(FONT_REGULAR_PATH);
  if (!fontBoldBuffer) fontBoldBuffer = fs.readFileSync(FONT_BOLD_PATH);
  return { regular: fontRegularBuffer, bold: fontBoldBuffer };
}

export type ExecutiveBriefV2PdfResult = {
  buffer: Buffer;
  warnings: string[];
};

// Re-export the data type so callers can reference it without importing the data service directly.
export type { ExecutiveBriefV2Data };

// ── Layout ────────────────────────────────────────────────────────────────────

type V2Layout = {
  pageSize: readonly [number, number];
  margin: number;
  contentWidth: number;
};

function createV2Layout(regionCount: number): V2Layout {
  const margin = 42;
  const [pw, ph] = PRINT_EXECUTIVE_PAGE_SIZE;
  const safeCount = Math.min(regionCount, MAX_REGION_ROWS);
  const cardRows = Math.ceil(safeCount / 4);
  const pageH = Math.max(ph, 880 + cardRows * 118 + safeCount * 28);
  return { pageSize: [pw, pageH] as const, margin, contentWidth: pw - margin * 2 };
}

type V2Context = {
  doc: PDFKit.PDFDocument;
  data: ReportData;
  brief: ExecutiveBriefV2Data;
  warnings: string[];
  layout: V2Layout;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetInk(doc: PDFKit.PDFDocument): void {
  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary).lineWidth(1);
}

function drawGoldDots(doc: PDFKit.PDFDocument, x: number, y: number): void {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      doc.circle(x + c * 13, y + r * 13, 2.5).fill(COLORS.gold);
    }
  }
  doc.fillColor(COLORS.primary);
}

function drawDiamond(doc: PDFKit.PDFDocument, cx: number, cy: number, r: number): void {
  doc.moveTo(cx, cy - r).lineTo(cx + r, cy).lineTo(cx, cy + r).lineTo(cx - r, cy).closePath().fill(COLORS.gold);
  doc.fillColor(COLORS.primary);
}

function drawGoldSeparator(doc: PDFKit.PDFDocument, cx: number, y: number, halfW: number): void {
  const gap = 14;
  doc.moveTo(cx - halfW, y).lineTo(cx - gap, y).strokeColor(COLORS.gold).lineWidth(1).stroke();
  doc.moveTo(cx + gap, y).lineTo(cx + halfW, y).strokeColor(COLORS.gold).lineWidth(1).stroke();
  drawDiamond(doc, cx, y, 6);
  doc.strokeColor(COLORS.border).lineWidth(1);
}

function drawSectionTitle(
  doc: PDFKit.PDFDocument,
  title: string,
  x: number,
  y: number,
  width: number
): number {
  doc.font("Bold").fontSize(13).fillColor(COLORS.primary);
  doc.text(preparePdfText(title), x, y, { width, align: "right", wordSpacing: WORD_SPACING });
  return y + 13 + 8;
}

// ── Icon drawing ──────────────────────────────────────────────────────────────

type IconType =
  | "clipboard"    // شكاوى الفترة
  | "folder"       // المفتوحة
  | "check"        // المغلقة
  | "hourglass"    // المتأخرة
  | "database"     // إجمالي في النظام
  | "clock-x"     // المغلقة بعد المهلة
  | "target"       // الالتزام
  | "calendar"     // متوسط الإغلاق
  | "info"         // info box
  | "report";      // الاستنتاجات

function drawIcon(doc: PDFKit.PDFDocument, type: IconType, cx: number, cy: number, r: number): void {
  const s = r * 0.55; // icon size relative to circle radius
  doc.lineWidth(1.5).lineCap("round").strokeColor(COLORS.gold);

  if (type === "clipboard") {
    // Rectangle body + tab at top + 3 horizontal lines
    doc.roundedRect(cx - s * 0.7, cy - s * 0.65, s * 1.4, s * 1.35, 2).stroke();
    doc.roundedRect(cx - s * 0.35, cy - s * 0.85, s * 0.7, s * 0.3, 2).stroke();
    doc.moveTo(cx - s * 0.45, cy - s * 0.15).lineTo(cx + s * 0.45, cy - s * 0.15).stroke();
    doc.moveTo(cx - s * 0.45, cy + s * 0.1).lineTo(cx + s * 0.45, cy + s * 0.1).stroke();
    doc.moveTo(cx - s * 0.45, cy + s * 0.35).lineTo(cx + s * 0.15, cy + s * 0.35).stroke();
  } else if (type === "folder") {
    // Folder shape
    doc.moveTo(cx - s * 0.7, cy - s * 0.1).lineTo(cx - s * 0.7, cy + s * 0.55)
      .lineTo(cx + s * 0.7, cy + s * 0.55).lineTo(cx + s * 0.7, cy - s * 0.25)
      .lineTo(cx + s * 0.1, cy - s * 0.25).lineTo(cx - s * 0.1, cy - s * 0.55)
      .lineTo(cx - s * 0.7, cy - s * 0.55).closePath().stroke();
  } else if (type === "check") {
    // Circle with checkmark
    doc.circle(cx, cy, s * 0.85).stroke();
    doc.moveTo(cx - s * 0.4, cy + s * 0.05).lineTo(cx - s * 0.1, cy + s * 0.4)
      .lineTo(cx + s * 0.45, cy - s * 0.35).stroke();
  } else if (type === "hourglass") {
    // Two triangles (hourglass)
    doc.moveTo(cx - s * 0.55, cy - s * 0.7).lineTo(cx + s * 0.55, cy - s * 0.7)
      .lineTo(cx, cy).closePath().stroke();
    doc.moveTo(cx - s * 0.55, cy + s * 0.7).lineTo(cx + s * 0.55, cy + s * 0.7)
      .lineTo(cx, cy).closePath().stroke();
    doc.moveTo(cx - s * 0.55, cy - s * 0.7).lineTo(cx - s * 0.55, cy + s * 0.7).stroke();
    doc.moveTo(cx + s * 0.55, cy - s * 0.7).lineTo(cx + s * 0.55, cy + s * 0.7).stroke();
  } else if (type === "database") {
    // Stacked cylinders
    doc.ellipse(cx, cy - s * 0.5, s * 0.65, s * 0.2).stroke();
    doc.ellipse(cx, cy + s * 0.1, s * 0.65, s * 0.2).stroke();
    doc.ellipse(cx, cy + s * 0.7, s * 0.65, s * 0.2).stroke();
    doc.moveTo(cx - s * 0.65, cy - s * 0.5).lineTo(cx - s * 0.65, cy + s * 0.7).stroke();
    doc.moveTo(cx + s * 0.65, cy - s * 0.5).lineTo(cx + s * 0.65, cy + s * 0.7).stroke();
  } else if (type === "clock-x") {
    // Clock face
    doc.circle(cx, cy, s * 0.8).stroke();
    doc.moveTo(cx, cy - s * 0.5).lineTo(cx, cy).stroke();
    doc.moveTo(cx, cy).lineTo(cx + s * 0.35, cy + s * 0.2).stroke();
    // X mark overlaid
    doc.moveTo(cx + s * 0.35, cy - s * 0.55).lineTo(cx + s * 0.6, cy - s * 0.3).stroke();
    doc.moveTo(cx + s * 0.6, cy - s * 0.55).lineTo(cx + s * 0.35, cy - s * 0.3).stroke();
  } else if (type === "target") {
    // Concentric circles + crosshair
    doc.circle(cx, cy, s * 0.8).stroke();
    doc.circle(cx, cy, s * 0.5).stroke();
    doc.circle(cx, cy, 2).fill(COLORS.gold);
  } else if (type === "calendar") {
    // Calendar rectangle
    doc.roundedRect(cx - s * 0.65, cy - s * 0.55, s * 1.3, s * 1.2, 2).stroke();
    doc.moveTo(cx - s * 0.65, cy - s * 0.2).lineTo(cx + s * 0.65, cy - s * 0.2).stroke();
    doc.moveTo(cx - s * 0.25, cy - s * 0.75).lineTo(cx - s * 0.25, cy - s * 0.35).stroke();
    doc.moveTo(cx + s * 0.25, cy - s * 0.75).lineTo(cx + s * 0.25, cy - s * 0.35).stroke();
    // Grid dots
    for (let gr = 0; gr < 2; gr++) {
      for (let gc = 0; gc < 3; gc++) {
        doc.circle(cx - s * 0.45 + gc * s * 0.45, cy + s * 0.05 + gr * s * 0.35, 1.5).fill(COLORS.gold);
      }
    }
  } else if (type === "info") {
    doc.circle(cx, cy, s * 0.8).stroke();
    doc.font("Bold").fontSize(s * 1.2).fillColor(COLORS.gold).text("i", cx - s * 0.35, cy - s * 0.65, {
      width: s * 0.7, align: "center", lineBreak: false,
    });
    doc.fillColor(COLORS.primary).font("Body");
  } else if (type === "report") {
    // Document with lines
    doc.roundedRect(cx - s * 0.6, cy - s * 0.75, s * 1.2, s * 1.5, 2).stroke();
    doc.moveTo(cx - s * 0.35, cy - s * 0.25).lineTo(cx + s * 0.35, cy - s * 0.25).stroke();
    doc.moveTo(cx - s * 0.35, cy + s * 0.05).lineTo(cx + s * 0.35, cy + s * 0.05).stroke();
    doc.moveTo(cx - s * 0.35, cy + s * 0.35).lineTo(cx + s * 0.1, cy + s * 0.35).stroke();
  }

  doc.lineWidth(1).lineCap("butt");
  resetInk(doc);
}

// ── Direction arrow (same as V1) ─────────────────────────────────────────────

function drawDirectionArrow(doc: PDFKit.PDFDocument, direction: ExecutiveDirection, x: number, y: number, size: number): void {
  const cx = x + size / 2;
  const wing = size * 0.28;
  doc.lineWidth(Math.max(1.2, size * 0.12)).lineCap("round").strokeColor(directionColor(direction));
  if (direction === "positive") {
    doc.moveTo(cx, y + size - 2).lineTo(cx, y + 2).stroke();
    doc.moveTo(cx, y + 2).lineTo(cx - wing, y + 2 + wing).stroke();
    doc.moveTo(cx, y + 2).lineTo(cx + wing, y + 2 + wing).stroke();
  } else if (direction === "negative") {
    doc.moveTo(cx, y + 2).lineTo(cx, y + size - 2).stroke();
    doc.moveTo(cx, y + size - 2).lineTo(cx - wing, y + size - 2 - wing).stroke();
    doc.moveTo(cx, y + size - 2).lineTo(cx + wing, y + size - 2 - wing).stroke();
  } else {
    doc.moveTo(x + 2, y + size / 2).lineTo(x + size - 2, y + size / 2).stroke();
  }
  doc.lineWidth(1).lineCap("butt");
  resetInk(doc);
}

// ── KPI formatting ─────────────────────────────────────────────────────────────

function formatKpiValue(card: ExecutiveBriefKpiCard): string {
  if (card.value === null) return "غير متاح";
  if (card.format === "percent") return formatReportNumber(card.value, { percent: true });
  if (card.format === "days") return `${formatReportNumber(card.value)} يوم`;
  return formatReportNumber(card.value);
}

function formatKpiDelta(card: ExecutiveBriefKpiCard): string {
  if (card.difference === null) return "";
  const diff = formatReportNumber(card.difference, { sign: true });
  if (card.changeRate === null) return diff;
  return `${diff}  (${formatReportNumber(card.changeRate, { sign: true, percent: true })})`;
}

// ── Page banner (pages 2-4) ───────────────────────────────────────────────────

function drawPageBanner(doc: PDFKit.PDFDocument, layout: V2Layout): void {
  const [PW, PH] = layout.pageSize;
  doc.rect(0, 0, PW, PH).fill(COLORS.background);
  const bannerH = Math.round(PH * 0.18);
  doc.moveTo(0, 0).lineTo(PW * 0.5, 0)
    .bezierCurveTo(PW * 0.38, bannerH * 0.52, PW * 0.22, bannerH * 0.8, 0, bannerH * 0.72)
    .closePath().fill(COLORS.primary);
  doc.moveTo(0, bannerH * 0.72)
    .bezierCurveTo(PW * 0.22, bannerH * 0.8, PW * 0.38, bannerH * 0.52, PW * 0.5, 0)
    .lineWidth(2.5).strokeColor(COLORS.gold).stroke();
  doc.lineWidth(1);
  drawGoldDots(doc, PW - layout.margin - 36, layout.margin + 16);
  resetInk(doc);
}

/** Draws banner + large page title + gold separator. Returns content Y. */
function drawPageHeader(ctx: V2Context, title: string): number {
  const { doc, layout } = ctx;
  drawPageBanner(doc, layout);

  const [PW] = layout.pageSize;
  const { margin, contentWidth } = layout;
  const bannerH = Math.round(layout.pageSize[1] * 0.18);
  const titleSize = 42;
  const titleY = Math.round(bannerH * 0.82);

  doc.font("Bold").fontSize(titleSize).fillColor(COLORS.primary).text(
    preparePdfText(title), margin, titleY,
    { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  const titleH = doc.heightOfString(preparePdfText(title), { width: contentWidth });
  const sepY = titleY + titleH + 10;
  drawGoldSeparator(doc, PW / 2, sepY, contentWidth * 0.35);
  resetInk(doc);
  return sepY + 20;
}

// ── Shared table renderer ────────────────────────────────────────────────────

type ColDef = { key: string; label: string; weight: number };

function drawTable<Row extends object>(
  doc: PDFKit.PDFDocument,
  rows: readonly Row[],
  cols: readonly ColDef[],
  x: number,
  y: number,
  width: number,
  rowH: number,
  formatCell: (row: Row, key: string) => string,
  maxRows = rows.length
): number {
  const totalWeight = cols.reduce((s, c) => s + c.weight, 0);
  const widths = cols.map((c) => width * c.weight / totalWeight);
  const offsets: number[] = [];
  let cur = x + width;
  widths.forEach((w) => { cur -= w; offsets.push(cur); });

  const hdrH = rowH + 2;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  doc.roundedRect(x, y, width, hdrH, r).fill(COLORS.primary);
  doc.font("Bold").fontSize(REPORT_DESIGN_TOKENS.fontSize.tableHeader).fillColor(COLORS.white);
  cols.forEach((col, i) => {
    doc.text(preparePdfText(col.label), offsets[i] + 4, y + 5, {
      width: widths[i] - 8, height: hdrH - 7, align: "right", ellipsis: true, wordSpacing: WORD_SPACING,
    });
  });

  let rowY = y + hdrH;
  rows.slice(0, maxRows).forEach((row, ri) => {
    if (ri % 2 === 1) doc.rect(x, rowY, width, rowH).fill(COLORS.tableRowAlternate);
    doc.moveTo(x, rowY + rowH).lineTo(x + width, rowY + rowH).strokeColor(COLORS.border).stroke();
    doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.table).fillColor(COLORS.primary);
    cols.forEach((col, i) => {
      const cellText = formatCell(row, col.key);
      // Show negative differences and change rates in red (U+2212 or ASCII -)
      const isDeltaColumn = col.key === "difference" || col.key === "changeRate";
      const isNegative =
        isDeltaColumn &&
        (cellText.startsWith("−") || cellText.startsWith("-"));
      if (isNegative) {
        doc.fillColor(COLORS.danger);
      }
      doc.text(preparePdfText(cellText), offsets[i] + 4, rowY + 5, {
        width: widths[i] - 8, height: rowH - 6, align: "right", ellipsis: true, wordSpacing: WORD_SPACING,
      });
      if (isNegative) {
        doc.fillColor(COLORS.primary);
      }
    });
    rowY += rowH;
  });
  resetInk(doc);
  return rowY;
}

// ── Bullet box (conclusions / notes) ─────────────────────────────────────────

function drawBulletBox(
  doc: PDFKit.PDFDocument,
  title: string,
  icon: IconType,
  points: readonly string[],
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const hdrH = 30;
  doc.roundedRect(x, y, width, height, r).fillAndStroke(COLORS.background, COLORS.border);
  doc.moveTo(x + r, y).lineTo(x + width - r, y)
    .quadraticCurveTo(x + width, y, x + width, y + r)
    .lineTo(x + width, y + hdrH).lineTo(x, y + hdrH).lineTo(x, y + r)
    .quadraticCurveTo(x, y, x + r, y).closePath().fill(COLORS.primary);
  doc.font("Bold").fontSize(11).fillColor(COLORS.white).text(
    preparePdfText(title), x + 8, y + (hdrH - 11) / 2,
    { width: width - 16, align: "right", wordSpacing: WORD_SPACING, lineBreak: false }
  );
  // Draw icon (small, in header)
  drawIcon(doc, icon, x + 20, y + hdrH / 2, 14);

  const lineH = 22;
  const bodyFontSize = REPORT_DESIGN_TOKENS.fontSize.body;
  const maxLines = Math.max(1, Math.floor((height - hdrH - 16) / lineH));
  doc.font("Body").fontSize(bodyFontSize).fillColor(COLORS.text);
  const display = points.slice(0, maxLines);
  display.forEach((pt, idx) => {
    doc.text(preparePdfText(`• ${pt}`), x + 10, y + hdrH + 8 + idx * lineH, {
      width: width - 20, height: lineH - 2, align: "right",
      wordSpacing: WORD_SPACING, lineBreak: false, ellipsis: true,
    });
  });
  if (display.length === 0) {
    doc.font("Body").fontSize(bodyFontSize).fillColor(COLORS.neutral).text(
      preparePdfText("لا توجد بيانات."), x + 10, y + hdrH + 8,
      { width: width - 20, align: "center" }
    );
  }
  resetInk(doc);
}

// ── Info box (ℹ methodology note) ─────────────────────────────────────────────

function drawInfoBox(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number): number {
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const fontSize = REPORT_DESIGN_TOKENS.fontSize.body;
  const innerW = width - 48;
  const textH = doc.heightOfString(preparePdfText(text), { width: innerW });
  const boxH = Math.max(46, textH + 20);
  doc.roundedRect(x, y, width, boxH, r).fillAndStroke(COLORS.background, COLORS.border);
  drawIcon(doc, "info", x + 24, y + boxH / 2, 16);
  doc.font("Body").fontSize(fontSize).fillColor(COLORS.neutral).text(
    preparePdfText(text), x + 42, y + (boxH - textH) / 2,
    { width: innerW, align: "right", wordSpacing: WORD_SPACING }
  );
  resetInk(doc);
  return y + boxH;
}

// ── Page 1: Cover ─────────────────────────────────────────────────────────────

function renderCoverPage(ctx: V2Context): void {
  const { doc, data, brief, layout } = ctx;
  const [PW, PH] = layout.pageSize;
  const { margin, contentWidth } = layout;

  // Background
  doc.rect(0, 0, PW, PH).fill(COLORS.background);

  // Full-width curved green banner (same bezier as report-cover.ts)
  const bannerH = Math.round(PH * 0.24);
  doc.moveTo(0, 0).lineTo(PW, 0).lineTo(PW, bannerH * 0.72)
    .bezierCurveTo(PW * 0.72, bannerH * 0.86, PW * 0.38, bannerH * 1.07, 0, bannerH)
    .closePath().fill(COLORS.primary);
  doc.moveTo(0, bannerH)
    .bezierCurveTo(PW * 0.38, bannerH * 1.07, PW * 0.72, bannerH * 0.86, PW, bannerH * 0.72)
    .lineWidth(3).strokeColor(COLORS.gold).stroke();
  doc.lineWidth(1);

  // Gold dots top-right
  drawGoldDots(doc, PW - margin - 36, margin + 18);

  // Subtle bottom wave
  const botWaveY = PH - 220;
  doc.moveTo(0, PH).lineTo(PW, PH).lineTo(PW, botWaveY)
    .bezierCurveTo(PW * 0.68, botWaveY - 18, PW * 0.32, botWaveY + 16, 0, botWaveY + 6)
    .closePath().fillOpacity(0.13).fill(COLORS.gold);
  doc.fillOpacity(1);

  // Large title
  const titleY = bannerH + 28;
  const titleOpts = { width: contentWidth, align: "center" as const, wordSpacing: WORD_SPACING };
  doc.font("Bold").fontSize(80).fillColor(COLORS.primary).text(preparePdfText(data.title), margin, titleY, titleOpts);
  const titleH = doc.heightOfString(preparePdfText(data.title), titleOpts);

  // Gold separator
  const sepY = titleY + titleH + 14;
  drawGoldSeparator(doc, PW / 2, sepY, contentWidth * 0.28);

  // Period text
  const periodY = sepY + 20;
  doc.font("Bold").fontSize(16).fillColor(COLORS.text).text(
    preparePdfText(`الفترة من ${data.period.from} إلى ${data.period.to}`),
    margin, periodY, { width: contentWidth, align: "center", wordSpacing: WORD_SPACING }
  );

  // Comparison text
  const comparison = getComparisonModeDescription(data.comparisonMode, data.previousPeriod);
  doc.font("Body").fontSize(13).fillColor(COLORS.neutral).text(
    preparePdfText(comparison), margin, periodY + 34,
    { width: contentWidth, align: "center", wordSpacing: WORD_SPACING }
  );

  // Policy note
  const policyNote = "تعتمد شكاوى الفترة على تاريخ إنشاء الشكوى، بينما تشمل مؤشرات المفتوحة والمتأخرة جميع الحالات غير المغلقة حتى نهاية الفترة ولو أُنشئت قبل بداية الفترة.";
  doc.font("Body").fontSize(11).fillColor(COLORS.neutral).text(
    preparePdfText(policyNote), margin, periodY + 66,
    { width: contentWidth, align: "center", wordSpacing: WORD_SPACING }
  );

  // 3 KPI cards on cover
  const cardY = periodY + 130;
  const cardGap = 18;
  const cardW = (contentWidth - cardGap * 2) / 3;
  const cardH = 180;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const circR = 30;

  const coverCards: Array<{ key: string; icon: IconType; label: string; primary: string; sub: string }> = (() => {
    const total = brief.briefKpis.find((k) => k.key === "total");
    const closed = brief.briefKpis.find((k) => k.key === "closed");
    const open = brief.briefKpis.find((k) => k.key === "open");
    const late = brief.briefKpis.find((k) => k.key === "currentlyLate");

    const totalVal = total ? formatKpiValue(total) : "—";
    const totalSub = total?.difference !== null && total
      ? `(${formatReportNumber(total.changeRate ?? 0, { sign: true, percent: true })}) ${formatReportNumber(total.difference ?? 0, { sign: true })} | السابق ${formatReportNumber(total.previousValue ?? 0)}`
      : "";

    const closedVal = closed ? formatKpiValue(closed) : "—";
    const closedSub = closed?.difference !== null && closed
      ? `(${formatReportNumber(closed.changeRate ?? 0, { sign: true, percent: true })}) ${formatReportNumber(closed.difference ?? 0, { sign: true })} | السابق ${formatReportNumber(closed.previousValue ?? 0)}`
      : "";

    const openV = open?.value ?? 0;
    const lateV = late?.value ?? 0;
    const openLateVal = `${formatReportNumber(openV)} / ${formatReportNumber(lateV)}`;
    const openLateSub = `مفتوحة ${formatReportNumber(openV)} | متأخرة ${formatReportNumber(lateV)}`;

    return [
      { key: "total", icon: "clipboard" as IconType, label: "شكاوى الفترة", primary: totalVal, sub: totalSub },
      { key: "closed", icon: "check" as IconType, label: "المغلقة خلال الفترة", primary: closedVal, sub: closedSub },
      { key: "openLate", icon: "hourglass" as IconType, label: "المفتوحة والمتأخرة نهاية الفترة", primary: openLateVal, sub: openLateSub },
    ];
  })();

  coverCards.forEach((card, idx) => {
    const x = margin + (2 - idx) * (cardW + cardGap);
    doc.roundedRect(x, cardY, cardW, cardH, r).fillAndStroke(COLORS.background, COLORS.border);

    // Circular gold icon ring
    const circX = x + cardW / 2;
    const circY = cardY + circR + 14;
    doc.circle(circX, circY, circR).lineWidth(1.5).strokeColor(COLORS.gold).stroke();
    doc.lineWidth(1);
    drawIcon(doc, card.icon, circX, circY, circR);

    // Label
    doc.font("Body").fontSize(11).fillColor(COLORS.neutral).text(
      preparePdfText(card.label), x + 6, circY + circR + 8,
      { width: cardW - 12, align: "center", wordSpacing: WORD_SPACING }
    );

    // Value
    doc.font("Bold").fontSize(28).fillColor(COLORS.primary).text(
      preparePdfText(card.primary), x + 6, circY + circR + 28,
      { width: cardW - 12, align: "center", wordSpacing: WORD_SPACING }
    );

    // Sub-text (change info)
    if (card.sub) {
      doc.font("Body").fontSize(10).fillColor(COLORS.neutral).text(
        preparePdfText(card.sub), x + 6, circY + circR + 70,
        { width: cardW - 12, align: "center", wordSpacing: WORD_SPACING, lineBreak: false, ellipsis: true }
      );
    }

    // Gold underline
    doc.moveTo(x + cardW * 0.28, cardY + cardH - 16).lineTo(x + cardW * 0.72, cardY + cardH - 16)
      .strokeColor(COLORS.gold).lineWidth(2.5).stroke();
    doc.lineWidth(1).strokeColor(COLORS.border);
  });

  // All-time total footer
  const footerY = cardY + cardH + 24;
  const footerBoxH = 46;
  doc.roundedRect(margin, footerY, contentWidth, footerBoxH, r).fillAndStroke(COLORS.background, COLORS.border);
  drawIcon(doc, "database", margin + 24, footerY + footerBoxH / 2, 16);
  doc.font("Bold").fontSize(13).fillColor(COLORS.primary);
  const allTimeTotalText = `إجمالي الشكاوى المسجلة في النظام منذ بدء التشغيل: ${formatReportNumber(brief.allTimeTotal)}`;
  doc.text(preparePdfText(allTimeTotalText), margin + 44, footerY + (footerBoxH - 13) / 2, {
    width: contentWidth - 56, align: "right", wordSpacing: WORD_SPACING, lineBreak: false,
  });
  resetInk(doc);
}

// ── Page 2: KPIs + monthly chart + notes ─────────────────────────────────────

const ICON_KEY_MAP: Record<string, IconType> = {
  total: "clipboard",
  closed: "check",
  open: "folder",
  currentlyLate: "hourglass",
  netChange: "database",
  allTimeTotal: "database",
  closedLate: "clock-x",
  complianceRate: "target",
  averageResolutionDays: "calendar",
  highPriorityOpen: "hourglass",
};

function kpiSpecialSubText(card: ExecutiveBriefKpiCard): string | null {
  if (card.key === "allTimeTotal") return "منذ بدء التشغيل";
  if (card.key === "complianceRate") return "للحالات ذات موعد مستهدف";
  return null;
}

function drawIconKpiCard(
  doc: PDFKit.PDFDocument,
  card: ExecutiveBriefKpiCard,
  x: number,
  y: number,
  cardW: number,
  cardH: number
): void {
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const circR = 24;
  doc.roundedRect(x, y, cardW, cardH, r).fillAndStroke(COLORS.background, COLORS.border);

  const circX = x + cardW / 2;
  const circY = y + circR + 10;
  doc.circle(circX, circY, circR).lineWidth(1.5).strokeColor(COLORS.gold).stroke();
  doc.lineWidth(1);
  const iconType = ICON_KEY_MAP[card.key] ?? "clipboard";
  drawIcon(doc, iconType, circX, circY, circR);

  doc.font("Body").fontSize(10).fillColor(COLORS.neutral).text(
    preparePdfText(card.label), x + 4, circY + circR + 6,
    { width: cardW - 8, align: "center", wordSpacing: WORD_SPACING, height: 14, ellipsis: true }
  );

  const valueText = formatKpiValue(card);
  doc.font("Bold").fontSize(card.key === "complianceRate" ? 20 : 24).fillColor(COLORS.primary).text(
    preparePdfText(valueText), x + 4, circY + circR + 24,
    { width: cardW - 8, align: "center", wordSpacing: WORD_SPACING, height: 28, ellipsis: true }
  );

  const specialSub = kpiSpecialSubText(card);
  if (specialSub) {
    doc.font("Body").fontSize(9).fillColor(COLORS.neutral).text(
      preparePdfText(specialSub), x + 4, y + cardH - 26,
      { width: cardW - 8, align: "center", lineBreak: false, ellipsis: true, wordSpacing: WORD_SPACING }
    );
  } else if (card.difference !== null) {
    const dir = directionFromAssessment(card.assessment);
    const deltaY = y + cardH - 26;
    drawDirectionArrow(doc, dir, x + 4, deltaY - 2, 12);
    doc.font("Body").fontSize(9).fillColor(directionColor(dir)).text(
      preparePdfText(formatKpiDelta(card)), x + 18, deltaY,
      { width: cardW - 22, align: "right", lineBreak: false, ellipsis: true, wordSpacing: WORD_SPACING }
    );
    if (card.previousValue !== null) {
      doc.font("Body").fontSize(8.5).fillColor(COLORS.neutral).text(
        preparePdfText(`السابق ${formatReportNumber(card.previousValue ?? 0)}`),
        x + 4, deltaY + 14,
        { width: cardW - 8, align: "center", lineBreak: false, ellipsis: true, wordSpacing: WORD_SPACING }
      );
    }
  }
  resetInk(doc);
}

async function renderPage2(ctx: V2Context): Promise<void> {
  const { doc, data, brief, layout, warnings } = ctx;
  const { margin, contentWidth } = layout;

  let y = drawPageHeader(ctx, "ملخص المؤشرات والاتجاه الزمني");

  // Sub-heading: brief comparison description (without date range)
  const subHeader = data.previousPeriod
    ? data.comparisonMode === "SAME_PERIOD_LAST_YEAR"
      ? "الفترة الحالية مقارنة بالفترة المماثلة من السنة السابقة"
      : "الفترة الحالية مقارنة بالفترة السابقة المماثلة"
    : "لا توجد فترة مقارنة";
  doc.font("Bold").fontSize(12).fillColor(COLORS.primary).text(
    preparePdfText(subHeader), margin, y,
    { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  y += 28;

  // 8 KPI cards in 4×2 grid — replace the netChange card with allTimeTotal for V2
  const cols = 4;
  const gap = 10;
  const cardW = (contentWidth - gap * (cols - 1)) / cols;
  const cardH = 122;
  const cards = brief.briefKpis.slice(0, 8).map((card) => {
    if (card.key === "netChange") {
      return {
        ...card,
        key: "allTimeTotal",
        label: "إجمالي الشكاوى في النظام",
        value: brief.allTimeTotal,
        difference: null,
        changeRate: null,
        previousValue: null,
      };
    }
    return card;
  });
  cards.forEach((card, idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const slot = cols - 1 - col;
    drawIconKpiCard(doc, card, margin + slot * (cardW + gap), y + row * (cardH + gap), cardW, cardH);
  });
  const rows = Math.max(1, Math.ceil(cards.length / cols));
  y += rows * cardH + (rows - 1) * gap + gap;

  // Monthly chart section
  y = drawSectionTitle(doc, "الاتجاه الزمني للشكاوى", margin, y, contentWidth);

  const flow = brief.monthlyStockFlow;
  const hasFlow = flow.some((p) => p.inflow > 0 || p.closed > 0);

  const notesH = 120;
  const chartHeight = Math.min(
    380,
    Math.max(280, Math.floor(layout.pageSize[1] - layout.margin - 26 - notesH - y))
  );

  if (hasFlow) {
    try {
      const monthlyChartSeries = [
        { name: "واردة خلال الفترة", points: flow.map((p) => ({ x: p.monthLabel, y: p.inflow })) },
        { name: "مغلقة خلال الفترة", points: flow.map((p) => ({ x: p.monthLabel, y: p.closed })) },
        { name: "مفتوحة نهاية الفترة", points: flow.map((p) => ({ x: p.monthLabel, y: p.openAtEnd })), axis: "right" as const },
        { name: "متأخرة نهاية الفترة", points: flow.map((p) => ({ x: p.monthLabel, y: p.lateAtEnd })), axis: "right" as const },
      ];
      const png = await renderLineChartPng({
        id: "v2-monthly-flow",
        kind: "chart",
        chartType: "bar",
        title: "",
        series: monthlyChartSeries,
        emptyState: "لا توجد بيانات للاتجاه الزمني.",
      }, Math.round(contentWidth), chartHeight);
      doc.image(png, margin, y, { width: contentWidth, height: chartHeight });
    } catch (err) {
      warnings.push(`تعذر رسم مخطط الاتجاه الزمني: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  y += chartHeight + 8;

  // Info methodology box
  const infoText = "تعتمد شكاوى الفترة على تاريخ إنشاء الشكوى، بينما تمثل المفتوحة والمتأخرة نهاية الفترة مؤشرات الرصيد القائم حتى نهاية الفترة ولو أنشئت الشكوى قبل بداية الفترة.";
  y = drawInfoBox(doc, infoText, margin, y, contentWidth) + 8;

  // Notes
  const noteLines = (brief.notes ?? []).slice(0, 5);
  const notesBoxH = Math.max(notesH, 28 + noteLines.length * 22);
  drawBulletBox(doc, "ملاحظات", "clipboard", noteLines, margin, y, contentWidth, notesBoxH);
}

// ── Page 3: Regions ───────────────────────────────────────────────────────────

function stripPrefix(name: string): string {
  return name.replace(/^منطقة\s+/, "").replace(/^المنطقة\s+/, "");
}

function visibleRegions(brief: ExecutiveBriefV2Data): readonly RegionReferenceRow[] {
  return brief.allRegions.slice(0, MAX_REGION_ROWS);
}

type RegionComparisonTableRow = RegionReferenceRow & {
  topSubject: string;
  subjectChange: string;
};

function formatRegionalSubjectChange(input: {
  currentCount: number;
  previousCount: number;
  difference: number;
  changeRate: number | null;
} | undefined): string {
  if (!input) return "دون تغير ملحوظ";
  const difference = formatReportNumber(input.difference, { sign: true });
  if (input.previousCount === 0 && input.currentCount > 0) {
    return `${difference} (جديد)`;
  }
  if (input.changeRate === null) return difference;
  return `${difference} (${formatReportNumber(input.changeRate, { sign: true, percent: true })})`;
}

async function renderPage3(ctx: V2Context): Promise<void> {
  const { doc, data, brief, layout, warnings } = ctx;
  const { margin, contentWidth } = layout;
  const regions = visibleRegions(brief);
  const hasPrev = regions.some((r) => r.previousCount > 0);

  let y = drawPageHeader(ctx, "المناطق");

  // ── Region comparison chart ──────────────────────────────────────────────
  y = drawSectionTitle(doc, "مقارنة المناطق", margin, y, contentWidth);
  const currentPts = regions.map((r) => ({ x: stripPrefix(r.regionName), y: r.currentCount }));
  const series = [{ name: "شكاوى الفترة الحالية", points: currentPts }];
  if (hasPrev) {
    series.push({ name: "الفترة السابقة", points: regions.map((r) => ({ x: stripPrefix(r.regionName), y: r.previousCount })) });
  }
  const chartH = 280;
  try {
    const png = await renderLineChartPng({
      id: "v2-region-bar",
      kind: "chart",
      chartType: "bar",
      title: hasPrev ? "مقارنة شكاوى الفترة الحالية مقابل الفترة السابقة حسب المنطقة" : "إجمالي الفترة الحالية حسب المنطقة",
      series,
      emptyState: "لا توجد بيانات مناطق.",
    }, Math.round(contentWidth), chartH);
    doc.image(png, margin, y, { width: contentWidth, height: chartH });
  } catch (err) {
    warnings.push(`تعذر رسم مقارنة المناطق: ${err instanceof Error ? err.message : String(err)}`);
  }
  y += chartH + 14;

  // ── Region cards (4 per row) ──────────────────────────────────────────────
  y = drawSectionTitle(doc, "بطاقات المناطق", margin, y, contentWidth);
  const cols = 4;
  const cardGap = 10;
  const cardW = (contentWidth - cardGap * (cols - 1)) / cols;
  const hdrH = 28;
  const cardH = 100;
  const r = REPORT_DESIGN_TOKENS.card.radius;

  regions.forEach((region, idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const x = margin + (cols - 1 - col) * (cardW + cardGap);
    const cy = y + row * (cardH + cardGap);

    doc.roundedRect(x, cy, cardW, cardH, r).fillAndStroke(COLORS.background, COLORS.border);
    // Dark green header
    doc.moveTo(x + r, cy).lineTo(x + cardW - r, cy)
      .quadraticCurveTo(x + cardW, cy, x + cardW, cy + r)
      .lineTo(x + cardW, cy + hdrH).lineTo(x, cy + hdrH).lineTo(x, cy + r)
      .quadraticCurveTo(x, cy, x + r, cy).closePath().fill(COLORS.primary);
    doc.font("Bold").fontSize(11).fillColor(COLORS.white).text(
      preparePdfText(stripPrefix(region.regionName)), x + 6, cy + (hdrH - 12) / 2,
      { width: cardW - 12, align: "right", ellipsis: true, wordSpacing: WORD_SPACING, lineBreak: false }
    );

    const metricW = cardW / 3;
    const bodyY = cy + hdrH + 4;
    const metrics = [
      { label: "متأخرة", value: region.currentlyLate },
      { label: "مفتوحة", value: region.openCount ?? 0 },
      { label: "شكاوى الفترة", value: region.currentCount },
    ];
    metrics.forEach((m, mi) => {
      const mx = x + mi * metricW;
      if (mi < 2) {
        doc.moveTo(mx + metricW, bodyY + 4).lineTo(mx + metricW, cy + cardH - 6)
          .strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.lineWidth(1);
      }
      doc.font("Body").fontSize(10).fillColor(COLORS.neutral).text(
        preparePdfText(m.label), mx + 2, bodyY + 8,
        { width: metricW - 4, align: "center", wordSpacing: WORD_SPACING }
      );
      doc.font("Bold").fontSize(16).fillColor(COLORS.primary).text(
        formatReportNumber(m.value), mx + 2, bodyY + 24,
        { width: metricW - 4, align: "center", wordSpacing: WORD_SPACING }
      );
    });
  });
  resetInk(doc);
  y += Math.ceil(regions.length / cols) * (cardH + cardGap) + 14;

  // ── Regional delta and leading-subject table ───────────────────────────────
  y = drawSectionTitle(doc, "التغير وأبرز موضوع حسب المنطقة", margin, y, contentWidth);

  const hasComparisonPeriod = Boolean(data.previousPeriod);
  const subjectChanges = new Map(
    (data.comparisonData?.regionSubjectChanges ?? []).map((row) => [row.regionName, row])
  );
  const regionRows: RegionComparisonTableRow[] = regions.map((region) => {
    const subjectChange = subjectChanges.get(region.regionName);
    return {
      ...region,
      topSubject: hasComparisonPeriod
        ? subjectChange?.subject ?? "دون تغير ملحوظ"
        : "لا توجد فترة مقارنة",
      subjectChange: hasComparisonPeriod
        ? formatRegionalSubjectChange(subjectChange)
        : "—",
    };
  });

  const regionCols: ColDef[] = [
    { key: "regionName", label: "المنطقة", weight: 1.7 },
    { key: "currentCount", label: "الحالية", weight: 0.72 },
    { key: "previousCount", label: "السابقة", weight: 0.72 },
    { key: "difference", label: "الفرق", weight: 0.72 },
    { key: "changeRate", label: "نسبة التغير", weight: 0.82 },
    { key: "topSubject", label: "أبرز موضوع متغير", weight: 2.25 },
    { key: "subjectChange", label: "تغير الموضوع", weight: 1.12 },
  ];

  const rowH = regions.length > 8 ? 27 : 31;
  y = drawTable(
    doc, regionRows, regionCols, margin, y, contentWidth, rowH,
    (row: RegionComparisonTableRow, key) => {
      if (key === "difference") {
        return hasComparisonPeriod
          ? formatReportNumber(row.difference, { sign: true })
          : "—";
      }
      if (key === "changeRate") {
        if (!hasComparisonPeriod) return "—";
        if (row.previousCount === 0 && row.currentCount > 0) return "جديد";
        if (row.previousCount === 0 && row.currentCount === 0) return formatReportNumber(0, { percent: true });
        return formatNullableReportNumber(row.changeRate, { percent: true });
      }
      const value = (row as Record<string, unknown>)[key];
      return value === null || value === undefined
        ? "—"
        : typeof value === "number"
          ? formatReportNumber(value)
          : String(value);
    }
  );
  y += 14;

  drawInfoBox(
    doc,
    "يعرض الجدول الفرق العددي ونسبة التغير بين الفترتين، مع الموضوع صاحب أكبر تغير مطلق داخل كل منطقة. عندما تكون قيمة الفترة السابقة صفراً تظهر الحالة «جديد» بدلاً من نسبة غير معرفة.",
    margin,
    y,
    contentWidth
  );
}

// ── Page 4: Classifications + Departments + Conclusions ───────────────────────

function renderPage4(ctx: V2Context): void {
  const { doc, data, brief, layout } = ctx;
  const { margin, contentWidth } = layout;
  const hasPrevPeriod = Boolean(data.previousPeriod);
  const classRows = brief.topClassifications.slice(0, 8);
  const deptRows = (brief.topDepartments ?? []).slice(0, 8);
  const hasClassComparison = classRows.some((r) => r.previousCount > 0);
  // Departments table has no previous columns today; keep rise list gated on real previous period.

  let y = drawPageHeader(ctx, "التصنيفات والإدارات والاستنتاجات");
  const gap = 14;
  const rowH = 26;

  // ── Notable rises (text box) ──────────────────────────────────────────────
  y = drawSectionTitle(doc, "الارتفاعات الملحوظة", margin, y, contentWidth);
  const rises = hasPrevPeriod ? (data.comparisonData?.deptClassRises ?? []).slice(0, 6) : [];
  const riseTexts = rises.length > 0
    ? rises.map((r) => `${r.departmentName} / ${r.classificationName}: ${formatReportNumber(r.difference, { sign: true })} شكوى`)
    : ["لا توجد ارتفاعات إدارية حادة في هذه الفترة."];
  const riseBoxH = Math.max(60, 18 + riseTexts.length * 22);
  doc.roundedRect(margin, y, contentWidth, riseBoxH, REPORT_DESIGN_TOKENS.card.radius)
    .fillAndStroke(COLORS.background, COLORS.border);
  doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.body).fillColor(COLORS.text);
  riseTexts.forEach((txt, idx) => {
    doc.text(preparePdfText(`• ${txt}`), margin + 10, y + 9 + idx * 22, {
      width: contentWidth - 20, height: 22, align: "right",
      wordSpacing: WORD_SPACING, lineBreak: false, ellipsis: true,
    });
  });
  resetInk(doc);
  y += riseBoxH + gap;

  // ── Classifications table ─────────────────────────────────────────────────
  y = drawSectionTitle(doc, "أعلى التصنيفات", margin, y, contentWidth);
  const classCols: ColDef[] = hasClassComparison
    ? [
        { key: "classificationName", label: "التصنيف", weight: 2.4 },
        { key: "currentCount", label: "شكاوى الفترة", weight: 0.9 },
        { key: "previousCount", label: "السابق", weight: 0.85 },
        { key: "difference", label: "الفرق", weight: 0.8 },
        { key: "openAtEnd", label: "مفتوحة نهاية الفترة", weight: 0.95 },
        { key: "lateAtEnd", label: "متأخرة نهاية الفترة", weight: 0.95 },
      ]
    : [
        { key: "classificationName", label: "التصنيف", weight: 2.6 },
        { key: "currentCount", label: "شكاوى الفترة", weight: 1 },
        { key: "openAtEnd", label: "مفتوحة نهاية الفترة", weight: 1 },
        { key: "lateAtEnd", label: "متأخرة نهاية الفترة", weight: 1 },
      ];

  // Enrich classification rows with open/late from V2 data
  const enrichedClass = classRows.map((row) => {
    const ol = brief.classificationOpenLate[row.classificationId] ?? { openAtEnd: 0, lateAtEnd: 0 };
    return { ...row, openAtEnd: ol.openAtEnd, lateAtEnd: ol.lateAtEnd };
  });

  y = drawTable(
    doc, enrichedClass, classCols, margin, y, contentWidth, rowH,
    (row, key) => {
      if (key === "difference") return formatReportNumber(row.difference, { sign: true });
      if (key === "changeRate") return formatNullableReportNumber(row.changeRate, { percent: true });
      const v = (row as Record<string, unknown>)[key];
      return v === null || v === undefined ? "—" : typeof v === "number" ? formatReportNumber(v) : String(v);
    }
  );
  y += gap;

  // ── Departments table ──────────────────────────────────────────────────────
  y = drawSectionTitle(doc, "أعلى الإدارات", margin, y, contentWidth);
  const deptCols: ColDef[] = [
    { key: "name", label: "الإدارة", weight: 2.2 },
    { key: "total", label: "شكاوى الفترة", weight: 0.9 },
    { key: "closed", label: "مغلقة خلال الفترة", weight: 0.9 },
    { key: "open", label: "مفتوحة نهاية الفترة", weight: 0.95 },
    { key: "currentlyLate", label: "متأخرة نهاية الفترة", weight: 0.95 },
  ];
  y = drawTable(
    doc, deptRows, deptCols, margin, y, contentWidth, rowH,
    (row: ExecutiveEntityRow, key) => {
      const v = (row as Record<string, unknown>)[key];
      return v === null || v === undefined ? "—" : typeof v === "number" ? formatReportNumber(v) : String(v);
    }
  );
  y += gap;

  // ── Conclusions (full-width) ──────────────────────────────────────────────
  const lineH = 22;
  const boxHdrH = 30;
  const conclusions = (brief.conclusions ?? []).slice(0, 5);
  const notes = (brief.notes ?? []).slice(0, 5);
  const availableH = layout.pageSize[1] - layout.margin * 2 - 26 - y;
  const eachBoxH = Math.max(boxHdrH + lineH + 12, Math.min(
    boxHdrH + 12 + Math.max(conclusions.length, 1) * lineH,
    Math.floor(availableH * 0.48)
  ));

  drawBulletBox(doc, "الاستنتاجات", "report", conclusions, margin, y, contentWidth, eachBoxH);
  y += eachBoxH + gap;

  const notesBoxH = Math.max(boxHdrH + lineH + 12, Math.min(
    boxHdrH + 12 + Math.max(notes.length, 1) * lineH,
    layout.pageSize[1] - layout.margin * 2 - 26 - y
  ));
  drawBulletBox(doc, "ملاحظات جودة البيانات وتأثيرها على المؤشرات", "database", notes, margin, y, contentWidth, notesBoxH);
}

// ── Footers ───────────────────────────────────────────────────────────────────

function drawFooters(doc: PDFKit.PDFDocument, layout: V2Layout, warnings: string[]): void {
  const range = doc.bufferedPageRange();
  if (range.count !== PAGE_COUNT) {
    warnings.push(
      `عدد صفحات التقرير ${formatReportNumber(range.count)} بدلًا من ${formatReportNumber(PAGE_COUNT)} المتوقع.`
    );
  }
  for (let pi = range.start; pi < range.start + range.count; pi++) {
    doc.switchToPage(pi);
    const pageNum = pi - range.start + 1;
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.footer).fillColor(COLORS.neutral);
    doc.text(
      preparePdfText(`صفحة ${formatReportNumber(pageNum)} من ${formatReportNumber(range.count)}`),
      layout.margin, layout.pageSize[1] - layout.margin - 12,
      { width: layout.contentWidth, align: "center", lineBreak: false }
    );
    doc.page.margins.bottom = origBottom;
  }
  resetInk(doc);
}

// ── Main entry point ─────────────────────────────────────────────────────────

const EMPTY_V2: ExecutiveBriefV2Data = {
  briefKpis: [],
  allRegions: [],
  topClassifications: [],
  comparativeTimeline: { current: { label: "الفترة الحالية", points: [] }, previous: null, periodDays: 0 },
  concentrationBands: [],
  topDepartments: [],
  conclusions: [],
  notes: [],
  allTimeTotal: 0,
  monthlyStockFlow: [],
  classificationOpenLate: {},
};

export async function renderExecutiveBriefV2Pdf(data: ReportData): Promise<ExecutiveBriefV2PdfResult> {
  const warnings = [...data.warnings];
  const { regular, bold } = loadFonts();

  const rawBrief = data.briefData;
  const brief: ExecutiveBriefV2Data = rawBrief && isExecutiveBriefV2Data(rawBrief)
    ? rawBrief
    : { ...EMPTY_V2, ...(rawBrief ?? {}) };

  const layout = createV2Layout(brief.allRegions.length);
  const [PW, PH] = layout.pageSize;

  const doc = new PDFDocument({
    size: [PW, PH],
    margins: { top: layout.margin, bottom: layout.margin + 24, left: layout.margin, right: layout.margin },
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: data.title, Author: "تقارير الشكاوى", Subject: "تقرير الشكاوى" },
  });

  doc.registerFont("Body", regular);
  doc.registerFont("Bold", bold);
  doc.font("Body");

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  let settled = false;
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.once("error", (err) => {
      settled = true;
      reject(err);
    });
    doc.once("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
  });

  const ctx: V2Context = { doc, data, brief, warnings, layout };
  let ended = false;
  const endDoc = () => {
    if (ended) return;
    ended = true;
    doc.end();
  };

  try {
    if (brief.allRegions.length > MAX_REGION_ROWS) {
      warnings.push(`تم عرض أول ${MAX_REGION_ROWS} منطقة فقط.`);
    }

    // Page 1
    renderCoverPage(ctx);
    // Page 2
    doc.addPage();
    await renderPage2(ctx);
    // Page 3
    doc.addPage();
    await renderPage3(ctx);
    // Page 4
    doc.addPage();
    renderPage4(ctx);

    drawFooters(doc, layout, warnings);
  } finally {
    endDoc();
  }

  return { buffer: await done, warnings };
}
