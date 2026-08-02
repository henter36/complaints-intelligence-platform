import type PDFKit from "pdfkit";
import {
  formatNullableReportNumber,
  REPORT_DESIGN_TOKENS,
} from "@/lib/reports/design-tokens";

export type ReportCoverMetric = {
  label: string;
  value: number | null;
};

type ReportCoverOptions = {
  doc: PDFKit.PDFDocument;
  pageSize: readonly [number, number];
  margin: number;
  title: string;
  periodText: string;
  comparisonText: string;
  metrics: readonly [ReportCoverMetric, ReportCoverMetric, ReportCoverMetric];
};

const COLORS = REPORT_DESIGN_TOKENS.colors;
const WORD_SPACING = REPORT_DESIGN_TOKENS.typography.wordSpacing;

function drawDots(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  rows: number,
  cols: number,
  spacing: number
): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      doc.circle(x + c * spacing, y + r * spacing, 2.5).fill(COLORS.gold);
    }
  }
  doc.fillColor(COLORS.primary);
}

function diamond(doc: PDFKit.PDFDocument, cx: number, cy: number, r: number): void {
  doc
    .moveTo(cx, cy - r)
    .lineTo(cx + r, cy)
    .lineTo(cx, cy + r)
    .lineTo(cx - r, cy)
    .closePath()
    .fill(COLORS.gold);
  doc.fillColor(COLORS.primary);
}

function goldSeparator(
  doc: PDFKit.PDFDocument,
  cx: number,
  y: number,
  halfW: number
): void {
  const gap = 14;
  doc.moveTo(cx - halfW, y).lineTo(cx - gap, y).strokeColor(COLORS.gold).lineWidth(1).stroke();
  doc.moveTo(cx + gap, y).lineTo(cx + halfW, y).strokeColor(COLORS.gold).lineWidth(1).stroke();
  diamond(doc, cx, y, 6);
  doc.strokeColor(COLORS.border).lineWidth(1);
}

/** Draws the shared branded cover used by every complaints PDF renderer. */
export function drawComplaintsReportCover(options: ReportCoverOptions): void {
  const { doc, pageSize, margin, title, periodText, comparisonText, metrics } = options;
  const PW = pageSize[0];
  const PH = pageSize[1];
  const CW = PW - margin * 2;

  // ── Cream background ──────────────────────────────────────────────────────
  doc.rect(0, 0, PW, PH).fill(COLORS.background);

  // ── Top green curved wave (full width, bezier bottom edge) ───────────────
  const bannerH = Math.round(PH * 0.24);
  doc
    .moveTo(0, 0)
    .lineTo(PW, 0)
    .lineTo(PW, bannerH * 0.72)
    .bezierCurveTo(PW * 0.72, bannerH * 0.86, PW * 0.38, bannerH * 1.07, 0, bannerH)
    .closePath()
    .fill(COLORS.primary);

  // ── Gold accent stripe along wave bottom edge ─────────────────────────────
  doc
    .moveTo(0, bannerH)
    .bezierCurveTo(PW * 0.38, bannerH * 1.07, PW * 0.72, bannerH * 0.86, PW, bannerH * 0.72)
    .lineWidth(3)
    .strokeColor(COLORS.gold)
    .stroke();
  doc.lineWidth(1);

  // ── Gold dots grid (top-right, in white area) ────────────────────────────
  drawDots(doc, PW - margin - 36, margin + 18, 3, 3, 13);

  // ── Subtle bottom gold wave ───────────────────────────────────────────────
  const botWaveY = PH - 220;
  doc
    .moveTo(0, PH)
    .lineTo(PW, PH)
    .lineTo(PW, botWaveY)
    .bezierCurveTo(
      PW * 0.68, botWaveY - 18,
      PW * 0.32, botWaveY + 16,
      0, botWaveY + 6
    )
    .closePath()
    .fillOpacity(0.13)
    .fill(COLORS.gold);
  doc.fillOpacity(1);

  // ── Main title ────────────────────────────────────────────────────────────
  const titleY = bannerH + 28;
  doc.font("Bold").fontSize(80).fillColor(COLORS.primary).text(title, margin, titleY, {
    width: CW,
    align: "center",
    wordSpacing: WORD_SPACING,
  });

  // ── Gold separator with diamond ───────────────────────────────────────────
  const sepY = titleY + 106;
  goldSeparator(doc, PW / 2, sepY, CW * 0.28);

  // ── Period text ───────────────────────────────────────────────────────────
  const periodY = sepY + 22;
  doc.font("Bold").fontSize(17).fillColor(COLORS.text).text(periodText, margin, periodY, {
    width: CW,
    align: "center",
    wordSpacing: WORD_SPACING,
  });

  // ── Comparison text ───────────────────────────────────────────────────────
  doc.font("Body").fontSize(13).fillColor(COLORS.neutral).text(comparisonText, margin, periodY + 36, {
    width: CW,
    align: "center",
    wordSpacing: WORD_SPACING,
  });

  // ── KPI cards ─────────────────────────────────────────────────────────────
  // Position relative to text (not page height) so tall pages don't push cards down
  const cardY = periodY + 90;
  const cardGap = 18;
  const cardW = (CW - cardGap * 2) / 3;
  const cardH = 170;
  const circR = 29;
  const r = REPORT_DESIGN_TOKENS.card.radius;

  metrics.forEach((metric, index) => {
    // RTL: index 0 = rightmost, index 2 = leftmost
    const x = margin + (2 - index) * (cardW + cardGap);

    // Card background with border
    doc.roundedRect(x, cardY, cardW, cardH, r).fillAndStroke(COLORS.background, COLORS.border);

    // Circular icon ring (gold)
    const circleX = x + cardW / 2;
    const circleY = cardY + circR + 16;
    doc.circle(circleX, circleY, circR).lineWidth(1.5).strokeColor(COLORS.gold).stroke();
    doc.lineWidth(1);

    // Label
    doc.font("Body").fontSize(12).fillColor(COLORS.neutral).text(
      metric.label,
      x + 6,
      circleY + circR + 10,
      { width: cardW - 12, align: "center", wordSpacing: WORD_SPACING }
    );

    // Value
    doc.font("Bold").fontSize(32).fillColor(COLORS.primary).text(
      formatNullableReportNumber(metric.value),
      x + 6,
      circleY + circR + 32,
      { width: cardW - 12, align: "center", wordSpacing: WORD_SPACING }
    );

    // Gold underline
    const ulY = cardY + cardH - 18;
    doc
      .moveTo(x + cardW * 0.28, ulY)
      .lineTo(x + cardW * 0.72, ulY)
      .strokeColor(COLORS.gold)
      .lineWidth(2.5)
      .stroke();
    doc.lineWidth(1).strokeColor(COLORS.border);
  });

  doc.fillColor(COLORS.primary).strokeColor(COLORS.primary);
}
