/**
 * PRINT_EXECUTIVE_BRIEF_V2 — standalone 4-page PDF renderer.
 *
 * Page width (PRINT_EXECUTIVE_PAGE_SIZE[0]) and margins are shared, but each
 * page gets its OWN height via PDFKit per-page `addPage({ size })` — pages 1
 * and 2 always use BASE_PAGE_HEIGHT; page 3 may grow with region count
 * (computeV2Page3Height); page 4 is sized from its own actual content
 * (planPage4Layout). No page's extra content ever inflates another page.
 *
 *   1. Cover   — large title + 3 summary cards + all-time total
 *   2. Trend   — registered/closed totals + monthly combo chart + key notes
 *   3. Regions — comparison chart + volume cards + delta/topic table
 *   4. Classifications/Facilities — classification-shift table + classification table + facility tables + conclusions
 */

import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  formatNullableReportNumber,
  formatReportNumber,
  PRINT_EXECUTIVE_PAGE_SIZE,
  REPORT_DESIGN_TOKENS,
} from "@/lib/reports/design-tokens";
import type {
  RegionReferenceRow,
  ClassificationBriefRow,
  ExecutiveBriefKpiCard,
  PeriodSnapshotMetrics,
  ClassificationTrendRow,
  FacilityFollowUpRow,
  BestPracticeCandidateRow,
  ExecutiveConclusionRow,
} from "@/lib/reports/report-contract";
import { OPERATIONAL_PRACTICE_CARD_COUNT, type OperationalPracticeRow } from "@/lib/reports/operational-practices";
import type { ExecutiveBriefV2Data, ReportData } from "./report-data-service";
import { isExecutiveBriefV2Data } from "./report-data-service";
import { renderLineChartPng, MIN_CHART_HEIGHT } from "./report-chart-service";
import { preparePdfText, preparePdfTextLayout } from "./arabic-pdf-text";
import { getComparisonModeDescription } from "@/lib/reports/comparison-mode-labels";
import {
  isValidMonthKey,
  monthKeyFromReportEndDate,
  sanitizeMonthlyTrendForReport,
} from "./report-monthly-trend-sanitize";
import {
  buildMonthlyTrendInsights,
  calculateMonthlyTrendTotals,
  resolveReportMonthStatus,
} from "./report-monthly-trend-presentation";

export {
  sanitizeMonthlyTrendForReport,
  monthKeyFromReportEndDate,
  assertTrendEndsAtOrBeforeReportEnd,
} from "./report-monthly-trend-sanitize";

// ── Constants ─────────────────────────────────────────────────────────────────

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const COLORS = REPORT_DESIGN_TOKENS.colors;
const WORD_SPACING = REPORT_DESIGN_TOKENS.typography.wordSpacing;
const PAGE_COUNT = 4;
const MAX_REGION_ROWS = 13;
/** Spec §14: top classifications table shrinks to 5 rows to make room for higher-priority page-4 content. */
const TOP_CLASSIFICATIONS_V2_LIMIT = 5;

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
//
// Each of the 4 pages gets its OWN height via PDFKit's per-page `addPage({
// size })` — only page WIDTH and margins are shared (V2Layout below). A page
// whose content needs more room (page 3's region cards/table, page 4's
// facility tables/practices grid/conclusions) grows ONLY that page; it never
// inflates the other 3, which is what previously made every page ~2020pt
// tall (900×1200 base) whenever region or practice counts were large —
// visually shrinking all text once a PDF viewer's "fit page" scaled to that
// exaggerated height. See computeV2Page3Height / planPage4Layout below.

type V2Layout = {
  pageWidth: number;
  margin: number;
  contentWidth: number;
};

const BASE_PAGE_WIDTH = PRINT_EXECUTIVE_PAGE_SIZE[0];
/** The shared base page height — pages 1 and 2's fixed height, and the floor every other page's content-driven height is clamped to. */
const BASE_PAGE_HEIGHT = PRINT_EXECUTIVE_PAGE_SIZE[1];

function createV2Layout(): V2Layout {
  const margin = 42;
  return { pageWidth: BASE_PAGE_WIDTH, margin, contentWidth: BASE_PAGE_WIDTH - margin * 2 };
}

/** PDFKit's addPage(options) does NOT inherit the document's own margins when `size` is passed explicitly — every per-page addPage call must repeat them. */
function v2PageMargins(margin: number): { top: number; bottom: number; left: number; right: number } {
  return { top: margin, bottom: margin + 24, left: margin, right: margin };
}

/**
 * Page 3 (regions) legitimately grows with region count — its own cards +
 * table need real extra room. Never applied to any other page (spec: a
 * 13-region report must not shrink text on the cover, trend, or
 * classifications/conclusions pages).
 */
export function computeV2Page3Height(regionCount: number): number {
  const safeCount = Math.min(regionCount, MAX_REGION_ROWS);
  const cardRows = Math.ceil(safeCount / 4);
  return Math.max(BASE_PAGE_HEIGHT, 880 + cardRows * 118 + safeCount * 28);
}

const FOOTER_RESERVE = 26;

/** Remaining vertical space for the monthly chart after notes + footer reserve. */
export function resolveV2MonthlyChartAvailableHeight(input: {
  pageHeight: number;
  margin: number;
  chartY: number;
  footerReserve?: number;
  notesHeight: number;
  notesGap: number;
}): number {
  const footerReserve = input.footerReserve ?? FOOTER_RESERVE;
  const pageContentBottom = input.pageHeight - input.margin - footerReserve;
  return Math.max(
    0,
    Math.floor(pageContentBottom - input.notesHeight - input.notesGap - input.chartY)
  );
}

/** Cap chart height without forcing a floor that can overflow the page. */
export function resolveV2MonthlyChartHeight(availableForChart: number): number {
  return Math.min(520, Math.max(0, availableForChart));
}

/** Decide whether remaining space can host a real chart (must be ≥ renderer minimum). */
export function resolveV2MonthlyChartRenderPlan(availableForChart: number): {
  chartHeight: number;
  canRenderChart: boolean;
} {
  const chartHeight = resolveV2MonthlyChartHeight(availableForChart);
  return {
    chartHeight,
    canRenderChart: chartHeight >= MIN_CHART_HEIGHT,
  };
}

const FACILITY_ROW_HEIGHT = 26;
const FACILITY_TABLE_HEADER_H = FACILITY_ROW_HEIGHT + 2;
const FACILITY_SECTION_TITLE_H = 13 + 8; // matches drawSectionTitle's y advance
const FACILITY_MAX_ROWS = 5;
/**
 * Facility rows never shrink below this floor while real data exists for
 * that table (capped to whatever rows are actually available, per side) —
 * a regression previously let the row-reduction loop go all the way to 0,
 * rendering an empty "header only" table on top of real, non-empty source
 * data. Once this floor still doesn't fit BASE_PAGE_HEIGHT, page 4 grows
 * past it instead (see planPage4Layout); rows never drop further to buy
 * back page height.
 */
const FACILITY_MIN_ROWS = 3;

// These mirror drawBulletBox's own internal layout constants exactly (hdrH,
// lineH, the horizontal/top text padding, and the "height - hdrH - 16"
// reserved-padding term in its maxLines formula). Keeping a single source of
// truth here is what prevents the box-sizing math and drawBulletBox's own
// rendering math from drifting apart again (previously 12 vs. 16, which
// silently truncated a line).
const BULLET_BOX_HEADER_H = 30;
const BULLET_BOX_LINE_H = 22;
const BULLET_BOX_BODY_PADDING = 16;
const BULLET_BOX_PAD_X = 10;
const BULLET_BOX_PAD_TOP = 8;

/**
 * Exact box height drawBulletBox needs to display `lineCount` VISUAL
 * (already-wrapped) lines without truncating the last one — the inverse of
 * drawBulletBox's own `maxLines = floor((height - hdrH - 16) / lineH)`
 * formula. `lineCount` is the sum of each point's own wrapped-line count
 * (see computeBulletBoxLineCount), never just `points.length` — a single
 * long point can take 2-3 visual lines. Shared by every drawBulletBox
 * caller — page 4's conclusions AND page 2's "ملاحظات رئيسية" notes — so
 * box sizing and drawBulletBox's own rendering math can never disagree.
 */
export function computeBulletBoxHeight(lineCount: number): number {
  const lines = Math.max(lineCount, 1);
  return BULLET_BOX_HEADER_H + BULLET_BOX_BODY_PADDING + lines * BULLET_BOX_LINE_H;
}

/**
 * Total VISUAL (wrapped) line count drawBulletBox will actually render for
 * `points` at this box `width` — the exact same measurement (same inner
 * width, same body font/size, same preparePdfTextLayout call) drawBulletBox
 * itself performs when drawing, so a box sized from this count can never be
 * shorter than what rendering actually needs. Callers must set no font
 * before calling — this sets Body/fontSize.body itself, matching drawBulletBox.
 */
export function computeBulletBoxLineCount(
  doc: PDFKit.PDFDocument,
  points: readonly string[],
  width: number
): number {
  if (points.length === 0) return 0;
  const innerWidth = width - BULLET_BOX_PAD_X * 2;
  doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.body);
  let total = 0;
  for (const pt of points) {
    total += preparePdfTextLayout(doc, `• ${pt}`, { width: innerWidth, align: "right", wordSpacing: WORD_SPACING, splitOversizedTokens: true }).lines.length;
  }
  return total;
}

/**
 * Picks how many rows the top/bottom facility tables get — desired 5 down to
 * a floor of {@link FACILITY_MIN_ROWS} (never fewer while that table's own
 * source data has rows to show) — so the conclusions box below still keeps
 * room for every actual conclusion whenever possible. Facility rows are
 * reduced first, but ONLY down to the floor; a table with real data can
 * never render as headers-only. When even the floor doesn't fit
 * `pageHeight`, the floor is still what's returned — planPage4Layout grows
 * page 4's actual height past `pageHeight` to fit it, rather than dropping
 * rows further. Never requests more rows than are actually available on
 * either side (so a table with fewer than the floor's worth of source rows
 * simply shows all of them, never padded).
 */
