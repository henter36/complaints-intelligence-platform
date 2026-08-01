/**
 * PDF renderer for executive brief modes.
 *
 * DIGITAL_EXECUTIVE_BRIEF  → 16:9 widescreen slides (1440×810 pt), 3 pages.
 * PRINT_EXECUTIVE_BRIEF    → A4 landscape (841.89×595.28 pt), 3 pages target.
 *
 * Page layout:
 *   Page 1 — Header + 8 KPI cards (2 rows × 4) + executive summary bullets
 *             + comparative bar chart (current vs previous totals by region)
 *   Page 2 — All reference regions table (Left Join) with summary row
 *   Page 3 — Top 8 classifications + comparative timeline chart
 */

import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { getReportDefinition } from "./report-definition-service";
import type { ReportData } from "./report-data-service";
import type {
  ExecutiveBriefKpiCard,
  RegionReferenceRow,
  ClassificationBriefRow,
  ComparativeTimelineData,
} from "@/lib/reports/report-contract";
import { renderLineChartPng } from "./report-chart-service";
import { formatRiyadhDateTime } from "./report-time";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");

// Page sizes in points (width × height)
const PAGE_16x9: [number, number] = [1440, 810];   // digital widescreen
const PAGE_A4L: [number, number] = [841.89, 595.28]; // A4 landscape

const SLIDE_MARGIN = 48;
const PRINT_MARGIN = 36;

// Palette
const COLOR_DARK = "#0f172a";
const COLOR_MID = "#334155";
const COLOR_MUTED = "#64748b";
const COLOR_BORDER = "#e2e8f0";
const COLOR_CARD_BG = "#f8fafc";
const COLOR_POSITIVE = "#15803d";
const COLOR_NEGATIVE = "#b91c1c";
const COLOR_WARNING = "#b45309";
const COLOR_NEUTRAL = "#475569";

let fontRegularBuffer: Buffer | null = null;
let fontBoldBuffer: Buffer | null = null;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!fontRegularBuffer) fontRegularBuffer = fs.readFileSync(FONT_REGULAR_PATH);
  if (!fontBoldBuffer) fontBoldBuffer = fs.readFileSync(FONT_BOLD_PATH);
  return { regular: fontRegularBuffer, bold: fontBoldBuffer };
}

function assessmentColor(assessment: ExecutiveBriefKpiCard["assessment"]): string {
  switch (assessment) {
    case "positive": return COLOR_POSITIVE;
    case "negative": return COLOR_NEGATIVE;
    case "warning": return COLOR_WARNING;
    default: return COLOR_NEUTRAL;
  }
}

