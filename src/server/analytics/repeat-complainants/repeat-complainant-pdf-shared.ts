/**
 * Shared PDFKit plumbing for the repeat-complainant PDF exports (bulk +
 * single-person). A real report/PDF service — never a screenshot of the UI
 * (spec §16): selectable text, real tables, RTL-correct via the same
 * `preparePdfText` every other report PDF in this codebase uses, headers,
 * footers, page numbers, and natural multi-page pagination (content simply
 * flows onto a new page — no fixed page-count budget like the V2 executive
 * brief).
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { REPORT_DESIGN_TOKENS, formatReportNumber } from "@/lib/reports/design-tokens";
import { preparePdfText } from "@/server/reports/arabic-pdf-text";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const COLORS = REPORT_DESIGN_TOKENS.colors;
const WORD_SPACING = REPORT_DESIGN_TOKENS.typography.wordSpacing;

const PAGE_SIZE: readonly [number, number] = [595.28, 841.89]; // A4 portrait, points
const MARGIN = 42;

let fontRegularBuffer: Buffer | null = null;
let fontBoldBuffer: Buffer | null = null;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!fontRegularBuffer) fontRegularBuffer = fs.readFileSync(FONT_REGULAR_PATH);
  if (!fontBoldBuffer) fontBoldBuffer = fs.readFileSync(FONT_BOLD_PATH);
  return { regular: fontRegularBuffer, bold: fontBoldBuffer };
}

export type RepeatPdfContext = {
  doc: PDFKit.PDFDocument;
  contentWidth: number;
  title: string;
  generatedAtLabel: string;
};

export function createRepeatPdfDocument(title: string): { doc: PDFKit.PDFDocument; done: Promise<Buffer> } {
  const { regular, bold } = loadFonts();
  const doc = new PDFDocument({
    size: [PAGE_SIZE[0], PAGE_SIZE[1]],
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
  return { doc, done };
}

export function drawPageTitle(doc: PDFKit.PDFDocument, title: string, subtitle?: string): number {
  const contentWidth = PAGE_SIZE[0] - MARGIN * 2;
  doc.rect(0, 0, PAGE_SIZE[0], 70).fill(COLORS.primary);
  doc.fillColor(COLORS.white).font("Bold").fontSize(18).text(
    preparePdfText(title), MARGIN, 22, { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  doc.fillColor(COLORS.primary);
  let y = 90;
  if (subtitle) {
    doc.font("Body").fontSize(10).fillColor(COLORS.neutral).text(
      preparePdfText(subtitle), MARGIN, y, { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
    );
    y += 20;
  }
  return y;
}

export function drawSectionHeading(doc: PDFKit.PDFDocument, text: string, y: number): number {
  const contentWidth = PAGE_SIZE[0] - MARGIN * 2;
  doc.font("Bold").fontSize(13).fillColor(COLORS.primary).text(
    preparePdfText(text), MARGIN, y, { width: contentWidth, align: "right", wordSpacing: WORD_SPACING }
  );
  return y + 22;
}

export function drawWarningBanner(doc: PDFKit.PDFDocument, text: string, y: number): number {
  const contentWidth = PAGE_SIZE[0] - MARGIN * 2;
  const r = REPORT_DESIGN_TOKENS.card.radius;
  const boxH = 40;
  doc.roundedRect(MARGIN, y, contentWidth, boxH, r).fillAndStroke("#FDECEC", COLORS.danger);
  doc.font("Bold").fontSize(10).fillColor(COLORS.danger).text(
    preparePdfText(text), MARGIN + 10, y + 10, { width: contentWidth - 20, align: "right", wordSpacing: WORD_SPACING }
  );
  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
  return y + boxH + 16;
}

export type PdfColDef = { key: string; label: string; weight: number };

/**
 * Auto-paginating table: draws a header row, then body rows, calling
 * `newPage()` (which itself must return the y to resume at) whenever a row
 * would overflow the page — real PDF pagination, not a fixed row budget.
 */
export function drawPaginatedTable<Row extends object>(options: {
  doc: PDFKit.PDFDocument;
  rows: readonly Row[];
  columns: readonly PdfColDef[];
  x: number;
  y: number;
  width: number;
  rowHeight: number;
  formatCell: (row: Row, key: string) => string;
  bottomLimit: number;
  newPage: () => number;
}): number {
  const { doc, rows, columns, x, width, rowHeight, formatCell, bottomLimit, newPage } = options;
  let y = options.y;

  const totalWeight = columns.reduce((s, c) => s + c.weight, 0);
  const widths = columns.map((c) => (width * c.weight) / totalWeight);
  const offsets: number[] = [];
  let cur = x + width;
  widths.forEach((w) => { cur -= w; offsets.push(cur); });

  const hdrH = rowHeight + 2;

  function drawHeader(atY: number): number {
    doc.roundedRect(x, atY, width, hdrH, REPORT_DESIGN_TOKENS.card.radius).fill(COLORS.primary);
    doc.font("Bold").fontSize(REPORT_DESIGN_TOKENS.fontSize.tableHeader).fillColor(COLORS.white);
    columns.forEach((col, i) => {
      doc.text(preparePdfText(col.label), offsets[i] + 4, atY + 5, {
        width: widths[i] - 8, height: hdrH - 7, align: "right", ellipsis: true, wordSpacing: WORD_SPACING,
      });
    });
    doc.fillColor(COLORS.primary);
    return atY + hdrH;
  }

  y = drawHeader(y);

  rows.forEach((row, ri) => {
    if (y + rowHeight > bottomLimit) {
      y = newPage();
      y = drawHeader(y);
    }
    if (ri % 2 === 1) doc.rect(x, y, width, rowHeight).fill(COLORS.tableRowAlternate);
    doc.moveTo(x, y + rowHeight).lineTo(x + width, y + rowHeight).strokeColor(COLORS.border).stroke();
    doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.table).fillColor(COLORS.primary);
    columns.forEach((col, i) => {
      doc.text(preparePdfText(formatCell(row, col.key)), offsets[i] + 4, y + 5, {
        width: widths[i] - 8, height: rowHeight - 6, align: "right", ellipsis: true, wordSpacing: WORD_SPACING,
      });
    });
    y += rowHeight;
  });

  doc.strokeColor(COLORS.primary).fillColor(COLORS.primary);
  return y;
}

export function drawFootersAndPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let pi = range.start; pi < range.start + range.count; pi++) {
    doc.switchToPage(pi);
    const pageNum = pi - range.start + 1;
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.footer).fillColor(COLORS.neutral);
    doc.text(
      preparePdfText(`صفحة ${formatReportNumber(pageNum)} من ${formatReportNumber(range.count)}`),
      MARGIN, PAGE_SIZE[1] - MARGIN - 10,
      { width: PAGE_SIZE[0] - MARGIN * 2, align: "center", lineBreak: false }
    );
    doc.page.margins.bottom = origBottom;
  }
  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
}

export const REPEAT_PDF_PAGE_SIZE = PAGE_SIZE;
export const REPEAT_PDF_MARGIN = MARGIN;
export const REPEAT_PDF_CONTENT_WIDTH = PAGE_SIZE[0] - MARGIN * 2;
export const REPEAT_PDF_BOTTOM_LIMIT = PAGE_SIZE[1] - MARGIN - 30;
