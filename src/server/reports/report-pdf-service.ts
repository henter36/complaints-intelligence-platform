import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { getReportDefinition } from "./report-definition-service";
import type { ReportData, ReportKpiCard, ReportTable } from "./report-data-service";
import { formatRiyadhDateTime } from "./report-time";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");
const LOGO_PATH = path.join(process.cwd(), "public/logo.svg");

const PAGE_MARGIN = 40;
const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4 points
const CONTENT_WIDTH = PAGE_SIZE[0] - PAGE_MARGIN * 2;
const FOOTER_HEIGHT = 30;

let fontRegularBuffer: Buffer | null = null;
let fontBoldBuffer: Buffer | null = null;
let logoPngBuffer: Buffer | null | undefined;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!fontRegularBuffer) fontRegularBuffer = fs.readFileSync(FONT_REGULAR_PATH);
  if (!fontBoldBuffer) fontBoldBuffer = fs.readFileSync(FONT_BOLD_PATH);
  return { regular: fontRegularBuffer, bold: fontBoldBuffer };
}

async function loadLogoPng(): Promise<Buffer | null> {
  if (logoPngBuffer !== undefined) return logoPngBuffer;
  try {
    const svg = fs.readFileSync(LOGO_PATH);
    logoPngBuffer = await sharp(svg).resize(64, 64, { fit: "contain" }).png().toBuffer();
  } catch {
    logoPngBuffer = null;
  }
  return logoPngBuffer;
}

const KPI_FORMAT_SUFFIX: Record<ReportKpiCard["format"], string> = {
  number: "",
  percent: "%",
  days: " يوم",
  hours: " ساعة",
};

function formatKpiValue(card: ReportKpiCard): string {
  const value = Number.isInteger(card.value) ? String(card.value) : card.value.toFixed(1);
  return `${value}${KPI_FORMAT_SUFFIX[card.format]}`;
}

/** Renders any value to text, without relying on the default
 * `[object Object]` stringification of a bare template-literal/String() call. */
function toDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function formatCellValue(value: unknown, format?: "number" | "percent" | "date" | "text"): string {
  if (value === null || value === undefined || value === "") return "-";
  if (format === "percent") return `${toDisplayText(value)}%`;
  if (format === "date") {
    const date = new Date(toDisplayText(value));
    if (Number.isNaN(date.getTime())) return "-";
    return date.toISOString().slice(0, 10);
  }
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  return toDisplayText(value);
}

export type PdfRenderResult = {
  buffer: Buffer;
  warnings: string[];
};

