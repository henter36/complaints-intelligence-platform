import type { KpiAssessment } from "./report-contract";

/**
 * Shared visual language for every report renderer and preview.
 * Approved complaints-report palette from the reporting redesign reference.
 */
export const REPORT_DESIGN_TOKENS = {
  colors: {
    primary: "#004B3A",
    gold: "#B88919",
    success: "#004B3A",
    danger: "#C62828",
    neutral: "#46534E",
    text: "#073B31",
    background: "#FCFAF5",
    tableRowAlternate: "#F7F2E7",
    border: "#D8BE7A",
    white: "#FFFFFF",
  },
  card: {
    radius: 8,
    padding: 12,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 18,
    xl: 24,
  },
  fontSize: {
    reportTitle: 28,
    pageTitle: 20,
    sectionTitle: 17,
    kpiValue: 26,
    body: 12,
    table: 11.5,
    tableHeader: 12.5,
    footer: 9,
  },
  typography: {
    // wordSpacing:1 keeps spaces visible between Arabic words in PDFKit's BiDi layout.
    // With wordSpacing:0 the leading visual space (= last logical space after RTL reorder)
    // is stripped by PDFKit's line-trimming, causing word concatenation.
    wordSpacing: 1,
  },
} as const;

export const DIGITAL_EXECUTIVE_PAGE_SIZE = [900, 1200] as const;
export const PRINT_EXECUTIVE_PAGE_SIZE = [900, 1200] as const;
export const REPORT_UNAVAILABLE_LABEL = "غير متاح";

/** Display formats keep Excel cells numeric while matching the report policy. */
export const REPORT_XLSX_NUMBER_FORMATS = {
  number: "#,##0.#",
  signedNumber: "+#,##0.#;−#,##0.#;0",
  percent: '0.#"%"',
  signedPercent: '+0.#"%";−0.#"%";0"%"',
} as const;

export type ExecutiveDirection = "positive" | "negative" | "neutral";

export const EXECUTIVE_DIRECTION_GLYPHS: Readonly<Record<ExecutiveDirection, string>> = {
  positive: "↑",
  negative: "↓",
  neutral: "—",
};

export function directionFromAssessment(
  assessment: KpiAssessment
): ExecutiveDirection {
  if (assessment === "positive") return "positive";
  if (assessment === "negative" || assessment === "warning") return "negative";
  return "neutral";
}

export function directionColor(direction: ExecutiveDirection): string {
  if (direction === "positive") return REPORT_DESIGN_TOKENS.colors.success;
  if (direction === "negative") return REPORT_DESIGN_TOKENS.colors.gold;
  return REPORT_DESIGN_TOKENS.colors.neutral;
}

type ReportNumberOptions = {
  maximumFractionDigits?: number;
  sign?: boolean;
  percent?: boolean;
};

/** Latin digits are intentional for PDF, preview, and XLSX interoperability. */
export function formatReportNumber(
  value: number,
  options: ReportNumberOptions = {}
): string {
  const { maximumFractionDigits = 1, sign = false, percent = false } = options;
  const absolute = Math.abs(value);
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(absolute);
  let prefix = "";
  if (value < 0) prefix = "−";
  else if (sign && value > 0) prefix = "+";
  return `${prefix}${formatted}${percent ? "%" : ""}`;
}

export function formatNullableReportNumber(
  value: number | null,
  options: ReportNumberOptions = {}
): string {
  return value === null ? REPORT_UNAVAILABLE_LABEL : formatReportNumber(value, options);
}
