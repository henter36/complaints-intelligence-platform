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
  generatedText: string;
  metrics: readonly [ReportCoverMetric, ReportCoverMetric, ReportCoverMetric];
};

const COLORS = REPORT_DESIGN_TOKENS.colors;
const WORD_SPACING = REPORT_DESIGN_TOKENS.typography.wordSpacing;

/** Draws the shared branded cover used by every complaints PDF renderer. */
export function drawComplaintsReportCover(options: ReportCoverOptions): void {
  const {
    doc,
    pageSize,
    margin,
    title,
    periodText,
    comparisonText,
    generatedText,
    metrics,
  } = options;
  const contentWidth = pageSize[0] - margin * 2;
  const titleY = pageSize[1] * 0.26;

  doc.rect(0, 0, pageSize[0], pageSize[1]).fill(COLORS.background);
  doc.rect(pageSize[0] - 32, 0, 32, pageSize[1]).fill(COLORS.primary);
  doc.rect(0, 0, 10, pageSize[1]).fill(COLORS.gold);
  doc.font("Bold").fontSize(36).fillColor(COLORS.primary)
    .text(title, margin, titleY, {
      width: contentWidth,
      align: "center",
      wordSpacing: WORD_SPACING,
    });
  doc.font("Body").fontSize(16).fillColor(COLORS.text)
    .text(periodText, margin, titleY + 72, {
      width: contentWidth,
      align: "center",
      wordSpacing: WORD_SPACING,
    })
    .text(comparisonText, margin, titleY + 108, {
      width: contentWidth,
      align: "center",
      wordSpacing: WORD_SPACING,
    });
  doc.fontSize(12).fillColor(COLORS.neutral)
    .text(generatedText, margin, titleY + 150, {
      width: contentWidth,
      align: "center",
      wordSpacing: WORD_SPACING,
    });

  const gap = 18;
  const width = (contentWidth - gap * 2) / 3;
  metrics.forEach((metric, index) => {
    const x = margin + (2 - index) * (width + gap);
    doc.roundedRect(x, titleY + 230, width, 104, REPORT_DESIGN_TOKENS.card.radius)
      .fillAndStroke(COLORS.background, COLORS.border);
    doc.font("Body").fontSize(12).fillColor(COLORS.neutral)
      .text(metric.label, x + 10, titleY + 248, {
        width: width - 20,
        align: "center",
        wordSpacing: WORD_SPACING,
      });
    doc.font("Bold").fontSize(28).fillColor(COLORS.primary)
      .text(formatNullableReportNumber(metric.value), x + 10, titleY + 280, {
        width: width - 20,
        align: "center",
      });
  });
}