function formatValue(value: number, format: ExecutiveBriefKpiCard["format"]): string {
  if (format === "percent") return `${value.toFixed(1)}%`;
  if (format === "days") return `${Number.isInteger(value) ? value : value.toFixed(1)} يوم`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatSigned(n: number | null): string {
  if (n === null) return "";
  if (n > 0) return `+${n}`;
  return String(n);
}

function shortRunId(runId?: string): string {
  return runId ? runId.slice(0, 8) : "";
}

export type ExecutiveBriefPdfResult = {
  buffer: Buffer;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function renderExecutiveBriefPdf(
  data: ReportData,
  mode: "DIGITAL_EXECUTIVE_BRIEF" | "PRINT_EXECUTIVE_BRIEF"
): Promise<ExecutiveBriefPdfResult> {
  const warnings = [...data.warnings];
  const { regular, bold } = loadFonts();

  const isWidescreen = mode === "DIGITAL_EXECUTIVE_BRIEF";
  const pageSize = isWidescreen ? PAGE_16x9 : PAGE_A4L;
  const margin = isWidescreen ? SLIDE_MARGIN : PRINT_MARGIN;
  const contentW = pageSize[0] - margin * 2;

  const doc = new PDFDocument({
    size: pageSize,
    margins: { top: margin, bottom: margin + 24, left: margin, right: margin },
    bufferPages: true,
    info: {
      Title: data.title,
      Author: "نظام ذكاء الشكاوى",
      Subject: getReportDefinition(data.type).description,
      Keywords: mode,
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

  const briefData = data.briefData;
  if (!briefData) {
    // Fallback: render a minimal single-page placeholder.
    doc.font("Bold").fontSize(20).fillColor(COLOR_DARK);
    doc.text(data.title, margin, margin, { width: contentW, align: "right" });
    doc.end();
    const buffer = await done;
    return { buffer, warnings };
  }

  // Page 1: KPIs + executive summary + comparative bar chart
  await renderPage1(doc, data, briefData.briefKpis, warnings, pageSize, margin, contentW);

  // Page 2: All reference regions table
  doc.addPage();
  renderPage2(doc, data, briefData.allRegions, pageSize, margin, contentW);

  // Page 3: Top 8 classifications + comparative timeline
  doc.addPage();
  await renderPage3(doc, data, briefData.topClassifications, briefData.comparativeTimeline, warnings, pageSize, margin, contentW);

  drawBriefFooters(doc, data.title, shortRunId(data.reportRunId), margin, pageSize, contentW);

  doc.end();
  const buffer = await done;
  return { buffer, warnings };
}

// ---------------------------------------------------------------------------
// Page 1 — KPIs + executive summary + region bar chart
// ---------------------------------------------------------------------------

async function renderPage1(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  briefKpis: ExecutiveBriefKpiCard[],
  warnings: string[],
  pageSize: [number, number],
  margin: number,
  contentW: number
): Promise<void> {
  let y = margin;

  // ── Header ──────────────────────────────────────────────────────────────
  doc.font("Bold").fontSize(22).fillColor(COLOR_DARK);
  doc.text(data.title, margin, y, { width: contentW, align: "right" });
  y += 30;

  doc.font("Body").fontSize(10).fillColor(COLOR_MUTED);
  const periodLine = `الفترة: ${data.period.from} – ${data.period.to}`;
  const genLine = `تاريخ الإنشاء: ${formatRiyadhDateTime(new Date(data.generatedAt))}`;
  doc.text(`${periodLine}   |   ${genLine}`, margin, y, { width: contentW, align: "right" });
  y += 18;

  // ── Separator ───────────────────────────────────────────────────────────
  doc
    .moveTo(margin, y)
    .lineTo(pageSize[0] - margin, y)
    .strokeColor(COLOR_BORDER)
    .stroke();
  doc.strokeColor("#000000");
  y += 12;

  // ── 8 KPI cards — 4 per row ─────────────────────────────────────────────
  const cards = briefKpis.slice(0, 8);
  const cols = 4;
  const gap = 10;
  const cardW = (contentW - gap * (cols - 1)) / cols;
  const cardH = 72;

  for (let row = 0; row < 2; row++) {
    const rowCards = cards.slice(row * cols, (row + 1) * cols);
    rowCards.forEach((card, col) => {
      // RTL: rightmost slot = col index 0
      const slot = cols - 1 - col;
      const x = margin + slot * (cardW + gap);
      const cardY = y;

      doc.roundedRect(x, cardY, cardW, cardH, 5).fillAndStroke(COLOR_CARD_BG, COLOR_BORDER);
      doc.fillColor("#000000").strokeColor("#000000");

      // Label
      doc.font("Body").fontSize(8.5).fillColor(COLOR_MUTED);
      doc.text(card.label, x + 8, cardY + 8, {
        width: cardW - 16,
        height: 14,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });

      // Value
      doc.font("Bold").fontSize(18).fillColor(COLOR_DARK);
      doc.text(formatValue(card.value, card.format), x + 8, cardY + 22, {
        width: cardW - 16,
        height: 24,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });

      // Difference / change rate
      if (card.difference !== null) {
        const deltaText =
          `${formatSigned(card.difference)}` +
          (card.changeRate !== null ? `  (${card.changeRate > 0 ? "+" : ""}${card.changeRate}%)` : "");
        doc.font("Body").fontSize(8).fillColor(assessmentColor(card.assessment));
        doc.text(deltaText, x + 8, cardY + 48, {
          width: cardW - 16,
          height: 14,
          align: "right",
          lineBreak: false,
          ellipsis: true,
        });
      }
    });
    y += cardH + 10;
  }

  y += 4;

  // ── Executive summary points ─────────────────────────────────────────────
  const textSection = data.sections.find((s) => s.kind === "text");
  if (textSection?.kind === "text" && textSection.points.length > 0) {
    doc.font("Bold").fontSize(11).fillColor(COLOR_DARK);
    doc.text("الملخص التنفيذي", margin, y, { width: contentW, align: "right" });
    y += 16;

    const points = textSection.points.slice(0, 5);
    for (const point of points) {
      if (!point?.trim()) continue;
      doc.font("Body").fontSize(9.5).fillColor(COLOR_MID);
      doc.text(`• ${point}`, margin + 8, y, { width: contentW - 8, align: "right" });
      y += 16;
    }
  }

  y += 6;

  // ── Comparative bar chart (current vs previous per region) ───────────────
  const comparisonSection = data.comparisonData;
  if (comparisonSection && y < pageSize[1] - margin - 40) {
    const availableH = pageSize[1] - margin - 24 - y - 20;
    const chartW = Math.round(contentW);
    const chartH = Math.max(120, Math.round(availableH));

    doc.font("Bold").fontSize(11).fillColor(COLOR_DARK);
    doc.text("مقارنة الشكاوى بالمناطق", margin, y, { width: contentW, align: "right" });
    y += 16;

    // Build a simple chart from region changes
    const regionChanges = comparisonSection.regionChanges.slice(0, 8);
    if (regionChanges.length > 0) {
      const chartSection = {
        id: "brief_region_bar",
        kind: "chart" as const,
        chartType: "line" as const,
        title: "مقارنة الشكاوى بالمناطق",
        series: [
          {
            name: "الفترة الحالية",
            points: regionChanges.map((r, i) => ({ x: String(i + 1), y: r.currentCount })),
          },
          {
            name: "الفترة السابقة",
            points: regionChanges.map((r, i) => ({ x: String(i + 1), y: r.previousCount })),
          },
        ],
      };

      try {
        const png = await renderLineChartPng(chartSection, chartW, chartH);
        doc.image(png, margin, y, { width: contentW, height: availableH });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        warnings.push(`تعذر رسم مخطط المناطق: ${reason}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Page 2 — All reference regions table
// ---------------------------------------------------------------------------

const REGION_TABLE_COLUMNS: Array<{ key: keyof RegionReferenceRow | "idx"; label: string; width: number }> = [
  { key: "regionName", label: "المنطقة", width: 110 },
  { key: "currentCount", label: "الحالي", width: 55 },
  { key: "previousCount", label: "السابق", width: 55 },
  { key: "difference", label: "الفرق", width: 55 },
  { key: "changeRate", label: "التغير%", width: 55 },
  { key: "complianceRate", label: "الالتزام%", width: 60 },
  { key: "averageResolutionDays", label: "متوسط الإغلاق", width: 70 },
  { key: "currentlyLate", label: "المتأخرة", width: 55 },
  { key: "direction", label: "الاتجاه", width: 70 },
];

function formatRegionCell(row: RegionReferenceRow, key: string): string {
  const value = row[key as keyof RegionReferenceRow];
  if (value === null || value === undefined) return "-";
  if (key === "changeRate" || key === "complianceRate") {
    return typeof value === "number" ? `${value.toFixed(1)}%` : "-";
  }
  if (key === "difference") {
    const n = typeof value === "number" ? value : 0;
    return n > 0 ? `+${n}` : String(n);
  }
  if (key === "averageResolutionDays") {
    return typeof value === "number" ? value.toFixed(1) : "-";
  }
  return String(value);
}

function renderPage2(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  allRegions: RegionReferenceRow[],
  pageSize: [number, number],
  margin: number,
  contentW: number
): void {
  let y = margin;

  // Page header
  doc.font("Bold").fontSize(16).fillColor(COLOR_DARK);
  doc.text("جميع المناطق — مقارنة الفترة الحالية بالسابقة", margin, y, {
    width: contentW,
    align: "right",
  });
  y += 24;

  doc.font("Body").fontSize(9).fillColor(COLOR_MUTED);
  doc.text(
    `شاملة جميع المناطق التي سجّلت شكاوى على الإطلاق (الفترة: ${data.period.from} – ${data.period.to})`,
    margin,
    y,
    { width: contentW, align: "right" }
  );
  y += 16;

  // Table
  const cols = REGION_TABLE_COLUMNS;
  const totalTableW = cols.reduce((s, c) => s + c.width, 0);
  const scaleFactor = contentW / totalTableW;
  const scaledWidths = cols.map((c) => c.width * scaleFactor);

  // Compute x offsets (RTL: first column at right edge)
  const xOffsets: number[] = [];
  {
    let cursor = pageSize[0] - margin;
    for (const w of scaledWidths) {
      cursor -= w;
      xOffsets.push(cursor);
    }
  }

  const headerH = 20;
  const rowH = 14;
  const fontSize = 7.5;

  function drawHeader(): void {
    doc.font("Bold").fontSize(fontSize).fillColor(COLOR_DARK);
    cols.forEach((col, ci) => {
      doc.text(col.label, xOffsets[ci] + 2, y + 4, {
        width: scaledWidths[ci] - 4,
        height: headerH - 6,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    y += headerH;
    doc.moveTo(margin, y).lineTo(pageSize[0] - margin, y).strokeColor("#94a3b8").stroke();
    doc.strokeColor("#000000");
  }

  drawHeader();

  // Summary totals
  const totalCurrent = allRegions.reduce((s, r) => s + r.currentCount, 0);
  const totalPrevious = allRegions.reduce((s, r) => s + r.previousCount, 0);
  const totalDiff = totalCurrent - totalPrevious;

  // Rows
  allRegions.forEach((row, ri) => {
    if (y + rowH > pageSize[1] - margin - 24) {
      doc.addPage();
      y = margin;
      drawHeader();
    }
    if (ri % 2 === 1) {
      doc.rect(margin, y, contentW, rowH).fill(COLOR_CARD_BG);
      doc.fillColor("#000000");
    }
    doc.font("Body").fontSize(fontSize).fillColor(COLOR_DARK);
    cols.forEach((col, ci) => {
      const text = formatRegionCell(row, col.key);
      const isDirectionCol = col.key === "direction";
      const color = isDirectionCol
        ? row.currentCount > row.previousCount
          ? COLOR_NEGATIVE
          : row.currentCount < row.previousCount
            ? COLOR_POSITIVE
            : COLOR_MUTED
        : COLOR_DARK;
      doc.fillColor(color);
      doc.text(text, xOffsets[ci] + 2, y + 2, {
        width: scaledWidths[ci] - 4,
        height: rowH - 2,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.fillColor(COLOR_DARK);
    y += rowH;
  });

  // Summary row
  y += 4;
  doc.moveTo(margin, y).lineTo(pageSize[0] - margin, y).strokeColor("#94a3b8").stroke();
  doc.strokeColor("#000000");
  y += 4;

  doc.font("Bold").fontSize(fontSize).fillColor(COLOR_DARK);
  const summaryRow: Partial<RegionReferenceRow> = {
    regionName: "الإجمالي",
    currentCount: totalCurrent,
    previousCount: totalPrevious,
    difference: totalDiff,
  };
  cols.forEach((col, ci) => {
    const val = summaryRow[col.key as keyof RegionReferenceRow];
    let text = "-";
    if (col.key === "regionName") text = "الإجمالي";
    else if (col.key === "difference") {
      text = totalDiff > 0 ? `+${totalDiff}` : String(totalDiff);
    } else if (val !== undefined && val !== null) {
      text = String(val);
    }
    doc.text(text, xOffsets[ci] + 2, y + 2, {
      width: scaledWidths[ci] - 4,
      height: 14,
      align: "right",
      lineBreak: false,
      ellipsis: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Page 3 — Top 8 classifications + comparative timeline
// ---------------------------------------------------------------------------

async function renderPage3(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  topClassifications: ClassificationBriefRow[],
  comparativeTimeline: ComparativeTimelineData,
  warnings: string[],
  pageSize: [number, number],
  margin: number,
  contentW: number
): Promise<void> {
  let y = margin;

  // ── Page header ───────────────────────────────────────────────────────────
  doc.font("Bold").fontSize(16).fillColor(COLOR_DARK);
  doc.text("أبرز التصنيفات والاتجاه الزمني المقارن", margin, y, {
    width: contentW,
    align: "right",
  });
  y += 24;

  // ── Top 8 classifications table ───────────────────────────────────────────
  const classCols: Array<{ key: keyof ClassificationBriefRow; label: string; flex: boolean }> = [
    { key: "classificationName", label: "التصنيف", flex: true },
    { key: "currentCount", label: "الحالي", flex: false },
    { key: "previousCount", label: "السابق", flex: false },
    { key: "difference", label: "الفرق", flex: false },
    { key: "shareOfTotal", label: "النسبة%", flex: false },
  ];

  const fixedW = 52;
  const flexCount = classCols.filter((c) => c.flex).length;
  const fixedTotal = classCols.filter((c) => !c.flex).length * fixedW;
  const flexW = (contentW - fixedTotal) / Math.max(1, flexCount);
  const classWidths = classCols.map((c) => (c.flex ? flexW : fixedW));

  const classXOffsets: number[] = [];
  {
    let cursor = pageSize[0] - margin;
    for (const w of classWidths) {
      cursor -= w;
      classXOffsets.push(cursor);
    }
  }

  const classHeaderH = 18;
  const classRowH = 14;
  const classFontSize = 8;

  doc.font("Bold").fontSize(classFontSize).fillColor(COLOR_DARK);
  classCols.forEach((col, ci) => {
    doc.text(col.label, classXOffsets[ci] + 2, y + 3, {
      width: classWidths[ci] - 4,
      height: classHeaderH - 4,
      align: "right",
      lineBreak: false,
      ellipsis: true,
    });
  });
  y += classHeaderH;
  doc.moveTo(margin, y).lineTo(pageSize[0] - margin, y).strokeColor("#94a3b8").stroke();
  doc.strokeColor("#000000");

  topClassifications.forEach((row, ri) => {
    if (ri % 2 === 1) {
      doc.rect(margin, y, contentW, classRowH).fill(COLOR_CARD_BG);
      doc.fillColor("#000000");
    }
    doc.font("Body").fontSize(classFontSize).fillColor(COLOR_DARK);
    classCols.forEach((col, ci) => {
      let text = "-";
      const val = row[col.key];
      if (col.key === "difference") {
        const n = typeof val === "number" ? val : 0;
        text = n > 0 ? `+${n}` : String(n);
      } else if (col.key === "shareOfTotal" && typeof val === "number") {
        text = `${val.toFixed(1)}%`;
      } else if (val !== null && val !== undefined) {
        text = String(val);
      }
      doc.text(text, classXOffsets[ci] + 2, y + 2, {
        width: classWidths[ci] - 4,
        height: classRowH - 2,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
    });
    y += classRowH;
  });

  y += 16;

  // ── Comparative timeline chart ─────────────────────────────────────────────
  const availableH = pageSize[1] - margin - 24 - y - 20;
  if (availableH < 60) {
    // Not enough space — skip the chart
    return;
  }

  doc.font("Bold").fontSize(11).fillColor(COLOR_DARK);
  doc.text("الاتجاه الزمني المقارن (يوم بيوم)", margin, y, {
    width: contentW,
    align: "right",
  });
  y += 16;

  const chartW = Math.round(contentW);
  const chartH = Math.max(80, Math.round(availableH));

  const timelineSeries: Array<{ name: string; points: { x: string; y: number }[] }> = [
    {
      name: comparativeTimeline.current.label,
      points: comparativeTimeline.current.points.map((p) => ({
        x: String(p.relativeDay),
        y: p.count,
      })),
    },
  ];

  if (comparativeTimeline.previous) {
    timelineSeries.push({
      name: comparativeTimeline.previous.label,
      points: comparativeTimeline.previous.points.map((p) => ({
        x: String(p.relativeDay),
        y: p.count,
      })),
    });
  }

  const timelineSection = {
    id: "comparative_timeline",
    kind: "chart" as const,
    chartType: "line" as const,
    title: "الاتجاه الزمني المقارن",
    xAxisLabel: "اليوم النسبي",
    yAxisLabel: "عدد الشكاوى",
    series: timelineSeries,
  };

  try {
    const png = await renderLineChartPng(timelineSection, chartW, chartH);
    doc.image(png, margin, y, { width: contentW, height: availableH });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`تعذر رسم المخطط الزمني المقارن: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Footer for all pages
// ---------------------------------------------------------------------------

function drawBriefFooters(
  doc: PDFKit.PDFDocument,
  title: string,
  runId: string,
  margin: number,
  pageSize: [number, number],
  contentW: number
): void {
  const range = doc.bufferedPageRange();
  const runPart = runId ? ` — تشغيل: ${runId}` : "";
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const pageNumber = i - range.start + 1;
    const y = pageSize[1] - margin - 14;
    doc.font("Body").fontSize(8).fillColor(COLOR_MUTED);
    doc.text(`${title}${runPart} — صفحة ${pageNumber} من ${range.count}`, margin, y, {
      width: contentW,
      align: "center",
    });
    doc.fillColor("#000000");
  }
}

