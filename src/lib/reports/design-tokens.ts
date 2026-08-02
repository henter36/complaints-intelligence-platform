import type { KpiAssessment } from "./report-contract";

/**
 * Shared visual language for every report renderer and preview.
 * `primary` is a temporary corporate fallback until an approved brand colour
 * is supplied by the organisation.
 */
export const REPORT_DESIGN_TOKENS = {
  colors: {
    primary: "#1F2937",
    success: "#16A34A",
    danger: "#DC2626",
    neutral: "#6B7280",
    background: "#F9FAFB",
    tableRowAlternate: "#F3F4F6",
    border: "#E5E7EB",
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
    sectionTitle: 15,
    kpiValue: 24,
    body: 11,
    table: 9,
    footer: 8.5,
  },
} as const;

export const DIGITAL_EXECUTIVE_PAGE_SIZE = [1440, 810] as const;
export const PRINT_EXECUTIVE_PAGE_SIZE = [841.89, 595.28] as const;

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
  if (direction === "negative") return REPORT_DESIGN_TOKENS.colors.danger;
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
  return value === null ? "—" : formatReportNumber(value, options);
}
