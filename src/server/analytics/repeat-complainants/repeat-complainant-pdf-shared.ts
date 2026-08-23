/**
 * Shared PDFKit plumbing for the repeat-complainant PDF exports (bulk +
 * single-person). A real report/PDF service — never a screenshot of the UI:
 * selectable text, real tables, RTL-correct via the same `preparePdfText`
 * every other report PDF in this codebase uses, embedded fonts, headers,
 * footers, page numbers, and natural multi-page pagination (content simply
 * flows onto a new page — no fixed page-count budget like the V2 executive
 * brief).
 *
 * Orientation-aware: `createRepeatPdfDocument` returns a `RepeatPdfContext`
 * carrying THIS document's own page dimensions — never a single global
 * portrait `PAGE_SIZE` constant — so the bulk (landscape) and single-person
 * (portrait) PDFs can share every drawing helper below without either one
 * silently inheriting the other's page shape.
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { REPORT_DESIGN_TOKENS, formatReportNumber } from "@/lib/reports/design-tokens";
import { preparePdfText, preparePdfTextLayout } from "@/server/reports/arabic-pdf-text";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const COLORS = REPORT_DESIGN_TOKENS.colors;
const WORD_SPACING = REPORT_DESIGN_TOKENS.typography.wordSpacing;

const A4_PORTRAIT: readonly [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: readonly [number, number] = [841.89, 595.28];
const MARGIN = 42;

let fontRegularBuffer: Buffer | null = null;
let fontBoldBuffer: Buffer | null = null;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!fontRegularBuffer) fontRegularBuffer = fs.readFileSync(FONT_REGULAR_PATH);
  if (!fontBoldBuffer) fontBoldBuffer = fs.readFileSync(FONT_BOLD_PATH);
  return { regular: fontRegularBuffer, bold: fontBoldBuffer };
}

export type PdfOrientation = "portrait" | "landscape";

/**
 * Everything a drawing helper needs to size itself to THIS document's own
 * page — never re-derived from a global constant. `bottomLimit` already
 * accounts for the footer/page-number strip, matching every existing call
 * site's own "leave room at the bottom" convention.
 */
export type RepeatPdfContext = {
  doc: PDFKit.PDFDocument;
  done: Promise<Buffer>;
  orientation: PdfOrientation;
  pageWidth: number;
  pageHeight: number;
  contentWidth: number;
  bottomLimit: number;
  margin: number;
};

/**
 * `orientation` defaults to "portrait" (the single-person PDF's own,
 * unchanged shape) — only the bulk PDF opts into "landscape". Both share
 * the exact same A4 area (just transposed), same fonts, same margins.
 */