export function resolveV2FacilityRowCounts(input: {
  pageHeight: number;
  margin: number;
  /** y position right after the classifications table (before the facility section titles). */
  y: number;
  gap: number;
  topAvailableRows: number;
  bottomAvailableRows: number;
  /** Height drawBulletBox needs to show every actual conclusion — see {@link computeBulletBoxHeight}. */
  requiredConclusionsHeight: number;
  /** Height of any other fixed section drawn between the facility tables and conclusions (e.g. the operational-practices grid) — reserved before facility rows, just like requiredConclusionsHeight. */
  additionalReservedHeight?: number;
}): { topRows: number; bottomRows: number } {
  const fixedChrome = FACILITY_SECTION_TITLE_H * 2 + input.gap * 2;
  const budget = input.pageHeight - input.margin - 26 - input.y - fixedChrome - (input.additionalReservedHeight ?? 0);

  for (let rows = FACILITY_MAX_ROWS; rows >= FACILITY_MIN_ROWS; rows--) {
    const topRows = Math.min(rows, input.topAvailableRows);
    const bottomRows = Math.min(rows, input.bottomAvailableRows);
    const facilitiesHeight =
      FACILITY_TABLE_HEADER_H + topRows * FACILITY_ROW_HEIGHT
      + FACILITY_TABLE_HEADER_H + bottomRows * FACILITY_ROW_HEIGHT;
    if (facilitiesHeight + input.requiredConclusionsHeight <= budget) {
      return { topRows, bottomRows };
    }
  }
  // Not even FACILITY_MIN_ROWS on each side leaves room for every conclusion
  // within `pageHeight` — facility rows still never drop below the floor to
  // buy back space; planPage4Layout grows the actual page height instead to
  // fit this floor's real content bottom.
  return {
    topRows: Math.min(FACILITY_MIN_ROWS, input.topAvailableRows),
    bottomRows: Math.min(FACILITY_MIN_ROWS, input.bottomAvailableRows),
  };
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

// ── KPI formatting ─────────────────────────────────────────────────────────────

const REPORT_UNAVAILABLE = "غير متاح";

function formatKpiValue(card: ExecutiveBriefKpiCard): string {
  if (card.value === null) return REPORT_UNAVAILABLE;
  if (card.format === "percent") return formatReportNumber(card.value, { percent: true, maximumFractionDigits: 1 });
  if (card.format === "days") return `${formatReportNumber(card.value)} يوم`;
  return formatReportNumber(card.value, { maximumFractionDigits: 0 });
}

/**
 * Cover-card comparison sub-text for a period-snapshot metric.
 * previous === null → no comparison period at all (blank sub-text).
 * previous === 0 && current > 0 → "جديد" (never 0% or Infinity — there is no
 * meaningful percentage change from zero).
 */
function formatPeriodMetricSub(current: number, previous: number | null): string {
  if (previous === null) return "";
  if (previous === 0) {
    return current > 0 ? `جديد | السابق 0` : `السابق 0`;
  }
  const difference = current - previous;
  const changeRate = Math.round(((current - previous) / previous) * 1000) / 10;
  return `(${formatReportNumber(changeRate, { sign: true, percent: true })}) ${formatReportNumber(difference, { sign: true })} | السابق ${formatReportNumber(previous)}`;
}

/** Measure prepared Arabic (or mixed) text width for the active font/size. */
export function measurePreparedArabicText(
  doc: PDFKit.PDFDocument,
  text: string,
  fontSize: number,
  fontName: "Body" | "Bold" = "Body"
): number {
  doc.font(fontName).fontSize(fontSize);
  return doc.widthOfString(preparePdfText(text), { wordSpacing: WORD_SPACING });
}

/**
 * Reduce font size until the (single-line) text fits within maxWidth,
 * stopping at minFontSize. Returns the chosen size.
 */
export function fitTextToBox(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  maxFontSize: number,
  minFontSize: number,
  fontName: "Body" | "Bold" = "Bold"
): number {
  let size = maxFontSize;
  while (size > minFontSize) {
    if (measurePreparedArabicText(doc, text, size, fontName) <= maxWidth) {
      return size;
    }
    size -= 0.5;
  }
  return minFontSize;
}

/** Draw a KPI primary value centered in a fixed box with auto-fit size. */
export function drawKpiValue(
  doc: PDFKit.PDFDocument,
  valueText: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: { maxFontSize?: number; minFontSize?: number; isUnavailable?: boolean } = {}
): { fontSize: number; usedHeight: number } {
  const isUnavailable = options.isUnavailable ?? valueText === REPORT_UNAVAILABLE;
  const maxFont = options.maxFontSize ?? (isUnavailable ? 14 : 22);
  const minFont = options.minFontSize ?? (isUnavailable ? 10 : 11);
  const pad = 6;
  const innerWidth = Math.max(8, width - pad * 2);
  const fontSize = fitTextToBox(doc, valueText, innerWidth, maxFont, minFont, "Bold");
  doc.font("Bold").fontSize(fontSize).fillColor(COLORS.primary);
  const textH = Math.min(height, fontSize + 4);
  // Pure numeric displays skip Arabic token reorder so thousand separators stay intact.
  const drawn = /[\u0600-\u06FF]/.test(valueText) ? preparePdfText(valueText) : valueText;
  doc.text(drawn, x + pad, y + Math.max(0, (height - textH) / 2), {
    width: innerWidth,
    height: textH,
    align: "center",
    wordSpacing: WORD_SPACING,
    lineBreak: false,
    ellipsis: true,
  });
  return { fontSize, usedHeight: textH };
}

/** Draw secondary/comparison meta under a KPI value without colliding with it. */
export function drawKpiMeta(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  options: { fontSize?: number; color?: string; height?: number } = {}
): number {
  const fontSize = options.fontSize ?? 8.5;
  const height = options.height ?? 12;
  doc.font("Body").fontSize(fontSize).fillColor(options.color ?? COLORS.neutral);
  doc.text(preparePdfText(text), x + 4, y, {
    width: width - 8,
    height,
    align: "center",
    wordSpacing: WORD_SPACING,
    lineBreak: false,
    ellipsis: true,
  });
  return y + height;
}

// ── Page banner (pages 2-4) ───────────────────────────────────────────────────

/**
 * The banner/title/separator "chrome" shared by pages 2-4 is sized from
 * BASE_PAGE_HEIGHT, never from the CURRENT page's own (possibly taller,
 * content-driven) height. Two reasons: (1) visual consistency — page 3's
 * banner shouldn't grow just because it has more regions, and (2) it breaks
 * a circular dependency for page 4, whose own height is computed FROM its
 * content, which starts right after this header — a header size that
 * depended on that same not-yet-known page height would have no fixed
 * point. `contentStartY` is therefore a constant across pages 2-4 for a
 * given title, used identically by planPage4Layout (before page 4 exists)
 * and drawPageHeader (drawing it for real).
 */
function computePageHeaderLayout(
  doc: PDFKit.PDFDocument,
  title: string,
  contentWidth: number
): { titleY: number; sepY: number; contentStartY: number } {
  const bannerH = Math.round(BASE_PAGE_HEIGHT * 0.18);
  const titleY = Math.round(bannerH * 0.82);
  doc.font("Bold").fontSize(42);
  const titleH = doc.heightOfString(preparePdfText(title), { width: contentWidth, align: "right", wordSpacing: WORD_SPACING });
  const sepY = titleY + titleH + 10;
  return { titleY, sepY, contentStartY: sepY + 20 };
}

function drawPageBanner(doc: PDFKit.PDFDocument, layout: V2Layout): void {
  const PW = doc.page.width;
  const PH = doc.page.height;
  doc.rect(0, 0, PW, PH).fill(COLORS.background);
  const bannerH = Math.round(BASE_PAGE_HEIGHT * 0.18);
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

  const PW = doc.page.width;
  const { margin, contentWidth } = layout;
  const { titleY, sepY, contentStartY } = computePageHeaderLayout(doc, title, contentWidth);

  doc.font("Bold").fontSize(42).fillColor(COLORS.primary).text(
    preparePdfText(title), margin, titleY,
    { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  drawGoldSeparator(doc, PW / 2, sepY, contentWidth * 0.35);
  resetInk(doc);
  return contentStartY;
}

// ── Shared table renderer ────────────────────────────────────────────────────

type ColDef = { key: string; label: string; weight: number };

/** Safe cell formatter: never emit [object Object] for unsupported types. */
export function formatTableValue(value: unknown): string {
  if (typeof value === "number") {
    return formatReportNumber(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "—";
}

type DrawTableOptions<Row extends object> = {
  doc: PDFKit.PDFDocument;
  rows: readonly Row[];
  columns: readonly ColDef[];
  x: number;
  y: number;
  width: number;
  rowHeight: number;
  formatCell: (row: Row, key: string) => string;
  maxRows?: number;
};

function drawTable<Row extends object>(options: DrawTableOptions<Row>): number {
  const {
    doc,
    rows,
    columns,
    x,
    y,
    width,
    rowHeight,
    formatCell,
    maxRows = rows.length,
  } = options;

  const totalWeight = columns.reduce((s, c) => s + c.weight, 0);
  const widths = columns.map((c) => width * c.weight / totalWeight);
  const offsets: number[] = [];
  let cur = x + width;
  widths.forEach((w) => { cur -= w; offsets.push(cur); });

  const hdrH = rowHeight + 2;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  doc.roundedRect(x, y, width, hdrH, r).fill(COLORS.primary);
  doc.font("Bold").fontSize(REPORT_DESIGN_TOKENS.fontSize.tableHeader).fillColor(COLORS.white);
  columns.forEach((col, i) => {
    doc.text(preparePdfText(col.label), offsets[i] + 4, y + 5, {
      width: widths[i] - 8, height: hdrH - 7, align: "right", ellipsis: true, wordSpacing: WORD_SPACING,
    });
  });

  let rowY = y + hdrH;
  rows.slice(0, maxRows).forEach((row, ri) => {
    if (ri % 2 === 1) doc.rect(x, rowY, width, rowHeight).fill(COLORS.tableRowAlternate);
    doc.moveTo(x, rowY + rowHeight).lineTo(x + width, rowY + rowHeight).strokeColor(COLORS.border).stroke();
    doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.table).fillColor(COLORS.primary);
    columns.forEach((col, i) => {
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
        width: widths[i] - 8, height: rowHeight - 6, align: "right", ellipsis: true, wordSpacing: WORD_SPACING,
      });
      if (isNegative) {
        doc.fillColor(COLORS.primary);
      }
    });
    rowY += rowHeight;
  });
  resetInk(doc);
  return rowY;
}

// ── Bullet box (conclusions / notes) ─────────────────────────────────────────

type DrawBulletBoxOptions = {
  doc: PDFKit.PDFDocument;
  title: string;
  icon: IconType;
  points: readonly string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

function drawBulletBox(options: DrawBulletBoxOptions): void {
  const { doc, title, icon, points, x, y, width, height } = options;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const hdrH = BULLET_BOX_HEADER_H;
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

  const lineH = BULLET_BOX_LINE_H;
  const bodyFontSize = REPORT_DESIGN_TOKENS.fontSize.body;
  const innerWidth = width - BULLET_BOX_PAD_X * 2;
  const textX = x + BULLET_BOX_PAD_X;
  const firstLineY = y + hdrH + BULLET_BOX_PAD_TOP;

  if (points.length === 0) {
    doc.font("Body").fontSize(bodyFontSize).fillColor(COLORS.neutral).text(
      preparePdfText("لا توجد بيانات."), textX, firstLineY,
      { width: innerWidth, align: "center" }
    );
    resetInk(doc);
    return;
  }

  // Defense-in-depth only: computeBulletBoxHeight (via
  // computeBulletBoxLineCount, the exact same wrapping this loop performs)
  // is expected to always reserve `height` large enough for every real
  // visual line, so this cap is never actually hit for conclusions in normal
  // operation — it only guards against an upstream sizing bug, and unlike
  // the old single-line-per-point version, it can never cut a point
  // mid-sentence: it only ever stops BETWEEN points.
  const maxLines = Math.max(1, Math.floor((height - hdrH - BULLET_BOX_BODY_PADDING) / lineH));
  doc.font("Body").fontSize(bodyFontSize).fillColor(COLORS.text);
  let lineIdx = 0;
  for (const pt of points) {
    if (lineIdx >= maxLines) break;
    const layout = preparePdfTextLayout(doc, `• ${pt}`, { width: innerWidth, align: "right", wordSpacing: WORD_SPACING, splitOversizedTokens: true });
    for (const line of layout.lines) {
      if (lineIdx >= maxLines) break;
      doc.text(line.visualText, textX, firstLineY + lineIdx * lineH, {
        width: innerWidth, align: "right", wordSpacing: WORD_SPACING, lineBreak: false,
      });
      lineIdx++;
    }
  }
  resetInk(doc);
}

// ── Info box (ℹ methodology note) ─────────────────────────────────────────────

const INFO_BOX_ICON_ZONE_WIDTH = 42;
const INFO_BOX_PAD_X = 6;
const INFO_BOX_PAD_Y = 10;
const INFO_BOX_MIN_HEIGHT = 46;

/**
 * The exact height drawInfoBox will render at for this text/width/fontSize —
 * extracted so a caller that needs to RESERVE room for an info box (e.g. the
 * operational-practices section's empty-state fallback) can never compute a
 * different number than what drawInfoBox itself actually draws.
 */
export function computeInfoBoxHeight(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  fontSize: number = REPORT_DESIGN_TOKENS.fontSize.body
): number {
  const textWidth = Math.max(40, width - INFO_BOX_ICON_ZONE_WIDTH - INFO_BOX_PAD_X);
  doc.font("Body").fontSize(fontSize);
  const textH = doc.heightOfString(preparePdfText(text), {
    width: textWidth,
    align: "right",
    wordSpacing: WORD_SPACING,
    lineGap: 1,
  });
  return Math.max(INFO_BOX_MIN_HEIGHT, textH + INFO_BOX_PAD_Y * 2);
}

export function drawInfoBox(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  options: { fontSize?: number } = {}
): number {
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const fontSize = options.fontSize ?? REPORT_DESIGN_TOKENS.fontSize.body;
  const preparedText = preparePdfText(text);
  const boxH = computeInfoBoxHeight(doc, text, width, fontSize);

  doc.roundedRect(x, y, width, boxH, r).fillAndStroke(COLORS.background, COLORS.border);
  drawIcon(doc, "info", x + 24, y + boxH / 2, 16);

  const textX = x + INFO_BOX_ICON_ZONE_WIDTH;
  const textY = y + INFO_BOX_PAD_Y;
  const textWidth = Math.max(40, width - INFO_BOX_ICON_ZONE_WIDTH - INFO_BOX_PAD_X);
  doc.font("Body").fontSize(fontSize).fillColor(COLORS.neutral).text(
    preparedText,
    textX,
    textY,
    {
      width: textWidth,
      align: "right",
      wordSpacing: WORD_SPACING,
      lineGap: 1,
      height: Math.max(fontSize + 2, boxH - INFO_BOX_PAD_Y * 2),
    }
  );
  resetInk(doc);
  return y + boxH;
}

// ── Page 1: Cover ─────────────────────────────────────────────────────────────

function renderCoverPage(ctx: V2Context): void {
  const { doc, data, brief, layout } = ctx;
  const PW = doc.page.width;
  const PH = doc.page.height;
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
  const comparisonY = periodY + 34;
  const comparisonOpts = { width: contentWidth, align: "center" as const, wordSpacing: WORD_SPACING };
  doc.font("Body").fontSize(13).fillColor(COLORS.neutral).text(
    preparePdfText(comparison), margin, comparisonY, comparisonOpts
  );
  const comparisonH = doc.heightOfString(preparePdfText(comparison), comparisonOpts);

  // 3 KPI cards on cover — sit just below the comparison line (no policy note gap).
  const cardY = comparisonY + comparisonH + 18;
  const cardGap = 18;
  const cardW = (contentWidth - cardGap * 2) / 3;
  const cardH = 180;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const circR = 30;

  // Cover cards focus on executive decision-making (spec §6): period volume,
  // continuing/escalating problems, and facilities needing follow-up —
  // closure/lateness moves to a small secondary line below the cards instead
  // of owning a full card, since actual lateness is typically limited.
  const coverCards: Array<{ key: string; icon: IconType; label: string; primary: string; sub: string }> = (() => {
    const metrics = brief.periodMetrics ?? { current: EMPTY_PERIOD_SNAPSHOT_METRICS, previous: null };
    const { current, previous } = metrics;

    const totalVal = formatReportNumber(current.receivedDuringPeriod, { maximumFractionDigits: 0 });
    const totalSub = formatPeriodMetricSub(current.receivedDuringPeriod, previous?.receivedDuringPeriod ?? null);

    const continuedVal = formatReportNumber(brief.continuedProblemFindingCount, { maximumFractionDigits: 0 });
    const highPriorityVal = formatReportNumber(brief.highPriorityFacilityCount, { maximumFractionDigits: 0 });

    return [
      { key: "total", icon: "clipboard" as IconType, label: "شكاوى الفترة", primary: totalVal, sub: totalSub },
      { key: "continuedProblems", icon: "clock-x" as IconType, label: "المشكلات المستمرة", primary: continuedVal, sub: "استمرار مرتفع أو تصاعد أو مشكلة مزمنة" },
      { key: "highPriorityFacilities", icon: "target" as IconType, label: "سجون ذات أولوية متابعة مرتفعة", primary: highPriorityVal, sub: "من واقع تحليل الأنماط متعددة الفترات" },
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

  // All-time total footer — open/late moves here as a small secondary line
  // (spec §6) rather than owning its own KPI card.
  const footerY = cardY + cardH + 24;
  const footerBoxH = 46;
  const periodMetricsForFooter = brief.periodMetrics ?? { current: EMPTY_PERIOD_SNAPSHOT_METRICS, previous: null };
  doc.roundedRect(margin, footerY, contentWidth, footerBoxH, r).fillAndStroke(COLORS.background, COLORS.border);
  drawIcon(doc, "database", margin + 24, footerY + footerBoxH / 2, 16);
  doc.font("Bold").fontSize(13).fillColor(COLORS.primary);
  const allTimeTotalText = `إجمالي الشكاوى المسجلة في النظام منذ بدء التشغيل: ${formatReportNumber(brief.allTimeTotal)}`;
  doc.text(preparePdfText(allTimeTotalText), margin + 44, footerY + 7, {
    width: contentWidth - 56, align: "right", wordSpacing: WORD_SPACING, lineBreak: false,
  });
  const openLateText = `مفتوحة نهاية الفترة: ${formatReportNumber(periodMetricsForFooter.current.openAtEnd)} | متأخرة: ${formatReportNumber(periodMetricsForFooter.current.lateAtEnd)}`;
  doc.font("Body").fontSize(9.5).fillColor(COLORS.neutral).text(
    preparePdfText(openLateText), margin + 44, footerY + 25,
    { width: contentWidth - 56, align: "right", wordSpacing: WORD_SPACING, lineBreak: false }
  );
  resetInk(doc);
}

// ── Page 2: registered/closed monthly trend ───────────────────────────────────

/** Explanatory note, not footer/badge/metadata print — follows the >=10.5pt body-text floor. */
export const PAGE2_TOTALS_NOTE_FONT_SIZE = 10.5;
const PAGE2_TOTALS_NOTE_GAP = 8;

function drawMonthlyTrendTotalCard(
  doc: PDFKit.PDFDocument,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    value: number;
    icon: IconType;
  }
): void {
  const { x, y, width, height, title, value, icon } = options;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  doc.roundedRect(x, y, width, height, r).fillAndStroke(COLORS.background, COLORS.gold);

  const circR = 16;
  const circX = x + width - 28;
  const circY = y + 30;
  doc.circle(circX, circY, circR).strokeColor(COLORS.gold).lineWidth(1.5).stroke();
  drawIcon(doc, icon, circX, circY, circR);

  doc.font("Bold").fontSize(13).fillColor(COLORS.gold).text(
    preparePdfText(title),
    x + 12,
    y + 18,
    { width: width - 56, align: "right", wordSpacing: WORD_SPACING }
  );
  doc.font("Bold").fontSize(28).fillColor(COLORS.primary).text(
    formatReportNumber(value, { maximumFractionDigits: 0 }),
    x + 12,
    y + 48,
    { width: width - 24, align: "right", wordSpacing: WORD_SPACING }
  );
  resetInk(doc);
}

async function renderPage2(ctx: V2Context): Promise<void> {
  const { doc, data, brief, layout, warnings } = ctx;
  const { margin, contentWidth } = layout;

  let y = drawPageHeader(ctx, "الاتجاه الزمني للشكاوى");
  y += 8;

  const reportEndDate = data.period.to;
  const rawFlow = brief.monthlyStockFlow;
  const flow = sanitizeMonthlyTrendForReport(rawFlow, reportEndDate, 13);
  const reportEndMonthKey = monthKeyFromReportEndDate(reportEndDate);
  const droppedFuture = reportEndMonthKey !== null
    && rawFlow.some(
      (point) => isValidMonthKey(point.monthKey) && point.monthKey > reportEndMonthKey
    );
  if (droppedFuture) {
    warnings.push("تم تجاهل نقاط زمنية تتجاوز نهاية فترة التقرير.");
  }
  if (resolveReportMonthStatus(reportEndDate) === null) {
    warnings.push("تعذر تفسير تاريخ نهاية التقرير لحالة الشهر الأخير.");
  }

  const totals = calculateMonthlyTrendTotals(flow);
  const insights = buildMonthlyTrendInsights({
    points: flow,
    reportEndDate,
  });
  const notesGap = 10;
  // Sized from the REAL wrapped visual line count (an insight sentence can
  // take 2-3 lines), not insights.length — the same single-source-of-truth
  // helper page 4's conclusions box uses, so drawBulletBox never truncates
  // or overflows a wrapped insight here either.
  const insightTexts = insights.map((insight) => insight.text);
  const notesLineCount = computeBulletBoxLineCount(doc, insightTexts, contentWidth);
  const notesHeight = computeBulletBoxHeight(notesLineCount);

  const cardGap = 12;
  const cardH = 88;
  const cardW = (contentWidth - cardGap) / 2;
  drawMonthlyTrendTotalCard(doc, {
    x: margin + cardW + cardGap,
    y,
    width: cardW,
    height: cardH,
    title: "إجمالي المغلقة",
    value: totals.closedTotal,
    icon: "check",
  });
  drawMonthlyTrendTotalCard(doc, {
    x: margin,
    y,
    width: cardW,
    height: cardH,
    title: "إجمالي المسجلة",
    value: totals.registeredTotal,
    icon: "clipboard",
  });
  y += cardH + 6;

  // Clarifies that both totals are windowed to the displayed months (up to 13),
  // not an absolute all-time total — see spec section 17.
  doc.font("Body").fontSize(PAGE2_TOTALS_NOTE_FONT_SIZE).fillColor(COLORS.neutral);
  const totalsScopeLayout = preparePdfTextLayout(
    doc,
    "الإجماليان أعلاه يشملان الأشهر المعروضة في الرسم أدناه فقط (حتى 13 شهرًا).",
    { width: contentWidth, align: "center", wordSpacing: WORD_SPACING }
  );
  totalsScopeLayout.lines.forEach((line, idx) => {
    doc.text(line.visualText, margin, y + idx * totalsScopeLayout.lineHeight, {
      width: contentWidth, align: "center", wordSpacing: WORD_SPACING, lineBreak: false,
    });
  });
  resetInk(doc);
  // Measured height, not a fixed assumption — this note now wraps to more
  // than one line at the raised font size on a narrower report if needed.
  y += totalsScopeLayout.height + PAGE2_TOTALS_NOTE_GAP;

  const hasMonthlyRegisteredOrClosed = flow.some(
    (point) => point.receivedCount > 0 || point.closedDuringMonthCount > 0
  );

  const availableForChart = resolveV2MonthlyChartAvailableHeight({
    pageHeight: doc.page.height,
    margin: layout.margin,
    chartY: y,
    footerReserve: FOOTER_RESERVE,
    notesHeight,
    notesGap,
  });
  const { chartHeight, canRenderChart } = resolveV2MonthlyChartRenderPlan(availableForChart);

  const monthlyChartSeries = [
    {
      name: "المسجلة",
      renderAs: "bar" as const,
      points: flow.map((point) => ({
        x: point.monthLabel,
        y: point.receivedCount,
      })),
    },
    {
      name: "المغلقة",
      renderAs: "line" as const,
      dash: "0",
      points: flow.map((point) => ({
        x: point.monthLabel,
        y: point.closedDuringMonthCount,
      })),
    },
  ];

  if (!canRenderChart) {
    warnings.push("تعذر رسم مخطط الاتجاه الزمني ضمن المساحة المتبقية من الصفحة.");
    if (chartHeight > 0) {
      doc.font("Body").fontSize(11).fillColor(COLORS.neutral).text(
        preparePdfText("لا تتوفر مساحة كافية لعرض مخطط الاتجاه الزمني في هذه الصفحة."),
        margin,
        y,
        {
          width: contentWidth,
          height: chartHeight,
          align: "center",
          wordSpacing: WORD_SPACING,
        }
      );
      resetInk(doc);
    }
  } else {
    try {
      const png = await renderLineChartPng(
        {
          id: "v2-monthly-flow",
          kind: "chart",
          chartType: "bar",
          title: "",
          series: hasMonthlyRegisteredOrClosed ? monthlyChartSeries : [],
          emptyState: "لا توجد بيانات شهرية للشكاوى المسجلة أو المغلقة.",
        },
        Math.round(contentWidth),
        chartHeight,
        {
          xLabelPolicy: "all",
          xLabelLayout: "wrap-two-lines",
          showLinePointValues: true,
        }
      );
      doc.image(png, margin, y, { width: contentWidth, height: chartHeight });
    } catch (err) {
      warnings.push(`تعذر رسم مخطط الاتجاه الزمني: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  y += chartHeight + notesGap;

  drawBulletBox({
    doc,
    title: "ملاحظات رئيسية",
    icon: "info",
    points: insightTexts,
    x: margin,
    y,
    width: contentWidth,
    height: notesHeight,
  });
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

/** §14: openAtEnd/lateAtEnd are replaced on page 4 by share-of-total and affected-facility-count. */
type EnrichedClassificationRow = ClassificationBriefRow & {
  affectedFacilityCount: number;
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

function formatRegionTableCell(
  row: RegionComparisonTableRow,
  key: string,
  hasComparisonPeriod: boolean
): string {
  if (key === "difference") {
    if (!hasComparisonPeriod) return "—";
    return formatReportNumber(row.difference, { sign: true });
  }
  if (key === "changeRate") {
    if (!hasComparisonPeriod) return "—";
    if (row.previousCount === 0 && row.currentCount > 0) {
      return "جديد";
    }
    if (row.previousCount === 0 && row.currentCount === 0) {
      return formatReportNumber(0, { percent: true });
    }
    return formatNullableReportNumber(row.changeRate, { percent: true });
  }
  return formatTableValue((row as Record<string, unknown>)[key]);
}

function formatClassificationTableCell(
  row: EnrichedClassificationRow,
  key: string
): string {
  if (key === "difference") {
    return formatReportNumber(row.difference, { sign: true });
  }
  if (key === "changeRate") {
    return formatNullableReportNumber(row.changeRate, { percent: true });
  }
  if (key === "shareOfTotal") {
    return formatReportNumber(row.shareOfTotal, { percent: true });
  }
  if (key === "classificationPath") {
    return row.classificationPath;
  }
  return formatTableValue((row as Record<string, unknown>)[key]);
}

/**
 * No arrow glyphs anywhere in these cells — the Amiri font used by this PDF
 * has no glyph for U+2191/U+2193 (confirmed via a real generated PDF), so
 * the period trail uses an Arabic comma ("، ") between values instead. `trail`
 * is capped at 5 values (spec §4) and is NOT the same thing as `streakPeriods`
 * (the real streak length, which can be longer) — each has its own column.
 */
function formatClassificationTrendCell(row: ClassificationTrendRow, key: string): string {
  if (key === "trail") return row.trail || "—";
  return formatTableValue((row as Record<string, unknown>)[key]);
}

/** "0 — ظهرت خلال فترات سابقة" for the narrow, explicitly-justified historical-only case (spec §1). */
function formatFollowUpTotalComplaints(row: FacilityFollowUpRow): string {
  if (row.isHistoricalOnly) return "0 — ظهرت خلال فترات سابقة";
  return formatReportNumber(row.totalComplaints);
}

/**
 * Numeric repeat/spread text (spec §10) — never a person's identifier, and
 * never a vague qualitative label like "منتشر بين عدة أشخاص". Shows both
 * signals together when both apply.
 */
function formatRepeatOrSpreadCell(row: FacilityFollowUpRow): string {
  const segments: string[] = [];
  if (row.repeatComplainants !== null) {
    const complaints = row.repeatComplaints !== null ? ` / ${formatReportNumber(row.repeatComplaints)} شكوى` : "";
    segments.push(`تكرار: ${formatReportNumber(row.repeatComplainants)} أشخاص${complaints}`);
  }
  if (row.spreadComplainants !== null) {
    const complaints = row.spreadComplaints !== null ? ` / ${formatReportNumber(row.spreadComplaints)} شكوى` : "";
    segments.push(`انتشار: ${formatReportNumber(row.spreadComplainants)} شخصاً${complaints}`);
  }
  return segments.length > 0 ? segments.join(" | ") : "—";
}

function formatFacilityFollowUpCell(row: FacilityFollowUpRow, key: string): string {
  if (key === "streakPeriods") return row.streakPeriods === null ? "—" : formatReportNumber(row.streakPeriods);
  if (key === "totalComplaints") return formatFollowUpTotalComplaints(row);
  if (key === "repeatOrSpread") return formatRepeatOrSpreadCell(row);
  return formatTableValue((row as Record<string, unknown>)[key]);
}

/**
 * PDF-display-only shortening of the candidate table's "سبب الاختيار"
 * column — the full-length reasonLabel produced by best-practice-candidate.ts
 * (see its buildReasonLabel) stays unchanged everywhere else (conclusions
 * text, any future documentation workflow); only this narrow table column
 * gets a short version so a long sentence never renders truncated inside
 * the cell. Candidacy gates, merit score, and ranking are untouched — this
 * is a wording map only, keyed on the exact known reasonLabel values.
 */
function shortenBestPracticeReasonForDisplay(reasonLabel: string): string {
  if (reasonLabel.startsWith("انخفاض مستدام عبر")) return "تحسن مستدام";
  if (reasonLabel === "تحسن مستدام مع انخفاض جوهري في حجم الشكاوى") return "انخفاض جوهري ومستدام";
  return reasonLabel; // "تحسن قوي ومستدام" is already short; defensive fallback for any other value.
}

/** "مقدار التحسن" is shown as a negative amount (e.g. "−41") — the decrease itself is stored positive so other math (merit score, sorting) never has to fight a sign. */
function formatBestPracticeCandidateCell(row: BestPracticeCandidateRow, key: string): string {
  if (key === "improvementAmount") return formatReportNumber(-row.decrease);
  if (key === "reasonLabel") return shortenBestPracticeReasonForDisplay(row.reasonLabel);
  return formatTableValue((row as Record<string, unknown>)[key]);
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
  const series = [{ name: "الحالية", points: currentPts }];
  if (hasPrev) {
    series.push({ name: "السابقة", points: regions.map((r) => ({ x: stripPrefix(r.regionName), y: r.previousCount })) });
  }
  const chartH = 296;
  try {
    const png = await renderLineChartPng({
      id: "v2-region-bar",
      kind: "chart",
      chartType: "bar",
      title: hasPrev ? "مقارنة شكاوى الفترة الحالية مقابل الفترة السابقة حسب المنطقة" : "إجمالي الفترة الحالية حسب المنطقة",
      series,
      emptyState: "لا توجد بيانات مناطق.",
    }, Math.round(contentWidth), chartH, {
      xLabelPolicy: "all",
      xLabelLayout: "wrap-two-lines",
    });
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

    // §8: difference/change-rate replace open/late so the card reads as a
    // decision signal (is this region rising or falling?) rather than a
    // backlog snapshot — backlog stock stays in the detailed table below.
    const metricW = cardW / 3;
    const bodyY = cy + hdrH + 4;
    const hasComparisonPeriod = Boolean(data.previousPeriod);
    const differenceText = hasComparisonPeriod ? formatReportNumber(region.difference, { sign: true }) : "—";
    const changeRateText = !hasComparisonPeriod
      ? "—"
      : region.previousCount === 0 && region.currentCount > 0
        ? "جديد"
        : formatNullableReportNumber(region.changeRate, { percent: true });
    const isNegative = hasComparisonPeriod && region.difference < 0;
    const metrics = [
      { label: "نسبة التغير", value: changeRateText, colored: true },
      { label: "الفرق", value: differenceText, colored: true },
      { label: "شكاوى الفترة", value: formatReportNumber(region.currentCount), colored: false },
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
      doc.font("Bold").fontSize(16).fillColor(m.colored && isNegative ? COLORS.danger : COLORS.primary).text(
        preparePdfText(m.value), mx + 2, bodyY + 24,
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
  y = drawTable({
    doc,
    rows: regionRows,
    columns: regionCols,
    x: margin,
    y,
    width: contentWidth,
    rowHeight: rowH,
    formatCell: (row, key) => formatRegionTableCell(row, key, hasComparisonPeriod),
  });
  y += 14;

  drawInfoBox(
    doc,
    "يعرض الجدول التغير بين الفترتين حسب المنطقة، وتظهر «جديد» عند عدم وجود قيمة سابقة.",
    margin,
    y,
    contentWidth
  );
}

// ── Operational practices grid ("ممارسات تشغيلية مقترحة") ──────────────────────

const PRACTICE_CARD_GAP = 10;
const PRACTICE_GRID_COLS = 2;
const PRACTICE_SECTION_TRAILING_GAP = 14;
const PRACTICE_SECTION_SUBTITLE =
  "ممارسات مختارة بما يتناسب مع أبرز موضوعات الشكاوى خلال الفترة — توصيات تشغيلية عامة وليست ممارسات مثبتة من بيانات موقع بعينه.";
const PRACTICE_SECTION_EMPTY_MESSAGE = "لا تتوفر ممارسات تشغيلية مقترحة لهذه الفترة.";

// Card content budget — approved-library text is never clipped or
// ellipsis-truncated (spec review): every title/description is measured
// with preparePdfTextLayout and wrapped into real lines, capped at these
// line counts. A dedicated test (operational-practices.test.ts) proves
// every current OPERATIONAL_PRACTICES entry fits within this budget at the
// exact card width used here, and fails if a future entry does not.
export const PRACTICE_TITLE_MAX_LINES = 2;
export const PRACTICE_DESCRIPTION_MAX_LINES = 3;
export const PRACTICE_TITLE_FONT_SIZE = 11.5;
export const PRACTICE_DESCRIPTION_FONT_SIZE = 10.5;
const PRACTICE_BADGE_FONT_SIZE = 9.5;
/** Section subtitle above the practice grid — not footer/badge print, so it follows the >=10.5pt body-text floor. */
const PRACTICE_SUBTITLE_FONT_SIZE = 10.5;
const PRACTICE_CARD_PAD_X = 10;
const PRACTICE_CARD_PAD_TOP = 8;
const PRACTICE_CARD_PAD_BOTTOM = 8;
const PRACTICE_BADGE_TO_TITLE_GAP = 4;
const PRACTICE_TITLE_TO_DESCRIPTION_GAP = 4;

export function practiceCardInnerWidth(sectionWidth: number): number {
  const cardW = (sectionWidth - PRACTICE_CARD_GAP * (PRACTICE_GRID_COLS - 1)) / PRACTICE_GRID_COLS;
  return cardW - PRACTICE_CARD_PAD_X * 2;
}

/** Real font-metric line heights for the card's three text roles — a pure function of (font, size), so layout time (no page yet) and render time (real doc) always agree exactly. */
function measurePracticeLineHeights(doc: PDFKit.PDFDocument): { badge: number; title: number; description: number } {
  doc.font("Bold").fontSize(PRACTICE_BADGE_FONT_SIZE);
  const badge = doc.currentLineHeight(true);
  doc.font("Bold").fontSize(PRACTICE_TITLE_FONT_SIZE);
  const title = doc.currentLineHeight(true);
  doc.font("Body").fontSize(PRACTICE_DESCRIPTION_FONT_SIZE);
  const description = doc.currentLineHeight(true);
  return { badge, title, description };
}

/** Fixed per-card height sized to fit the MAX_LINES budget above — single source of truth for both drawing and the layout reserve. */
export function computePracticeCardHeight(doc: PDFKit.PDFDocument): number {
  const { badge, title, description } = measurePracticeLineHeights(doc);
  return (
    PRACTICE_CARD_PAD_TOP
    + badge
    + PRACTICE_BADGE_TO_TITLE_GAP
    + title * PRACTICE_TITLE_MAX_LINES
    + PRACTICE_TITLE_TO_DESCRIPTION_GAP
    + description * PRACTICE_DESCRIPTION_MAX_LINES
    + PRACTICE_CARD_PAD_BOTTOM
  );
}

/** Real wrapped height of the fixed subtitle sentence at this section width — never assumed to be one line. */
function computePracticeSubtitleHeight(doc: PDFKit.PDFDocument, width: number): number {
  doc.font("Body").fontSize(PRACTICE_SUBTITLE_FONT_SIZE);
  return preparePdfTextLayout(doc, PRACTICE_SECTION_SUBTITLE, { width, align: "right", wordSpacing: WORD_SPACING }).height;
}

/**
 * The exact height "ممارسات تشغيلية مقترحة" will occupy for this
 * `practiceCount`, at this section `width` — used to both RESERVE room
 * (createV2Layout, resolveV2FacilityRowCounts) and to actually draw
 * (drawOperationalPracticesSection), so the rendered section can never be
 * taller than what was reserved for it. Reserves real, non-zero room for
 * the empty-state fallback box too — an empty practices list still draws a
 * title, subtitle, and info box, never "nothing".
 */
export function operationalPracticesSectionHeight(
  doc: PDFKit.PDFDocument,
  practiceCount: number,
  width: number
): number {
  const titleH = FACILITY_SECTION_TITLE_H;
  const subtitleH = computePracticeSubtitleHeight(doc, width);
  if (practiceCount === 0) {
    const emptyBoxH = computeInfoBoxHeight(doc, PRACTICE_SECTION_EMPTY_MESSAGE, width);
    return titleH + subtitleH + emptyBoxH + PRACTICE_SECTION_TRAILING_GAP;
  }
  const shownCount = Math.min(practiceCount, OPERATIONAL_PRACTICE_CARD_COUNT);
  const gridRows = Math.ceil(shownCount / PRACTICE_GRID_COLS);
  const cardH = computePracticeCardHeight(doc);
  return titleH + subtitleH + gridRows * cardH + Math.max(0, gridRows - 1) * PRACTICE_CARD_GAP + PRACTICE_SECTION_TRAILING_GAP;
}

/**
 * "ممارسات تشغيلية مقترحة" (spec): up to 4 pre-approved, generic
 * operational-practice recommendations — see operational-practices.ts.
 * Deliberately separate from "حالات التحسن المستدام"
 * above: only title/description are ever rendered, never topic,
 * selectionReason, or any other internal field, and the wording never
 * claims these practices are proven or already the cause of any facility's
 * improvement. Every piece of text (subtitle, title, description) is
 * measured and wrapped with preparePdfTextLayout and drawn line-by-line
 * with `lineBreak: false` — never PDFKit's own automatic wrapping of
 * already RTL-prepared text, and never `ellipsis` (see
 * operationalPracticesSectionHeight for why this can never overflow the
 * reserved space).
 */
function drawOperationalPracticesSection(
  doc: PDFKit.PDFDocument,
  practices: readonly OperationalPracticeRow[],
  x: number,
  y: number,
  width: number
): number {
  const cursorY = drawSectionTitle(doc, "ممارسات تشغيلية مقترحة", x, y, width);

  doc.font("Body").fontSize(PRACTICE_SUBTITLE_FONT_SIZE).fillColor(COLORS.neutral);
  const subtitleLayout = preparePdfTextLayout(doc, PRACTICE_SECTION_SUBTITLE, { width, align: "right", wordSpacing: WORD_SPACING });
  subtitleLayout.lines.forEach((line, idx) => {
    doc.text(line.visualText, x, cursorY + idx * subtitleLayout.lineHeight, { width, align: "right", wordSpacing: WORD_SPACING, lineBreak: false });
  });
  const gridY = cursorY + subtitleLayout.height;

  if (practices.length === 0) {
    const boxBottom = drawInfoBox(doc, PRACTICE_SECTION_EMPTY_MESSAGE, x, gridY, width);
    resetInk(doc);
    return boxBottom + PRACTICE_SECTION_TRAILING_GAP;
  }

  const shown = practices.slice(0, OPERATIONAL_PRACTICE_CARD_COUNT);
  const cardW = (width - PRACTICE_CARD_GAP * (PRACTICE_GRID_COLS - 1)) / PRACTICE_GRID_COLS;
  const innerW = practiceCardInnerWidth(width);
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const cardH = computePracticeCardHeight(doc);
  const { badge: badgeLineH, title: titleLineH, description: descriptionLineH } = measurePracticeLineHeights(doc);

  shown.forEach((practice, idx) => {
    const row = Math.floor(idx / PRACTICE_GRID_COLS);
    const col = idx % PRACTICE_GRID_COLS;
    // RTL reading order: card 1 sits top-right, matching region-card layout elsewhere on this page.
    const cx = x + (PRACTICE_GRID_COLS - 1 - col) * (cardW + PRACTICE_CARD_GAP);
    const cy = gridY + row * (cardH + PRACTICE_CARD_GAP);
    const textX = cx + PRACTICE_CARD_PAD_X;

    doc.roundedRect(cx, cy, cardW, cardH, r).fillAndStroke(COLORS.background, COLORS.border);

    doc.font("Bold").fontSize(PRACTICE_BADGE_FONT_SIZE).fillColor(COLORS.gold).text(
      String(idx + 1).padStart(2, "0"),
      textX,
      cy + PRACTICE_CARD_PAD_TOP,
      { width: innerW, align: "right" }
    );

    let lineY = cy + PRACTICE_CARD_PAD_TOP + badgeLineH + PRACTICE_BADGE_TO_TITLE_GAP;
    doc.font("Bold").fontSize(PRACTICE_TITLE_FONT_SIZE).fillColor(COLORS.primary);
    const titleLayout = preparePdfTextLayout(doc, practice.title, { width: innerW, align: "right", wordSpacing: WORD_SPACING });
    // Capped at PRACTICE_TITLE_MAX_LINES as defense-in-depth for the card's
    // own bottom edge — never actually reached for approved library text,
    // which the invariant test in operational-practices.test.ts guarantees
    // fits well within this budget.
    titleLayout.lines.slice(0, PRACTICE_TITLE_MAX_LINES).forEach((line) => {
      doc.text(line.visualText, textX, lineY, { width: innerW, align: "right", wordSpacing: WORD_SPACING, lineBreak: false });
      lineY += titleLineH;
    });

    lineY = cy + PRACTICE_CARD_PAD_TOP + badgeLineH + PRACTICE_BADGE_TO_TITLE_GAP + titleLineH * PRACTICE_TITLE_MAX_LINES + PRACTICE_TITLE_TO_DESCRIPTION_GAP;
    doc.font("Body").fontSize(PRACTICE_DESCRIPTION_FONT_SIZE).fillColor(COLORS.text);
    const descriptionLayout = preparePdfTextLayout(doc, practice.description, { width: innerW, align: "right", wordSpacing: WORD_SPACING });
    descriptionLayout.lines.slice(0, PRACTICE_DESCRIPTION_MAX_LINES).forEach((line) => {
      doc.text(line.visualText, textX, lineY, { width: innerW, align: "right", wordSpacing: WORD_SPACING, lineBreak: false });
      lineY += descriptionLineH;
    });
  });
  resetInk(doc);

  const gridRows = Math.ceil(shown.length / PRACTICE_GRID_COLS);
  return gridY + gridRows * cardH + Math.max(0, gridRows - 1) * PRACTICE_CARD_GAP + PRACTICE_SECTION_TRAILING_GAP;
}

// ── Executive conclusions ("الاستنتاجات التنفيذية") ─────────────────────────
//
// Replaces the old long bullet-point box (spec §27): up to 4 compact rows,
// each a numbered badge + a short bold title + ONE explanatory sentence,
// inside its own light-bordered card — never one long paragraph, never
// ellipsis, never more than the real per-row wrapped height it measures.

const EXEC_CONCLUSIONS_EMPTY_MESSAGE = "لا تتوفر استنتاجات تنفيذية لهذه الفترة.";
const EXEC_CONCLUSIONS_BADGE_FONT_SIZE = 9.5;
export const EXEC_CONCLUSIONS_TITLE_FONT_SIZE = 12;
export const EXEC_CONCLUSIONS_TEXT_FONT_SIZE = 11.5;
const EXEC_CONCLUSIONS_PAD_X = 14;
const EXEC_CONCLUSIONS_PAD_TOP = 10;
const EXEC_CONCLUSIONS_PAD_BOTTOM = 10;
const EXEC_CONCLUSIONS_BADGE_TO_TITLE_GAP = 3;
const EXEC_CONCLUSIONS_TITLE_TO_TEXT_GAP = 4;
/** Vertical space BETWEEN row cards (spec §27: "مسافة واضحة بين الاستنتاجات"). */
const EXEC_CONCLUSIONS_ROW_GAP = 10;

export function executiveConclusionsInnerWidth(width: number): number {
  return width - EXEC_CONCLUSIONS_PAD_X * 2;
}

/** Real font-metric line heights for a row's three text roles — pure function of (font, size), same pattern as measurePracticeLineHeights. */
function measureExecutiveConclusionLineHeights(doc: PDFKit.PDFDocument): { badge: number; title: number; text: number } {
  doc.font("Bold").fontSize(EXEC_CONCLUSIONS_BADGE_FONT_SIZE);
  const badge = doc.currentLineHeight(true);
  doc.font("Bold").fontSize(EXEC_CONCLUSIONS_TITLE_FONT_SIZE);
  const title = doc.currentLineHeight(true);
  doc.font("Body").fontSize(EXEC_CONCLUSIONS_TEXT_FONT_SIZE);
  const text = doc.currentLineHeight(true);
  return { badge, title, text };
}

type ExecutiveConclusionMeasurement = {
  titleLayout: ReturnType<typeof preparePdfTextLayout>;
  textLayout: ReturnType<typeof preparePdfTextLayout>;
  rowHeight: number;
};

/**
 * Exact height ONE row needs for its real wrapped title/text — never a
 * fixed per-row assumption, so a short conclusion never reserves the same
 * space as a long one (spec §28: the builder keeps text short; the
 * renderer never truncates it either way, it just measures what is
 * actually there). splitOversizedTokens is on so a single long word can
 * never paint outside the row's frame.
 */
function measureExecutiveConclusionRow(
  doc: PDFKit.PDFDocument,
  row: ExecutiveConclusionRow,
  width: number
): ExecutiveConclusionMeasurement {
  const innerWidth = executiveConclusionsInnerWidth(width);
  const { badge: badgeLineH, title: titleLineH, text: textLineH } = measureExecutiveConclusionLineHeights(doc);

  doc.font("Bold").fontSize(EXEC_CONCLUSIONS_TITLE_FONT_SIZE);
  const titleLayout = preparePdfTextLayout(doc, row.title, {
    width: innerWidth, align: "right", wordSpacing: WORD_SPACING, splitOversizedTokens: true,
  });
  doc.font("Body").fontSize(EXEC_CONCLUSIONS_TEXT_FONT_SIZE);
  const textLayout = preparePdfTextLayout(doc, row.text, {
    width: innerWidth, align: "right", wordSpacing: WORD_SPACING, splitOversizedTokens: true,
  });

  const rowHeight =
    EXEC_CONCLUSIONS_PAD_TOP
    + badgeLineH
    + EXEC_CONCLUSIONS_BADGE_TO_TITLE_GAP
    + titleLayout.lines.length * titleLineH
    + EXEC_CONCLUSIONS_TITLE_TO_TEXT_GAP
    + textLayout.lines.length * textLineH
    + EXEC_CONCLUSIONS_PAD_BOTTOM;

  return { titleLayout, textLayout, rowHeight };
}

/**
 * The exact height "الاستنتاجات التنفيذية" will occupy for these `rows` at
 * this `width` — used to both RESERVE room (planPage4Layout) and to
 * actually draw (drawExecutiveConclusionsSection), so the section can never
 * render taller than what was planned for it.
 */
function executiveConclusionsSectionHeight(
  doc: PDFKit.PDFDocument,
  rows: readonly ExecutiveConclusionRow[],
  width: number
): number {
  const titleH = FACILITY_SECTION_TITLE_H;
  if (rows.length === 0) {
    return titleH + computeInfoBoxHeight(doc, EXEC_CONCLUSIONS_EMPTY_MESSAGE, width);
  }
  let rowsHeight = 0;
  rows.forEach((row, idx) => {
    rowsHeight += measureExecutiveConclusionRow(doc, row, width).rowHeight;
    if (idx < rows.length - 1) rowsHeight += EXEC_CONCLUSIONS_ROW_GAP;
  });
  return titleH + rowsHeight;
}

/**
 * "الاستنتاجات التنفيذية" (spec §17-30): up to 4 short executive rows —
 * numbered badge + short bold title + one explanatory sentence each, inside
 * its own light-bordered card. No bullet points, no single long paragraph,
 * never ellipsis-truncated. Returns the bottom Y, matching every other
 * page-4 section's "returns bottom Y" convention.
 */
function drawExecutiveConclusionsSection(
  doc: PDFKit.PDFDocument,
  rows: readonly ExecutiveConclusionRow[],
  x: number,
  y: number,
  width: number
): number {
  const cursorY = drawSectionTitle(doc, "الاستنتاجات التنفيذية", x, y, width);

  if (rows.length === 0) {
    const boxBottom = drawInfoBox(doc, EXEC_CONCLUSIONS_EMPTY_MESSAGE, x, cursorY, width);
    resetInk(doc);
    return boxBottom;
  }

  const innerWidth = executiveConclusionsInnerWidth(width);
  const { badge: badgeLineH, title: titleLineH, text: textLineH } = measureExecutiveConclusionLineHeights(doc);
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const textX = x + EXEC_CONCLUSIONS_PAD_X;

  let rowY = cursorY;
  rows.forEach((row, idx) => {
    const { titleLayout, textLayout, rowHeight } = measureExecutiveConclusionRow(doc, row, width);

    doc.roundedRect(x, rowY, width, rowHeight, r).fillAndStroke(COLORS.background, COLORS.border);

    doc.font("Bold").fontSize(EXEC_CONCLUSIONS_BADGE_FONT_SIZE).fillColor(COLORS.gold).text(
      String(idx + 1).padStart(2, "0"),
      textX,
      rowY + EXEC_CONCLUSIONS_PAD_TOP,
      { width: innerWidth, align: "right" }
    );

    let lineY = rowY + EXEC_CONCLUSIONS_PAD_TOP + badgeLineH + EXEC_CONCLUSIONS_BADGE_TO_TITLE_GAP;
    doc.font("Bold").fontSize(EXEC_CONCLUSIONS_TITLE_FONT_SIZE).fillColor(COLORS.primary);
    titleLayout.lines.forEach((line) => {
      doc.text(line.visualText, textX, lineY, { width: innerWidth, align: "right", wordSpacing: WORD_SPACING, lineBreak: false });
      lineY += titleLineH;
    });

    lineY += EXEC_CONCLUSIONS_TITLE_TO_TEXT_GAP;
    doc.font("Body").fontSize(EXEC_CONCLUSIONS_TEXT_FONT_SIZE).fillColor(COLORS.text);
    textLayout.lines.forEach((line) => {
      doc.text(line.visualText, textX, lineY, { width: innerWidth, align: "right", wordSpacing: WORD_SPACING, lineBreak: false });
      lineY += textLineH;
    });

    rowY += rowHeight + EXEC_CONCLUSIONS_ROW_GAP;
  });
  resetInk(doc);

  return rowY - EXEC_CONCLUSIONS_ROW_GAP;
}

// ── Page 4: Classifications + Facilities + Conclusions ─────────────────────────

const PAGE4_TITLE = "التصنيفات والسجون والاستنتاجات";
/** Defense-in-depth cap matching MAX_EXECUTIVE_CONCLUSIONS in report-executive-brief-data-service.ts — the data layer already caps at 4; the renderer never trusts that unconditionally. */
const MAX_EXECUTIVE_CONCLUSIONS_V2 = 4;
/** Item 8: page 4's final height is content-bottom + this reserve, never inflated further. */
const PAGE4_BOTTOM_SAFETY_MARGIN = 8;

export type V2Page4Plan = {
  /** Final page 4 height: max(BASE_PAGE_HEIGHT, actual content bottom + footer reserve + safety margin) — never page 3's region-driven height. */
  pageHeight: number;
  topRows: number;
  bottomRows: number;
};

/**
 * Plans page 4 purely from measurement (no drawing) by mirroring
 * renderPage4's own y-arithmetic term for term, so the two can never
 * disagree — the same "single source of truth" pattern as
 * operationalPracticesSectionHeight / computeBulletBoxHeight. Called
 * twice for a real render: once (with the real `doc`, before `addPage`) to
 * size page 4, and once more (same doc, now on that page) inside
 * renderPage4 for the actual topRows/bottomRows/conclusions height — both
 * calls are pure functions of (font metrics, brief data, margin,
 * contentWidth) so they always agree.
 *
 * Facility rows are reduced first, but only down to FACILITY_MIN_ROWS
 * (BASE_PAGE_HEIGHT is the planning ceiling passed to
 * resolveV2FacilityRowCounts, matching what it already does) — a table with
 * real data never renders as headers-only. Page height grows past that
 * ceiling when even the row floor still would not leave room for every
 * conclusion line (spec priority: core tables and their minimum rows, then
 * use space efficiently, then grow the page — never drop a table's rows
 * below its floor or a conclusion to keep the page short).
 */
export function planPage4Layout(
  doc: PDFKit.PDFDocument,
  brief: ExecutiveBriefV2Data,
  margin: number,
  contentWidth: number
): V2Page4Plan {
  const classRows = brief.topClassifications.slice(0, TOP_CLASSIFICATIONS_V2_LIMIT);
  const followUpRows = brief.facilitiesNeedingFollowUp ?? [];
  const bestPracticeRows = brief.bestPracticeCandidates ?? [];
  const operationalPractices = brief.operationalPractices ?? [];
  const executiveConclusions = (brief.executiveConclusions ?? []).slice(0, MAX_EXECUTIVE_CONCLUSIONS_V2);
  const trendRows = brief.classificationTrends;
  const gap = 14;
  const rowH = 26;

  let y = computePageHeaderLayout(doc, PAGE4_TITLE, contentWidth).contentStartY;

  // Trend table (or info-box fallback) — mirrors renderPage4 exactly.
  y += FACILITY_SECTION_TITLE_H;
  if (trendRows && trendRows.length > 0) {
    y += 22 + 2 + trendRows.length * 22;
  } else {
    const message = trendRows === undefined
      ? "تعذر احتساب اتجاهات التصنيفات لهذه الفترة."
      : "لا تتوفر بيانات كافية عبر عدة فترات لاستخراج اتجاهات التصنيفات.";
    y += computeInfoBoxHeight(doc, message, contentWidth);
  }
  y += gap;

  // Classifications table (top TOP_CLASSIFICATIONS_V2_LIMIT rows).
  y += FACILITY_SECTION_TITLE_H;
  y += rowH + 2 + classRows.length * rowH;
  y += gap;

  const requiredConclusionsHeight = executiveConclusionsSectionHeight(doc, executiveConclusions, contentWidth);
  const practicesReserve = operationalPracticesSectionHeight(doc, operationalPractices.length, contentWidth);

  // The row-reduction ceiling includes practicesReserve on TOP of the base
  // height (same "expand height, not shrink rows" treatment page 3's region
  // term gets) — practicesReserve is passed as additionalReservedHeight too,
  // so the two exactly cancel out in resolveV2FacilityRowCounts's own budget
  // formula, leaving the ceiling effectively at BASE_PAGE_HEIGHT for rows.
  // Only conclusion-line growth (not the practices grid) ever pressures
  // facility rows to shrink — matching this section's pre-existing behavior
  // before page-3's region count started leaking into every page's height.
  const facilityRowCounts = resolveV2FacilityRowCounts({
    pageHeight: BASE_PAGE_HEIGHT + practicesReserve,
    margin,
    y,
    gap,
    topAvailableRows: followUpRows.length,
    bottomAvailableRows: bestPracticeRows.length,
    requiredConclusionsHeight,
    additionalReservedHeight: practicesReserve,
  });

  y += FACILITY_SECTION_TITLE_H + FACILITY_TABLE_HEADER_H + facilityRowCounts.topRows * FACILITY_ROW_HEIGHT + gap;
  y += FACILITY_SECTION_TITLE_H + FACILITY_TABLE_HEADER_H + facilityRowCounts.bottomRows * FACILITY_ROW_HEIGHT + gap;
  y += practicesReserve;

  const contentBottom = y + requiredConclusionsHeight;
  const pageHeight = Math.max(
    BASE_PAGE_HEIGHT,
    contentBottom + margin + FOOTER_RESERVE + PAGE4_BOTTOM_SAFETY_MARGIN
  );

  return {
    pageHeight,
    topRows: facilityRowCounts.topRows,
    bottomRows: facilityRowCounts.bottomRows,
  };
}

function renderPage4(ctx: V2Context): void {
  const { doc, brief, layout } = ctx;
  const { margin, contentWidth } = layout;
  const classRows = brief.topClassifications.slice(0, TOP_CLASSIFICATIONS_V2_LIMIT);
  const followUpRows = brief.facilitiesNeedingFollowUp ?? [];
  const bestPracticeRows = brief.bestPracticeCandidates ?? [];
  const operationalPractices = brief.operationalPractices ?? [];
  const executiveConclusions = (brief.executiveConclusions ?? []).slice(0, MAX_EXECUTIVE_CONCLUSIONS_V2);
  const trendRows = brief.classificationTrends;
  const hasClassComparison = classRows.some((r) => r.previousCount > 0);

  let y = drawPageHeader(ctx, PAGE4_TITLE);
  const gap = 14;
  const rowH = 26;

  // Single source of truth for row counts / conclusions height — the exact
  // same measurement already used to size THIS page before addPage() was
  // called for it (see the main entry point), so it can never disagree.
  const page4Plan = planPage4Layout(doc, brief, margin, contentWidth);

  // ── Continuing problems by facility × classification (V2-only; multi-period, sourced from the shared pattern-analysis engine — never department-based) ──
  y = drawSectionTitle(doc, "أبرز المشكلات المستمرة حسب السجن والتصنيف", margin, y, contentWidth);
  if (trendRows && trendRows.length > 0) {
    const trendCols: ColDef[] = [
      { key: "facility", label: "السجن", weight: 1.3 },
      { key: "classification", label: "التصنيف", weight: 1.55 },
      { key: "currentCount", label: "الحالية", weight: 0.5 },
      { key: "trail", label: "آخر 5 فترات", weight: 1.55 },
      { key: "streakPeriods", label: "مدة الاستمرار", weight: 0.7 },
      { key: "patternLabel", label: "النمط", weight: 1.0 },
    ];
    y = drawTable({
      doc,
      rows: trendRows,
      columns: trendCols,
      x: margin,
      y,
      width: contentWidth,
      rowHeight: 22,
      formatCell: formatClassificationTrendCell,
    });
    y += gap;
  } else {
    const message = trendRows === undefined
      ? "تعذر احتساب اتجاهات التصنيفات لهذه الفترة."
      : "لا تتوفر بيانات كافية عبر عدة فترات لاستخراج اتجاهات التصنيفات.";
    y = drawInfoBox(doc, message, margin, y, contentWidth) + gap;
  }

  // ── Classifications table (spec §14: top 5 only; share-of-total + affected-facility-count replace open/late) ──
  y = drawSectionTitle(doc, "أعلى التصنيفات", margin, y, contentWidth);
  const classCols: ColDef[] = hasClassComparison
    ? [
        { key: "classificationPath", label: "التصنيف", weight: 2.2 },
        { key: "currentCount", label: "شكاوى الفترة", weight: 0.9 },
        { key: "previousCount", label: "السابق", weight: 0.8 },
        { key: "difference", label: "الفرق", weight: 0.75 },
        { key: "shareOfTotal", label: "الحصة", weight: 0.75 },
        { key: "affectedFacilityCount", label: "السجون المتأثرة", weight: 0.95 },
      ]
    : [
        { key: "classificationPath", label: "التصنيف", weight: 2.6 },
        { key: "currentCount", label: "شكاوى الفترة", weight: 1 },
        { key: "shareOfTotal", label: "الحصة", weight: 0.85 },
        { key: "affectedFacilityCount", label: "السجون المتأثرة", weight: 1.05 },
      ];

  // Enrich classification rows with the count of distinct facilities where
  // this classification crossed the pattern engine's own significance
  // threshold (spec §14) — never a raw-presence count computed separately.
  const enrichedClass: EnrichedClassificationRow[] = classRows.map((row) => ({
    ...row,
    affectedFacilityCount: brief.classificationAffectedFacilityCounts[row.classificationId] ?? 0,
  }));

  y = drawTable({
    doc,
    rows: enrichedClass,
    columns: classCols,
    x: margin,
    y,
    width: contentWidth,
    rowHeight: rowH,
    formatCell: formatClassificationTableCell,
  });
  y += gap;

  // ── Facilities: needing follow-up + sustained improvement ───────────────────
  // Row counts flex (5 down to a floor of FACILITY_MIN_ROWS, never below
  // while that table has real data) to try to keep room for every actual
  // conclusion — page 4 grows instead once the floor itself doesn't fit.
  const facilityRowCounts = { topRows: page4Plan.topRows, bottomRows: page4Plan.bottomRows };
  const followUpCols: ColDef[] = [
    { key: "facility", label: "السجن", weight: 1.3 },
    { key: "totalComplaints", label: "شكاوى الفترة", weight: 0.85 },
    { key: "topIssueLabel", label: "أبرز مشكلة", weight: 1.2 },
    { key: "patternLabel", label: "النمط", weight: 0.9 },
    { key: "streakPeriods", label: "مدة الاستمرار", weight: 0.85 },
    { key: "repeatOrSpread", label: "التكرار/الانتشار", weight: 1.5 },
    { key: "priorityBand", label: "الأولوية", weight: 0.65 },
  ];
  const bestPracticeCols: ColDef[] = [
    { key: "facility", label: "السجن", weight: 1.3 },
    { key: "classificationLabel", label: "مجال التحسن", weight: 1.3 },
    { key: "startValue", label: "البداية", weight: 0.55 },
    { key: "currentValue", label: "الحالية", weight: 0.55 },
    { key: "improvementAmount", label: "مقدار التحسن", weight: 0.75 },
    { key: "streakPeriods", label: "مدة التحسن", weight: 0.75 },
    { key: "reasonLabel", label: "سبب الاختيار", weight: 1.35 },
  ];

  y = drawSectionTitle(doc, "السجون الأكثر حاجة للمتابعة", margin, y, contentWidth);
  y = drawTable({
    doc,
    rows: followUpRows.slice(0, facilityRowCounts.topRows),
    columns: followUpCols,
    x: margin,
    y,
    width: contentWidth,
    rowHeight: rowH,
    formatCell: formatFacilityFollowUpCell,
  });
  y += gap;

  y = drawSectionTitle(doc, "حالات التحسن المستدام", margin, y, contentWidth);
  y = drawTable({
    doc,
    rows: bestPracticeRows.slice(0, facilityRowCounts.bottomRows),
    columns: bestPracticeCols,
    x: margin,
    y,
    width: contentWidth,
    rowHeight: rowH,
    formatCell: formatBestPracticeCandidateCell,
  });
  y += gap;

  // ── Operational practices grid — visually and semantically separate from
  // the best-practice-candidate table above (spec): a fixed, pre-approved
  // set of generic suggestions, never a claim tied to this period's data. ──
  y = drawOperationalPracticesSection(doc, operationalPractices, margin, y, contentWidth);

  // ── "الاستنتاجات التنفيذية" (full-width) — replaces the old long
  // bullet-point box (spec §27). Self-sizing per row (never a fixed box
  // height), and page 4's own height was already planned (planPage4Layout,
  // via the same executiveConclusionsSectionHeight) to fit this exactly —
  // data-quality notes are intentionally not rendered in V2. ──
  drawExecutiveConclusionsSection(doc, executiveConclusions, margin, y, contentWidth);
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
      // Each page now has its own height (see V2Layout) — never a single
      // shared pageSize — so the footer's y must read the CURRENT page's
      // own height after switchToPage, not one page's height applied to all.
      layout.margin, doc.page.height - layout.margin - 12,
      { width: layout.contentWidth, align: "center", lineBreak: false }
    );
    doc.page.margins.bottom = origBottom;
  }
  resetInk(doc);
}

// ── Main entry point ─────────────────────────────────────────────────────────

const EMPTY_PERIOD_SNAPSHOT_METRICS: PeriodSnapshotMetrics = {
  receivedDuringPeriod: 0,
  closedDuringPeriod: 0,
  openAtEnd: 0,
  lateAtEnd: 0,
};

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
  classificationAffectedFacilityCounts: {},
  highPriorityFacilityCount: 0,
  continuedProblemFindingCount: 0,
  facilitiesNeedingFollowUp: [],
  bestPracticeCandidates: [],
  classificationTrends: [],
  operationalPractices: [],
  periodMetrics: { current: EMPTY_PERIOD_SNAPSHOT_METRICS, previous: null },
  regionSnapshotAtEnd: [],
  departmentPeriodMetrics: [],
  classificationSnapshotAtEnd: [],
};

function buildFallbackBrief(rawBrief: ReportData["briefData"]): ExecutiveBriefV2Data {
  if (!rawBrief) {
    return { ...EMPTY_V2 };
  }
  return {
    ...EMPTY_V2,
    ...rawBrief,
  };
}

export async function renderExecutiveBriefV2Pdf(data: ReportData): Promise<ExecutiveBriefV2PdfResult> {
  const warnings = [...data.warnings];
  const { regular, bold } = loadFonts();

  const rawBrief = data.briefData;
  const brief: ExecutiveBriefV2Data = rawBrief && isExecutiveBriefV2Data(rawBrief)
    ? rawBrief
    : buildFallbackBrief(rawBrief);

  const layout = createV2Layout();

  const doc = new PDFDocument({
    // Page 1 (cover) is always the base size — its content never scales
    // with region/practice counts. Pages 2-4 each get their own size below.
    size: [layout.pageWidth, BASE_PAGE_HEIGHT],
    margins: v2PageMargins(layout.margin),
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

    // Page 1 — cover, base size.
    renderCoverPage(ctx);

    // Page 2 — trend chart + notes, base size (content already adapts to
    // whatever room the base height leaves after the notes box).
    doc.addPage({ size: [layout.pageWidth, BASE_PAGE_HEIGHT], margins: v2PageMargins(layout.margin) });
    await renderPage2(ctx);

    // Page 3 — regions: the one page whose OWN content (cards/table) may
    // legitimately need more than base height. Never applied to any other page.
    const page3Height = computeV2Page3Height(brief.allRegions.length);
    doc.addPage({ size: [layout.pageWidth, page3Height], margins: v2PageMargins(layout.margin) });
    await renderPage3(ctx);

    // Page 4 — sized from its OWN actual content (classification/facility
    // tables + practices grid + conclusions), never from page 3's region
    // count. planPage4Layout is measurement-only (no drawing), using the
    // real `doc` before its page exists — renderPage4 below re-derives the
    // identical plan once page 4 is the current page (see planPage4Layout).
    const page4Height = planPage4Layout(doc, brief, layout.margin, layout.contentWidth).pageHeight;
    doc.addPage({ size: [layout.pageWidth, page4Height], margins: v2PageMargins(layout.margin) });
    renderPage4(ctx);

    drawFooters(doc, layout, warnings);
  } finally {
    endDoc();
  }

  return { buffer: await done, warnings };
}