export async function renderReportPdf(data: ReportData): Promise<PdfRenderResult> {
  const { regular, bold } = loadFonts();
  const warnings = [...data.warnings];
  const definition = getReportDefinition(data.type);

  const doc = new PDFDocument({
    size: PAGE_SIZE,
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN + FOOTER_HEIGHT, left: PAGE_MARGIN, right: PAGE_MARGIN },
    bufferPages: true,
    info: {
      Title: data.title,
      Author: "نظام ذكاء الشكاوى",
      Subject: definition.description,
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

  const logo = await loadLogoPng();

  renderHeader(doc, data, logo);
  renderFilters(doc, data);

  for (const section of data.sections) {
    ensureSpace(doc, 60);
    if (section.kind === "kpi") {
      drawSectionTitle(doc, section.title);
      drawKpiGrid(doc, section.cards);
    } else {
      drawSectionTitle(doc, section.title);
      try {
        drawTable(doc, section.table);
      } catch {
        warnings.push(`تعذر عرض جدول "${section.title}" بالكامل.`);
      }
      if (section.table.truncated) {
        doc.moveDown(0.2);
        doc.font("Body").fontSize(8).fillColor("#b45309");
        doc.text(
          `تم عرض ${section.table.rows.length} من أصل ${section.table.totalMatched} صفاً.`,
          { align: "right" }
        );
        doc.fillColor("#000000");
      }
    }
    doc.moveDown(0.8);
  }

  // Rendered last, so it reflects any render-time failures collected while
  // walking the sections above, not just the warnings the report started with.
  if (warnings.length > 0) {
    renderWarnings(doc, warnings);
  }

  drawFooters(doc, data.title);
  doc.end();

  const buffer = await done;
  return { buffer, warnings };
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function renderHeader(doc: PDFKit.PDFDocument, data: ReportData, logo: Buffer | null): void {
  const top = doc.y;
  if (logo) {
    try {
      doc.image(logo, PAGE_MARGIN, top, { width: 40, height: 40 });
    } catch {
      // Logo is decorative; a failure here must not fail the report.
    }
  }

  doc.font("Bold").fontSize(18).fillColor("#0f172a");
  doc.text(data.title, PAGE_MARGIN, top, { width: CONTENT_WIDTH, align: "right" });

  doc.font("Body").fontSize(10).fillColor("#475569");
  doc.text(getReportDefinition(data.type).description, { width: CONTENT_WIDTH, align: "right" });
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor("#0f172a");
  doc.text(`الفترة: من ${data.period.from} إلى ${data.period.to}`, { width: CONTENT_WIDTH, align: "right" });
  doc.text(`تاريخ الإنشاء: ${formatRiyadhDateTime(new Date(data.generatedAt))}`, {
    width: CONTENT_WIDTH,
    align: "right",
  });
  doc.fillColor("#000000");
  doc.moveDown(0.6);

  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_SIZE[0] - PAGE_MARGIN, doc.y).strokeColor("#cbd5e1").stroke();
  doc.strokeColor("#000000");
  doc.moveDown(0.6);
}

function renderFilters(doc: PDFKit.PDFDocument, data: ReportData): void {
  const entries = Object.entries(data.filters).filter(([key, value]) => key !== "from" && key !== "to" && value);
  if (entries.length === 0) return;
  const labels: Record<string, string> = {
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
  const text = entries.map(([key, value]) => `${labels[key] ?? key}: ${String(value)}`).join(" | ");
  doc.font("Body").fontSize(9).fillColor("#475569");
  doc.text(`الفلاتر المطبقة: ${text}`, { width: CONTENT_WIDTH, align: "right" });
  doc.fillColor("#000000");
  doc.moveDown(0.6);
}

function renderWarnings(doc: PDFKit.PDFDocument, warnings: string[]): void {
  ensureSpace(doc, 20 + warnings.length * 14);
  doc.font("Bold").fontSize(9).fillColor("#92400e");
  doc.text("تنبيهات:", { width: CONTENT_WIDTH, align: "right" });
  doc.font("Body").fontSize(9);
  for (const warning of warnings) {
    doc.text(`• ${warning}`, { width: CONTENT_WIDTH, align: "right" });
  }
  doc.fillColor("#000000");
  doc.moveDown(0.6);
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 24);
  doc.font("Bold").fontSize(13).fillColor("#0f172a");
  doc.text(title, { width: CONTENT_WIDTH, align: "right" });
  doc.fillColor("#000000");
  doc.moveDown(0.3);
}

function drawKpiGrid(doc: PDFKit.PDFDocument, cards: ReportKpiCard[]): void {
  const columns = 3;
  const gap = 10;
  const cardWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const cardHeight = 46;

  for (let i = 0; i < cards.length; i += columns) {
    ensureSpace(doc, cardHeight + 8);
    const rowCards = cards.slice(i, i + columns);
    const rowTop = doc.y;
    rowCards.forEach((card, index) => {
      // Right-to-left grid: first card sits at the rightmost slot.
      const slot = rowCards.length - 1 - index;
      const x = PAGE_MARGIN + slot * (cardWidth + gap);
      doc.roundedRect(x, rowTop, cardWidth, cardHeight, 4).fillAndStroke("#f8fafc", "#e2e8f0");
      doc.font("Body").fontSize(8).fillColor("#64748b");
      doc.text(card.label, x + 6, rowTop + 6, {
        width: cardWidth - 12,
        height: 14,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
      doc.font("Bold").fontSize(14).fillColor("#0f172a");
      doc.text(formatKpiValue(card), x + 6, rowTop + 20, {
        width: cardWidth - 12,
        height: 18,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.fillColor("#000000").strokeColor("#000000");
    doc.y = rowTop + cardHeight + 8;
  }
}

function drawTable(doc: PDFKit.PDFDocument, table: ReportTable): void {
  if (table.columns.length === 0 || table.rows.length === 0) {
    doc.font("Body").fontSize(9).fillColor("#64748b");
    doc.text("لا توجد بيانات لعرضها.", { width: CONTENT_WIDTH, align: "right" });
    doc.fillColor("#000000");
    return;
  }

  const columns = table.columns;
  const colWidth = CONTENT_WIDTH / columns.length;
  const rowHeight = 18;
  const headerHeight = 20;

  function drawHeaderRow(): void {
    const top = doc.y;
    doc.font("Bold").fontSize(8.5).fillColor("#0f172a");
    columns.forEach((column, index) => {
      const slot = columns.length - 1 - index;
      const x = PAGE_MARGIN + slot * colWidth;
      doc.text(column.label, x + 2, top + 4, {
        width: colWidth - 4,
        height: headerHeight - 6,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.y = top + headerHeight;
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_SIZE[0] - PAGE_MARGIN, doc.y).strokeColor("#94a3b8").stroke();
    doc.strokeColor("#000000");
    doc.fillColor("#000000");
  }

  ensureSpace(doc, headerHeight + rowHeight);
  drawHeaderRow();

  doc.font("Body").fontSize(8.5);
  table.rows.forEach((row, rowIndex) => {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeaderRow();
      doc.font("Body").fontSize(8.5);
    }
    const top = doc.y;
    if (rowIndex % 2 === 1) {
      doc.rect(PAGE_MARGIN, top, CONTENT_WIDTH, rowHeight).fill("#f8fafc");
      doc.fillColor("#000000");
    }
    columns.forEach((column, index) => {
      const slot = columns.length - 1 - index;
      const x = PAGE_MARGIN + slot * colWidth;
      const value = formatCellValue(row[column.key], column.format);
      doc.text(value, x + 2, top + 4, {
        width: colWidth - 4,
        height: rowHeight - 6,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.y = top + rowHeight;
  });
}

function drawFooters(doc: PDFKit.PDFDocument, title: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const pageNumber = i - range.start + 1;
    const y = doc.page.height - PAGE_MARGIN - 14;
    doc.font("Body").fontSize(8).fillColor("#64748b");
    doc.text(
      `${title} — تم إنشاؤه بواسطة نظام ذكاء الشكاوى — صفحة ${pageNumber} من ${range.count}`,
      PAGE_MARGIN,
      y,
      { width: CONTENT_WIDTH, align: "center" }
    );
    doc.fillColor("#000000");
  }
}