export function createRepeatPdfDocument(
  title: string,
  options: { orientation?: PdfOrientation } = {}
): RepeatPdfContext {
  const orientation = options.orientation ?? "portrait";
  const [pageWidth, pageHeight] = orientation === "landscape" ? A4_LANDSCAPE : A4_PORTRAIT;
  const { regular, bold } = loadFonts();
  const doc = new PDFDocument({
    size: [pageWidth, pageHeight],
    margins: { top: MARGIN, bottom: MARGIN + 20, left: MARGIN, right: MARGIN },
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: title, Author: "تقارير الشكاوى", Subject: "تحليل تكرار الشكاوى" },
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

  return {
    doc,
    done,
    orientation,
    pageWidth,
    pageHeight,
    contentWidth: pageWidth - MARGIN * 2,
    bottomLimit: pageHeight - MARGIN - 30,
    margin: MARGIN,
  };
}

export function drawPageTitle(ctx: RepeatPdfContext, title: string, subtitle?: string): number {
  const { doc, pageWidth, contentWidth, margin } = ctx;
  doc.rect(0, 0, pageWidth, 70).fill(COLORS.primary);
  doc.fillColor(COLORS.white).font("Bold").fontSize(18).text(
    preparePdfText(title), margin, 22, { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  doc.fillColor(COLORS.primary);
  let y = 90;
  if (subtitle) {
    doc.font("Body").fontSize(10).fillColor(COLORS.neutral).text(
      preparePdfText(subtitle), margin, y, { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
    );
    y += 20;
  }
  return y;
}

export function drawSectionHeading(ctx: RepeatPdfContext, text: string, y: number): number {
  const { doc, contentWidth, margin } = ctx;
  doc.font("Bold").fontSize(13).fillColor(COLORS.primary).text(
    preparePdfText(text), margin, y, { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  return y + 22;
}

export function drawWarningBanner(ctx: RepeatPdfContext, text: string, y: number): number {
  const { doc, contentWidth, margin } = ctx;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const boxH = 40;
  doc.roundedRect(margin, y, contentWidth, boxH, r).fillAndStroke("#FDECEC", COLORS.danger);
  doc.font("Bold").fontSize(10).fillColor(COLORS.danger).text(
    preparePdfText(text), margin + 10, y + 10, { width: contentWidth - 20, align: "right", wordSpacing: WORD_SPACING }
  );
  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
  return y + boxH + 16;
}

/** True when `neededHeight` of content would NOT fit before `ctx.bottomLimit` — the shared "should I start a new page first" check every heading/table-start call site below uses, so a heading is never stranded alone at the bottom of a page. */
export function wouldOverflow(ctx: RepeatPdfContext, y: number, neededHeight: number): boolean {
  return y + neededHeight > ctx.bottomLimit;
}

/**
 * A boxed "سجن X — منطقة Y — N شخص · M شكوى" heading drawn once before a
 * facility's own people table, so the region/facility never has to repeat
 * on every row. Light background + border (design tokens), never plain
 * text — visually distinct from the smaller `drawSectionHeading`.
 */
export function drawFacilitySectionHeading(
  ctx: RepeatPdfContext,
  info: { facility: string; region: string; peopleCount: number; complaintsCount: number; continued?: boolean },
  y: number
): number {
  const { doc, contentWidth, margin } = ctx;
  const boxHeight = 46;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  doc.roundedRect(margin, y, contentWidth, boxHeight, r).fillAndStroke(COLORS.background, COLORS.border);
  doc.fillColor(COLORS.primary);

  const titleText = info.continued ? `${info.facility} — تابع` : info.facility;
  doc.font("Bold").fontSize(13).fillColor(COLORS.primary).text(
    preparePdfText(titleText), margin + 12, y + 7, { width: contentWidth - 24, align: "right", wordSpacing: WORD_SPACING, lineBreak: false, ellipsis: true }
  );
  doc.font("Body").fontSize(10).fillColor(COLORS.neutral).text(
    preparePdfText(info.region), margin + 12, y + 26, { width: contentWidth - 24, align: "right", wordSpacing: WORD_SPACING, lineBreak: false, ellipsis: true }
  );
  if (!info.continued) {
    const statsText = `${formatReportNumber(info.peopleCount)} شخصاً مكرراً · ${formatReportNumber(info.complaintsCount)} شكوى`;
    doc.font("Body").fontSize(10).fillColor(COLORS.neutral).text(
      preparePdfText(statsText), margin + 12, y + 26, { width: contentWidth - 24, align: "left", wordSpacing: WORD_SPACING, lineBreak: false }
    );
  }
  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
  return y + boxHeight + 10;
}

/**
 * Non-repeated region heading — drawn once before a run of consecutive
 * facility sections that all belong to the same region (spec: never repeat
 * "منطقة X" above every single facility).
 */
export function drawRegionHeading(ctx: RepeatPdfContext, region: string, y: number): number {
  const { doc, contentWidth, margin } = ctx;
  doc.font("Bold").fontSize(15).fillColor(COLORS.primary).text(
    preparePdfText(region), margin, y, { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  doc.moveTo(margin, y + 20).lineTo(margin + contentWidth, y + 20).strokeColor(COLORS.border).stroke();
  doc.strokeColor(COLORS.primary);
  return y + 30;
}

/** How a column handles text too wide for its own width — see `drawPaginatedTable`. */
export type ColumnOverflow =
  /** Single line; truncates with an ellipsis if too long (the pre-existing default behavior, still fine for short/fixed-format columns like dates or counts). */
  | "ellipsis"
  /** Wraps up to `maxLines` (default 2) lines; only falls back to an ellipsis if the text still doesn't fit after that — never silently drops content on the first line. Use for names and any other free-text column that must not be quietly truncated. */
  | "wrap"
  /** Never wraps, never truncates — the column must already be sized wide enough (used for the identity column: a masked or full identifier must always render completely). */
  | "none";

export type PdfColDef = {
  key: string;
  label: string;
  weight: number;
  overflow?: ColumnOverflow;
  maxLines?: number;
};

const DEFAULT_MAX_LINES = 2;
/** Row heights below this are never used, even for single-line rows — keeps body text from feeling cramped against its own row borders. */
const MIN_ROW_HEIGHT = 24;

/**
 * Auto-paginating table: draws a header row, then body rows, calling
 * `newPage()` (which itself must return the y to resume at) whenever a row
 * would overflow the page — real PDF pagination, never a fixed row budget,
 * and a row is NEVER split across two pages (its full height is measured
 * BEFORE it's drawn, so the "does it fit" check always sees the row's true
 * size). Row height is computed per row from whichever column actually
 * needs to wrap (see `ColumnOverflow`), not a single fixed constant — a
 * two-line wrapped name only costs the extra line height on ITS OWN row.
 */
export function drawPaginatedTable<Row extends object>(options: {
  doc: PDFKit.PDFDocument;
  rows: readonly Row[];
  columns: readonly PdfColDef[];
  x: number;
  y: number;
  width: number;
  bottomLimit: number;
  formatCell: (row: Row, key: string) => string;
  newPage: () => number;
}): number {
  const { doc, rows, columns, x, width, formatCell, bottomLimit, newPage } = options;
  let y = options.y;

  const totalWeight = columns.reduce((s, c) => s + c.weight, 0);
  const widths = columns.map((c) => (width * c.weight) / totalWeight);
  const offsets: number[] = [];
  let cur = x + width;
  widths.forEach((w) => { cur -= w; offsets.push(cur); });

  const headerFontSize = REPORT_DESIGN_TOKENS.fontSize.tableHeader;
  const bodyFontSize = REPORT_DESIGN_TOKENS.fontSize.table;
  // The REAL line height PDFKit itself uses for this font/size — never a
  // hand-picked multiplier (e.g. `fontSize * 1.25`), which measured
  // meaningfully SHORTER than Amiri's actual metrics and made a wrapped
  // 2-line row's allocated height fall short of what `preparePdfTextLayout`
  // then draws, so the row's own border/next row visually overlapped the
  // second line — the same `doc.currentLineHeight(true)` this file's own
  // `preparePdfTextLayout` calls (via arabic-pdf-text.ts) use internally,
  // so the height budgeted here and the height actually drawn always agree.
  doc.font("Body").fontSize(bodyFontSize);
  const lineHeight = doc.currentLineHeight(true);
  const cellPaddingV = 6; // top+bottom, matches the existing y+5 draw offset below
  const cellPaddingH = 8; // left+right (4 each side)
  const hdrH = Math.max(MIN_ROW_HEIGHT, Math.ceil(lineHeight) + cellPaddingV);

  function drawHeader(atY: number): number {
    doc.roundedRect(x, atY, width, hdrH, REPORT_DESIGN_TOKENS.card.radius).fill(COLORS.primary);
    doc.font("Bold").fontSize(headerFontSize).fillColor(COLORS.white);
    columns.forEach((col, i) => {
      doc.text(preparePdfText(col.label), offsets[i] + 4, atY + 6, {
        width: widths[i] - cellPaddingH, height: hdrH - 7, align: "right", ellipsis: true, wordSpacing: WORD_SPACING, lineBreak: false,
      });
    });
    doc.fillColor(COLORS.primary);
    return atY + hdrH;
  }

  y = drawHeader(y);

  rows.forEach((row, ri) => {
    doc.font("Body").fontSize(bodyFontSize);
    const rawTexts = columns.map((col) => formatCell(row, col.key));

    // Pre-wrap every "wrap" column's REAL text ONCE per row (never the old
    // width/availableWidth estimate) via `preparePdfTextLayout` — the same
    // helper report-cover.ts uses for multi-line Arabic titles. Doing this
    // up front (rather than re-wrapping at draw time) means the "how tall
    // is this row" measurement and the actual drawing always agree exactly,
    // and — critically — a wrap column is NEVER rendered by handing
    // `preparePdfText`'s single-line word-reversed output to PDFKit with
    // `lineBreak: true`: that would let PDFKit re-wrap already-reversed
    // text at arbitrary points, scrambling word order across lines (see
    // arabic-pdf-text.ts's own docstring on exactly this failure mode).
    const wrapLayouts = new Map<number, ReturnType<typeof preparePdfTextLayout>>();
    columns.forEach((col, i) => {
      if ((col.overflow ?? "ellipsis") !== "wrap") return;
      wrapLayouts.set(i, preparePdfTextLayout(doc, rawTexts[i], {
        width: widths[i] - cellPaddingH, align: "right", wordSpacing: WORD_SPACING,
      }));
    });

    const maxLinesNeeded = columns.reduce((max, col, i) => {
      const layout = wrapLayouts.get(i);
      if (!layout) return max;
      const cap = col.maxLines ?? DEFAULT_MAX_LINES;
      return Math.max(max, Math.min(layout.lines.length, cap));
    }, 1);
    const rowHeight = Math.max(MIN_ROW_HEIGHT, maxLinesNeeded * lineHeight + cellPaddingV);

    if (y + rowHeight > bottomLimit) {
      y = newPage();
      y = drawHeader(y);
    }
    if (ri % 2 === 1) doc.rect(x, y, width, rowHeight).fill(COLORS.tableRowAlternate);
    doc.moveTo(x, y + rowHeight).lineTo(x + width, y + rowHeight).strokeColor(COLORS.border).stroke();
    doc.font("Body").fontSize(bodyFontSize).fillColor(COLORS.primary);
    columns.forEach((col, i) => {
      const overflow = col.overflow ?? "ellipsis";
      const cellX = offsets[i] + 4;
      const cellWidth = widths[i] - cellPaddingH;

      if (overflow === "wrap") {
        const layout = wrapLayouts.get(i)!;
        const cap = col.maxLines ?? DEFAULT_MAX_LINES;
        const visibleLines = layout.lines.slice(0, cap);
        const isTruncated = layout.lines.length > cap;
        visibleLines.forEach((line, li) => {
          const lineY = y + 5 + li * layout.lineHeight;
          if (isTruncated && li === visibleLines.length - 1) {
            // More content follows beyond what fits in `cap` lines — render
            // this LAST visible line plus everything after it as one
            // ellipsis-truncated single line, so the "…" is genuine (the
            // combined text always overflows the column, unlike re-flagging
            // an already-fitted wrapped line as ellipsis, which would
            // truncate nothing since it already fits).
            const remainingLogical = layout.lines.slice(li).map((l) => l.logicalText).join(" ");
            doc.text(preparePdfText(remainingLogical), cellX, lineY, {
              width: cellWidth, align: "right", wordSpacing: WORD_SPACING, lineBreak: false, ellipsis: true,
            });
          } else {
            doc.text(line.visualText, cellX, lineY, {
              width: cellWidth, align: "right", wordSpacing: WORD_SPACING, lineBreak: false,
            });
          }
        });
        return;
      }

      // "ellipsis" and "none" are both single-line renders — preparePdfText's
      // single-line word reversal is exactly right for them (no PDFKit
      // wrapping ever happens for either mode).
      doc.text(preparePdfText(rawTexts[i]), cellX, y + 5, {
        width: cellWidth,
        height: rowHeight - (cellPaddingV - 1),
        align: "right",
        wordSpacing: WORD_SPACING,
        ellipsis: overflow === "ellipsis",
        lineBreak: false,
      });
    });
    y += rowHeight;
  });

  doc.strokeColor(COLORS.primary).fillColor(COLORS.primary);
  return y;
}

export function drawFootersAndPageNumbers(ctx: RepeatPdfContext): void {
  const { doc, pageWidth, pageHeight, margin } = ctx;
  const range = doc.bufferedPageRange();
  for (let pi = range.start; pi < range.start + range.count; pi++) {
    doc.switchToPage(pi);
    const pageNum = pi - range.start + 1;
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.footer).fillColor(COLORS.neutral);
    doc.text(
      preparePdfText(`صفحة ${formatReportNumber(pageNum)} من ${formatReportNumber(range.count)}`),
      margin, pageHeight - margin - 10,
      { width: pageWidth - margin * 2, align: "center", lineBreak: false }
    );
    doc.page.margins.bottom = origBottom;
  }
  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
}

/**
 * Formats one table cell's raw value for display when accessed through a
 * generic `Record<string, unknown>` index (every actual column is typed
 * string/number on its own row type, but `drawPaginatedTable`'s `formatCell`
 * callback signature erases that). Makes the string/number/nullish cases
 * explicit instead of a blind `String(value ?? "—")`, which would silently
 * render `[object Object]` for anything that isn't actually one of those.
 */
export function formatScalarCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return formatReportNumber(value);
  if (typeof value === "string") return value;
  return "—";
}
