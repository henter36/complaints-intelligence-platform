import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ChartSeries, ReportChartSection } from "./report-data-service";
import {
  formatReportNumber,
  REPORT_DESIGN_TOKENS,
} from "@/lib/reports/design-tokens";

// ---------------------------------------------------------------------------
// Pure server-side SVG line-chart renderer -> PNG (via sharp/librsvg).
// Arabic text is rendered using the Amiri font, which is registered with
// Fontconfig so librsvg can find it. The embedded base64 font approach was
// removed because librsvg relies on Fontconfig, not on inline font data.
// ---------------------------------------------------------------------------

const EXPECTED_FONT_FILE = "Amiri-Regular.ttf";

// Resolve the assets directory using multiple candidate locations so the
// module works in development (process.cwd() = project root), in the
// Next.js standalone output, and in custom deploy setups.
function resolveAssetsDir(): string {
  const candidates = [
    // Development: source tree relative to project root
    path.join(process.cwd(), "src/server/reports/assets"),
    // Next.js standalone: traced assets land next to the server
    path.join(process.cwd(), ".next/standalone/src/server/reports/assets"),
    // Module-relative: works when bundled to the same directory
    path.resolve(__dirname, "assets"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "fonts", EXPECTED_FONT_FILE))) {
      return candidate;
    }
  }
  throw new Error(
    `[report-chart-service] تعذر تحديد موقع أصول التقارير. تأكد من وجود "${EXPECTED_FONT_FILE}" في أحد المسارات:\n` +
      candidates.map((d) => `  • ${path.join(d, "fonts", EXPECTED_FONT_FILE)}`).join("\n")
  );
}

let fontconfigConfigured = false;

/**
 * Configures Fontconfig to include the project's bundled Amiri font so that
 * sharp/librsvg can render Arabic labels without a system-wide font install.
 * Idempotent — safe to call before every sharp() invocation.
 * Sets FONTCONFIG_FILE to a minimal fonts.conf written into os.tmpdir().
 */
export function configureReportFontconfig(): void {
  if (fontconfigConfigured) return;

  const assetsDir = resolveAssetsDir();
  const fontsDir = path.join(assetsDir, "fonts");

  const conf = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    "<fontconfig>",
    `  <dir>${fontsDir}</dir>`,
    "  <cachedir>/tmp/cip-fontconfig-cache</cachedir>",
    "</fontconfig>",
  ].join("\n");

  const tmpDir = path.join(os.tmpdir(), "cip-fontconfig");
  fs.mkdirSync(tmpDir, { recursive: true });
  const confPath = path.join(tmpDir, "fonts.conf");
  fs.writeFileSync(confPath, conf, "utf8");

  process.env.FONTCONFIG_FILE = confPath;
  fontconfigConfigured = true;
}

export const MIN_CHART_WIDTH = 500;
export const MIN_CHART_HEIGHT = 300;

type SeriesStyle = {
  color: string;
  dash: string;
  width: number;
  mark: "bar" | "line";
};

const COLORS = REPORT_DESIGN_TOKENS.colors;

const SERIES_STYLES: SeriesStyle[] = [
  { color: COLORS.primary, dash: "0", width: 2, mark: "line" },
  { color: COLORS.gold, dash: "6,3", width: 2, mark: "line" },
  { color: COLORS.primary, dash: "2,3", width: 2, mark: "line" },
  { color: COLORS.neutral, dash: "6,3,2,3", width: 2, mark: "line" },
  { color: COLORS.primary, dash: "10,4", width: 2, mark: "line" },
  { color: COLORS.neutral, dash: "4,2", width: 2, mark: "line" },
  { color: COLORS.primary, dash: "2,2", width: 2, mark: "line" },
  { color: COLORS.neutral, dash: "0", width: 1, mark: "line" },
];

const OTHER_STYLE: SeriesStyle = { color: COLORS.neutral, dash: "5,3", width: 1.5, mark: "line" };

// Right-axis (secondary) line series styles for dual-axis charts (legacy).
// Index 0 → open-at-end (green), index 1 → late-at-end (red).
const RIGHT_AXIS_STYLES: SeriesStyle[] = [
  { color: COLORS.primary, dash: "0", width: 2, mark: "line" },
  { color: COLORS.danger, dash: "0", width: 2, mark: "line" },
];

/** V2 monthly palette: dark-green registered bars, gold closed line (legacy slots unused). */
const MONTHLY_TREND_STYLES: SeriesStyle[] = [
  { color: COLORS.primary, dash: "0", width: 2, mark: "bar" },
  { color: COLORS.gold, dash: "0", width: 2.2, mark: "line" },
  { color: COLORS.primary, dash: "0", width: 2.2, mark: "line" },
  { color: COLORS.danger, dash: "6,4", width: 2.2, mark: "line" },
];

function resolveSeriesMark(series: ChartSeries, sectionChartType: ReportChartSection["chartType"]): "bar" | "line" {
  if (series.renderAs === "bar" || series.renderAs === "line") return series.renderAs;
  return sectionChartType === "bar" ? "bar" : "line";
}

function seriesStyle(
  index: number,
  isOther: boolean,
  mark: "bar" | "line",
  series?: ChartSeries
): SeriesStyle {
  if (isOther) return { ...OTHER_STYLE, mark };
  const base = SERIES_STYLES[index % SERIES_STYLES.length];
  const color = base.color;
  const dash = series?.dash ?? (mark === "bar" ? "0" : base.dash);
  return { color, dash, width: mark === "bar" ? 2 : base.width, mark };
}

/** Bars always solid; lines use series/preset dash (late kept on preset). */
function resolveMonthlyTrendDash(
  mark: "bar" | "line",
  series: ChartSeries,
  preset: SeriesStyle
): string {
  if (mark === "bar") return "0";
  if (series.dash) return series.dash;
  return preset.dash;
}

function monthlyTrendStyle(
  index: number,
  series: ChartSeries,
  sectionChartType: ReportChartSection["chartType"]
): SeriesStyle {
  const mark = resolveSeriesMark(series, sectionChartType);
  const preset = MONTHLY_TREND_STYLES[index];
  if (!preset) {
    return seriesStyle(index, series.isOther === true, mark, series);
  }
  return {
    ...preset,
    mark,
    dash: resolveMonthlyTrendDash(mark, series, preset),
    color: preset.color,
  };
}

function rightAxisStyle(index: number): SeriesStyle {
  return RIGHT_AXIS_STYLES[index % RIGHT_AXIS_STYLES.length];
}

/** Escapes text for safe inclusion in SVG text nodes and attributes.
 * `&` must be replaced first to avoid double-escaping the entities below it. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Chooses a "nice" upper bound and tick step for the Y axis.
 * Prefer integer ticks for complaint counts (no fractional half-complaints).
 */
export function computeYScale(
  maxValue: number,
  options: { integersOnly?: boolean; paddingRatio?: number } = {}
): { max: number; ticks: number[] } {
  const integersOnly = options.integersOnly ?? true;
  const paddingRatio = options.paddingRatio ?? 0.12;
  if (maxValue <= 0) {
    return { max: 1, ticks: [0, 1] };
  }
  const padded = maxValue * (1 + paddingRatio);
  const roughStep = padded / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceStep: number;
  if (normalized <= 1) niceStep = magnitude;
  else if (normalized <= 2) niceStep = 2 * magnitude;
  else if (normalized <= 5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  if (integersOnly) {
    niceStep = Math.max(1, Math.ceil(niceStep));
  }

  const max = Math.ceil(padded / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let value = 0; value <= max + 1e-9; value += niceStep) {
    ticks.push(integersOnly ? Math.round(value) : Math.round(value * 100) / 100);
  }
  // Deduplicate when rounding collapses ticks
  const unique = [...new Set(ticks)];
  const lastTick = unique.at(-1);
  if (lastTick !== max) unique.push(max);
  return { max, ticks: unique };
}

/** Short date label: "MM/DD" from a YYYY-MM-DD string; otherwise keep as-is (Arabic months). */
function shortDateLabel(iso: string): string {
  const parts = iso.split("-");
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    return `${parts[1]}/${parts[2]}`;
  }
  return iso;
}

export type ChartLabelPolicy = "auto" | "all";
export type ChartLabelLayout = "single-line" | "wrap-two-lines";

export type ChartRenderOptions = {
  xLabelPolicy?: ChartLabelPolicy;
  xLabelLayout?: ChartLabelLayout;
  showLinePointValues?: boolean;
};

const DEFAULT_CHART_RENDER_OPTIONS: Required<ChartRenderOptions> = {
  xLabelPolicy: "auto",
  xLabelLayout: "single-line",
  showLinePointValues: false,
};

export function resolveChartRenderOptions(
  options?: ChartRenderOptions
): Required<ChartRenderOptions> {
  return {
    xLabelPolicy: options?.xLabelPolicy ?? DEFAULT_CHART_RENDER_OPTIONS.xLabelPolicy,
    xLabelLayout: options?.xLabelLayout ?? DEFAULT_CHART_RENDER_OPTIONS.xLabelLayout,
    showLinePointValues:
      options?.showLinePointValues ?? DEFAULT_CHART_RENDER_OPTIONS.showLinePointValues,
  };
}

const BAR_VALUE_LABEL_ABOVE_OFFSET = 3;
const BAR_VALUE_LABEL_MIN_TOP_OFFSET = 10;
const BAR_VALUE_LABEL_INSIDE_OFFSET = 12;
const BAR_VALUE_LABEL_BOTTOM_RESERVE = 2;

/** Minimum vertical gap between a line value label and the bar value label. */
export const LINE_VALUE_LABEL_COLLISION_PX = 14;

export type BarValueLabelPlacement = {
  y: number;
  insideBar: boolean;
};

/**
 * Shared bar-value label placement used by renderBarSeries and line-label collision checks.
 * Preferred above the bar; clamps inside the bar when near plotTop.
 */
export function resolveBarValueLabelPlacement(options: {
  barTopY: number;
  plotTop: number;
  plotBottom: number;
}): BarValueLabelPlacement {
  const { barTopY, plotTop, plotBottom } = options;
  const preferredY = barTopY - BAR_VALUE_LABEL_ABOVE_OFFSET;
  const minTop = plotTop + BAR_VALUE_LABEL_MIN_TOP_OFFSET;
  if (preferredY < minTop) {
    return {
      y: Math.min(barTopY + BAR_VALUE_LABEL_INSIDE_OFFSET, plotBottom - BAR_VALUE_LABEL_BOTTOM_RESERVE),
      insideBar: true,
    };
  }
  return { y: preferredY, insideBar: false };
}

export type LineValueLabelPlacement = {
  y: number;
  insideBar: boolean;
  fill: string;
};

/**
 * Places a closed-line value label near its point while avoiding bar-value collisions
 * and staying inside the plot (above plotTop, clear of month labels at plotBottom).
 */
export function resolveLineValueLabelPlacement(options: {
  pointY: number;
  barTopY: number | null;
  plotTop: number;
  plotBottom: number;
}): LineValueLabelPlacement {
  const { pointY, barTopY, plotTop, plotBottom } = options;
  const aboveOffset = 12;
  const belowOffset = 14;
  const minTop = plotTop + BAR_VALUE_LABEL_MIN_TOP_OFFSET;
  const maxBottom = plotBottom - 14;
  const defaultFill = COLORS.gold;
  const insideFill = COLORS.white;

  const barPlacement = barTopY === null
    ? null
    : resolveBarValueLabelPlacement({ barTopY, plotTop, plotBottom });
  const conflictsWithBar = (labelY: number): boolean => {
    if (barPlacement === null) return false;
    return Math.abs(labelY - barPlacement.y) < LINE_VALUE_LABEL_COLLISION_PX;
  };
  const inBounds = (labelY: number): boolean => labelY >= minTop && labelY <= maxBottom;

  const preferredAbove = pointY - aboveOffset;
  if (inBounds(preferredAbove) && !conflictsWithBar(preferredAbove)) {
    return { y: preferredAbove, insideBar: false, fill: defaultFill };
  }

  const preferredBelow = pointY + belowOffset;
  if (inBounds(preferredBelow) && !conflictsWithBar(preferredBelow)) {
    const insideBar = barTopY !== null && preferredBelow > barTopY;
    return {
      y: preferredBelow,
      insideBar,
      fill: insideBar ? insideFill : defaultFill,
    };
  }

  if (barTopY !== null) {
    const insideY = Math.min(Math.max(barTopY + BAR_VALUE_LABEL_INSIDE_OFFSET, minTop), maxBottom);
    if (inBounds(insideY) && !conflictsWithBar(insideY)) {
      return { y: insideY, insideBar: true, fill: insideFill };
    }
  }

  if (barPlacement !== null) {
    const belowBarLabel = Math.min(barPlacement.y + LINE_VALUE_LABEL_COLLISION_PX, maxBottom);
    if (inBounds(belowBarLabel) && !conflictsWithBar(belowBarLabel)) {
      const insideBar = barTopY !== null && belowBarLabel > barTopY;
      return {
        y: belowBarLabel,
        insideBar,
        fill: insideBar ? insideFill : defaultFill,
      };
    }
    const aboveBarLabel = Math.max(barPlacement.y - LINE_VALUE_LABEL_COLLISION_PX, minTop);
    if (inBounds(aboveBarLabel) && !conflictsWithBar(aboveBarLabel)) {
      return { y: aboveBarLabel, insideBar: false, fill: defaultFill };
    }
  }

  const clamped = Math.min(Math.max(preferredAbove, minTop), maxBottom);
  return { y: clamped, insideBar: false, fill: defaultFill };
}

/**
 * Temporal charts may skip every other label when crowded.
 * Categorical charts (regions) pass policy="all" so every category keeps a label.
 */
export function resolveXAxisLabelStep(
  labelCount: number,
  policy: ChartLabelPolicy
): number {
  if (policy === "all") return 1;
  if (labelCount <= 0) return 1;
  if (labelCount >= 12) return 2;
  return Math.max(1, Math.ceil(labelCount / 12));
}

/** Split long categorical labels into at most `maxLines` lines on whitespace. */
export function wrapCategoricalAxisLabel(label: string, maxLines: number): string[] {
  const trimmed = label.trim();
  if (!trimmed) return [""];
  if (maxLines <= 1) return [trimmed];
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [trimmed];
  if (parts.length === 2 || maxLines === 2) {
    const mid = Math.ceil(parts.length / 2);
    return [parts.slice(0, mid).join(" "), parts.slice(mid).join(" ")].filter(Boolean);
  }
  const lines: string[] = [];
  const perLine = Math.ceil(parts.length / maxLines);
  for (let i = 0; i < parts.length && lines.length < maxLines; i += perLine) {
    lines.push(parts.slice(i, i + perLine).join(" "));
  }
  return lines;
}

export function resolveXAxisBottomReserve(layout: ChartLabelLayout): number {
  return layout === "wrap-two-lines" ? 50 : 36;
}

function renderXAxisLabelText(options: {
  x: number;
  y: number;
  lines: string[];
  fontSize: number;
  lineGap: number;
}): string {
  const { x, y, lines, fontSize, lineGap } = options;
  if (lines.length <= 1) {
    return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${fontSize}" fill="${COLORS.neutral}" direction="rtl" unicode-bidi="plaintext">${escapeXml(lines[0] ?? "")}</text>`;
  }
  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineGap;
      return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${fontSize}" fill="${COLORS.neutral}" direction="rtl" unicode-bidi="plaintext">${tspans}</text>`;
}

/** Inline CSS that declares Amiri as the font family.
 * Fontconfig (set up by configureReportFontconfig) makes the actual TTF
 * available to librsvg — no base64 embedding is needed or used. */
function fontStyleBlock(): string {
  return `<style>
    text { font-family: "Amiri", "Noto Naskh Arabic", sans-serif; }
  </style>`;
}

type ChartGeometry = {
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  xCount: number;
};

type ChartAxisScale = {
  ticks: number[];
  max: number;
};

type SecondaryChartAxisScale = ChartAxisScale | null;

type RenderAxesOptions = {
  geo: ChartGeometry;
  primaryScale: ChartAxisScale;
  labels: string[];
  chartType: ReportChartSection["chartType"];
  secondaryScale: SecondaryChartAxisScale;
  renderOptions: Required<ChartRenderOptions>;
};

function xForIndex(geo: ChartGeometry, index: number): number {
  if (geo.xCount <= 1) return (geo.plotLeft + geo.plotRight) / 2;
  const t = index / (geo.xCount - 1);
  return geo.plotLeft + t * (geo.plotRight - geo.plotLeft);
}

function yForValue(geo: ChartGeometry, value: number, yMax: number): number {
  const t = yMax === 0 ? 0 : value / yMax;
  return geo.plotBottom - t * (geo.plotBottom - geo.plotTop);
}

function estimateTextWidth(text: string, fontSize: number): number {
  // Slightly wide Amiri estimate so legend labels stay inside their cell.
  let units = 0;
  for (const ch of text) {
    if (ch === " " || ch === "\u00A0") units += 0.45;
    else if (/[0-9.,+\-−%]/.test(ch)) units += 0.62;
    else units += 1.05;
  }
  return units * fontSize;
}

function resolveCategoricalLabelFontSize(lines: string[], slotWidth: number): number {
  const preferred = 9;
  const minimum = 8;
  const widest = Math.max(...lines.map((line) => estimateTextWidth(line, preferred)), 0);
  if (widest <= slotWidth) return preferred;
  const widestMin = Math.max(...lines.map((line) => estimateTextWidth(line, minimum)), 0);
  if (widestMin <= slotWidth) return minimum;
  return minimum;
}

export type FittedLegendLabel = {
  text: string;
  fontSize: number;
  measuredWidth: number;
  truncated: boolean;
};

/**
 * Fit a legend label into availableWidth by shrinking font then ellipsizing.
 * Final measuredWidth is always <= availableWidth when availableWidth > 0.
 */
export function fitLegendLabel(
  label: string,
  availableWidth: number,
  preferredFontSize: number,
  minFontSize: number
): FittedLegendLabel {
  const widthCap = Math.max(0, availableWidth);
  if (widthCap === 0) {
    return { text: "", fontSize: minFontSize, measuredWidth: 0, truncated: label.length > 0 };
  }

  let fontSize = preferredFontSize;
  while (fontSize > minFontSize) {
    const measured = estimateTextWidth(label, fontSize);
    if (measured <= widthCap) {
      return { text: label, fontSize, measuredWidth: measured, truncated: false };
    }
    fontSize -= 0.5;
  }

  // At min size: ellipsize one character at a time.
  const ellipsis = "…";
  let candidate = label;
  while (candidate.length > 0) {
    const text = candidate === label ? candidate : `${candidate}${ellipsis}`;
    const measured = estimateTextWidth(text, minFontSize);
    if (measured <= widthCap) {
      return {
        text,
        fontSize: minFontSize,
        measuredWidth: measured,
        truncated: candidate !== label,
      };
    }
    candidate = candidate.slice(0, -1);
  }

  // Fall back to bare ellipsis if even one char does not fit.
  const bare = estimateTextWidth(ellipsis, minFontSize) <= widthCap ? ellipsis : "";
  return {
    text: bare,
    fontSize: minFontSize,
    measuredWidth: estimateTextWidth(bare, minFontSize),
    truncated: label.length > 0,
  };
}

type LegendItem = {
  name: string;
  style: SeriesStyle;
};

export type ChartLegendLabelBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  availableWidth: number;
  measuredWidth: number;
  originalName: string;
  renderedName: string;
  fontSize: number;
  truncated: boolean;
  /** Independent label-zone bounds (exclusive of swatch). */
  labelLeft: number;
  labelRight: number;
  swatchLeft: number;
  legendGap: number;
};

export type ChartLegendLayout = {
  svg: string;
  height: number;
  labelBoxes: ChartLegendLabelBox[];
};

/** Gap between the independent label zone and swatch zone in each legend cell. */
export const CHART_LEGEND_GAP = 14;

/**
 * Shared legend renderer: reserved band outside the plot, 2×2 grid when narrow.
 * Each cell is split into [label zone][gap][swatch zone] so marks never overlap text.
 * Arabic labels use text-anchor="middle" centered in the label zone (not end-anchored).
 */
export function drawChartLegend(
  items: readonly LegendItem[],
  options: {
    width: number;
    top: number;
    fontSize?: number;
    columns?: number;
    paddingX?: number;
  }
): ChartLegendLayout {
  const preferredFontSize = options.fontSize ?? 11;
  const minFontSize = 8;
  const paddingX = options.paddingX ?? 16;
  const columns = Math.min(
    options.columns ?? (options.width < 560 ? 2 : Math.min(4, Math.max(2, items.length))),
    Math.max(1, items.length)
  );
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const rowH = 24;
  const swatchZoneWidth = 28;
  const legendGap = CHART_LEGEND_GAP;
  const swatchW = 22;
  const swatchH = 9;
  const colGap = 14;
  // Short legends (e.g. region الحالية/السابقة) pack to the inline-start (right in RTL)
  // so middle-anchored labels stay near their swatches instead of floating in a wide cell.
  const packedWidth =
    items.length <= 2
      ? Math.min(options.width, paddingX * 2 + columns * 150)
      : options.width;
  const packOffset = Math.max(0, options.width - packedWidth);
  const usable = packedWidth - paddingX * 2;
  const colW = usable / columns;

  const parts: string[] = [];
  const labelBoxes: ChartLegendLabelBox[] = [];

  items.forEach((item, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    // RTL reading order: column 0 is the rightmost cell
    const rtlCol = columns - 1 - col;
    const cellLeft = packOffset + paddingX + rtlCol * colW;
    const cellRight = cellLeft + colW - colGap;
    const cy = options.top + row * rowH + rowH / 2;

    const swatchRight = cellRight - 2;
    const swatchLeft = swatchRight - swatchZoneWidth;
    const labelLeft = cellLeft + 4;
    const labelRight = swatchLeft - legendGap;
    const availableLabelWidth = Math.max(0, labelRight - labelLeft);
    const fitted = fitLegendLabel(
      item.name,
      availableLabelWidth,
      preferredFontSize,
      minFontSize
    );

    const markLeft = swatchRight - swatchW;
    if (item.style.mark === "bar") {
      parts.push(
        `<rect x="${markLeft.toFixed(1)}" y="${(cy - swatchH / 2).toFixed(1)}" width="${swatchW}" height="${swatchH}" rx="1.5" fill="${item.style.color}"/>`
      );
    } else {
      const dashAttr = item.style.dash && item.style.dash !== "0"
        ? ` stroke-dasharray="${item.style.dash}"`
        : "";
      parts.push(
        `<line x1="${markLeft.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${swatchRight.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${item.style.color}" stroke-width="${item.style.width}"${dashAttr}/>`,
        `<circle cx="${((markLeft + swatchRight) / 2).toFixed(1)}" cy="${cy.toFixed(1)}" r="2.5" fill="${COLORS.white}" stroke="${item.style.color}" stroke-width="1.4"/>`
      );
    }

    // Center the label in its own zone. Do not use text-anchor="end" for Arabic
    // legend text — librsvg/PDF embedding does not keep end-anchored glyphs inside
    // the computed box. Do not attach clip-path (librsvg drops Arabic glyphs).
    const labelCenterX = (labelLeft + labelRight) / 2;
    const measuredLeft = labelCenterX - fitted.measuredWidth / 2;
    const measuredRight = labelCenterX + fitted.measuredWidth / 2;
    parts.push(
      `<text x="${labelCenterX.toFixed(1)}" y="${(cy + fitted.fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-size="${fitted.fontSize}" fill="${COLORS.primary}" direction="rtl" unicode-bidi="plaintext">${escapeXml(fitted.text)}</text>`
    );

    labelBoxes.push({
      left: measuredLeft,
      right: measuredRight,
      top: cy - rowH / 2,
      bottom: cy + rowH / 2,
      availableWidth: availableLabelWidth,
      measuredWidth: fitted.measuredWidth,
      originalName: item.name,
      renderedName: fitted.text,
      fontSize: fitted.fontSize,
      truncated: fitted.truncated,
      labelLeft,
      labelRight,
      swatchLeft,
      legendGap,
    });
  });

  return {
    svg: parts.join("\n"),
    height: 12 + rows * rowH,
    labelBoxes,
  };
}

type RenderLineSeriesOptions = {
  geo: ChartGeometry;
  seriesList: Array<{ series: ChartSeries; style: SeriesStyle }>;
  yMax: number;
  categories: string[];
  chartType: ReportChartSection["chartType"];
  showPointValues: boolean;
  barTopYByCategory?: ReadonlyMap<string, number>;
};

function renderLineSeries(options: RenderLineSeriesOptions): string {
  const {
    geo,
    seriesList,
    yMax,
    categories,
    chartType,
    showPointValues,
    barTopYByCategory,
  } = options;
  const parts: string[] = [];
  const catIndex = new Map(categories.map((c, i) => [c, i]));
  const catCount = Math.max(1, categories.length);
  const catWidth = (geo.plotRight - geo.plotLeft) / catCount;

  for (const { series, style } of seriesList) {
    const plotted = series.points
      .map((p) => {
        const idx = catIndex.get(p.x);
        if (idx === undefined) return null;
        const x = chartType === "bar"
          ? geo.plotLeft + (idx + 0.5) * catWidth
          : xForIndex(geo, idx);
        const y = yForValue(geo, p.y, yMax);
        return { x, y, value: p.y, category: p.x };
      })
      .filter(
        (p): p is { x: number; y: number; value: number; category: string } => p !== null
      );
    if (plotted.length === 0) continue;
    const polyline = plotted.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const dashAttr = style.dash && style.dash !== "0" ? ` stroke-dasharray="${style.dash}"` : "";
    parts.push(
      `<polyline fill="none" stroke="${style.color}" stroke-width="${style.width}"${dashAttr} points="${polyline}"/>`
    );
    for (const p of plotted) {
      parts.push(
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="${COLORS.white}" stroke="${style.color}" stroke-width="1.4"/>`
      );
      if (!showPointValues || p.value <= 0) continue;
      const barTopY = barTopYByCategory?.get(p.category) ?? null;
      const placement = resolveLineValueLabelPlacement({
        pointY: p.y,
        barTopY,
        plotTop: geo.plotTop,
        plotBottom: geo.plotBottom,
      });
      parts.push(
        `<text x="${p.x.toFixed(1)}" y="${placement.y.toFixed(1)}" text-anchor="middle" font-size="9" fill="${placement.fill}">${escapeXml(formatReportNumber(p.value, { maximumFractionDigits: 0 }))}</text>`
      );
    }
  }
  return parts.join("\n");
}

/**
 * Builds a canonical category list by taking the union of all point.x values
 * across every series, in first-occurrence order.
 */
export function buildCategoryUnion(section: ReportChartSection): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const series of section.series) {
    for (const point of series.points) {
      if (!seen.has(point.x)) {
        seen.add(point.x);
        categories.push(point.x);
      }
    }
  }
  return categories;
}

function renderBarSeries(
  geo: ChartGeometry,
  seriesList: Array<{ series: ChartSeries; style: SeriesStyle }>,
  yMax: number,
  categories: string[]
): string {
  const parts: string[] = [];
  const categoryCount = Math.max(1, categories.length);
  const seriesCount = Math.max(1, seriesList.length);
  const categoryWidth = (geo.plotRight - geo.plotLeft) / categoryCount;
  const groupWidth = categoryWidth * 0.72;
  const barWidth = Math.max(2, groupWidth / seriesCount);
  const categoryIndex = new Map(categories.map((cat, i) => [cat, i]));

  seriesList.forEach(({ series, style }, seriesIndex) => {
    series.points.forEach((point) => {
      const catIdx = categoryIndex.get(point.x);
      if (catIdx === undefined) return;
      const valueY = yForValue(geo, point.y, yMax);
      const x = geo.plotLeft
        + catIdx * categoryWidth
        + (categoryWidth - groupWidth) / 2
        + seriesIndex * barWidth;
      const bw = Math.max(1, barWidth - 1);
      const barHeight = Math.max(0, geo.plotBottom - valueY);
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${valueY.toFixed(1)}" width="${bw.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${style.color}"/>`
      );
      if (point.y > 0) {
        const labelX = (x + bw / 2).toFixed(1);
        const placement = resolveBarValueLabelPlacement({
          barTopY: valueY,
          plotTop: geo.plotTop,
          plotBottom: geo.plotBottom,
        });
        const labelFill = placement.insideBar ? COLORS.white : style.color;
        const labelFs = Math.max(7, Math.min(10, Math.round(bw * 0.55)));
        parts.push(
          `<text x="${labelX}" y="${placement.y.toFixed(1)}" text-anchor="middle" font-size="${labelFs}" fill="${labelFill}">${escapeXml(formatReportNumber(point.y, { maximumFractionDigits: 0 }))}</text>`
        );
      }
    });
  });
  return parts.join("\n");
}

/** Renders right-axis line series using a secondary Y-scale (legacy dual-axis). */
function renderRightAxisLines(
  geo: ChartGeometry,
  rightSeries: ReportChartSection["series"],
  yMaxRight: number,
  categories: string[],
  chartType: ReportChartSection["chartType"]
): string {
  const styled = rightSeries.map((series, si) => ({
    series,
    style: rightAxisStyle(si),
  }));
  return renderLineSeries({
    geo,
    seriesList: styled,
    yMax: yMaxRight,
    categories,
    chartType,
    showPointValues: false,
  });
}

function renderAxesWithOptionalSecondary(options: RenderAxesOptions): string {
  const {
    geo,
    primaryScale,
    labels,
    chartType,
    secondaryScale,
    renderOptions,
  } = options;
  const { ticks: yTicks, max: yMax } = primaryScale;

  const parts: string[] = [];
  parts.push(
    `<line x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" stroke="${COLORS.border}" stroke-width="1"/>`,
    `<line x1="${geo.plotLeft}" y1="${geo.plotBottom}" x2="${geo.plotRight}" y2="${geo.plotBottom}" stroke="${COLORS.border}" stroke-width="1"/>`
  );
  for (const tick of yTicks) {
    const y = yForValue(geo, tick, yMax);
    parts.push(
      `<line x1="${geo.plotLeft}" y1="${y}" x2="${geo.plotRight}" y2="${y}" stroke="${COLORS.border}" stroke-width="1" opacity="0.4"/>`,
      `<text x="${geo.plotRight + 6}" y="${y + 4}" text-anchor="start" font-size="11" fill="${COLORS.neutral}">${formatReportNumber(tick, { maximumFractionDigits: 0 })}</text>`
    );
  }
  if (secondaryScale !== null) {
    const {
      ticks: rightTicks,
      max: yMaxRight,
    } = secondaryScale;
    parts.push(
      `<line x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" stroke="${COLORS.border}" stroke-width="1" stroke-dasharray="3,3"/>`
    );
    for (const tick of rightTicks) {
      const y = yForValue(geo, tick, yMaxRight);
      parts.push(
        `<text x="${geo.plotLeft - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="${COLORS.danger}">${formatReportNumber(tick, { maximumFractionDigits: 0 })}</text>`
      );
    }
  }

  const labelCount = labels.length;
  const step = resolveXAxisLabelStep(labelCount, renderOptions.xLabelPolicy);
  const slotWidth = (geo.plotRight - geo.plotLeft) / Math.max(1, labelCount);
  const wrapLines = renderOptions.xLabelLayout === "wrap-two-lines" ? 2 : 1;
  const lineGap = 11;
  const baseY = geo.plotBottom + (wrapLines > 1 ? 16 : 18);

  labels.forEach((rawLabel, index) => {
    if (index % step !== 0 && index !== labelCount - 1) return;
    const x = chartType === "bar"
      ? geo.plotLeft + (index + 0.5) * (geo.plotRight - geo.plotLeft) / Math.max(1, labelCount)
      : xForIndex(geo, index);
    const display = shortDateLabel(rawLabel);
    const lines = wrapLines > 1
      ? wrapCategoricalAxisLabel(display, wrapLines)
      : [display];
    const fontSize = wrapLines > 1
      ? resolveCategoricalLabelFontSize(lines, Math.max(8, slotWidth - 2))
      : 10;
    parts.push(renderXAxisLabelText({ x, y: baseY, lines, fontSize, lineGap }));
  });
  return parts.join("\n");
}

function isMonthlyComboSection(section: ReportChartSection): boolean {
  return section.series.some((s) => s.renderAs === "bar")
    && section.series.some((s) => s.renderAs === "line")
    && !section.series.some((s) => s.axis === "right");
}

function styleForSectionSeries(
  section: ReportChartSection,
  series: ChartSeries,
  index: number
): SeriesStyle {
  const mark = resolveSeriesMark(series, section.chartType);
  if (isMonthlyComboSection(section) || section.id === "v2-monthly-flow") {
    return monthlyTrendStyle(index, series, section.chartType);
  }
  return seriesStyle(index, series.isOther === true, mark, series);
}

function buildLegendItems(
  leftSeries: ReportChartSection["series"],
  rightSeries: ReportChartSection["series"],
  hasDualAxis: boolean,
  section: ReportChartSection
): LegendItem[] {
  if (!hasDualAxis) {
    return leftSeries.map((series, index) => ({
      name: series.name,
      style: styleForSectionSeries(section, series, index),
    }));
  }
  const leftItems = leftSeries.map((series, index) => ({
    name: series.name,
    style: styleForSectionSeries(section, series, index),
  }));
  const rightItems = rightSeries.map((series, index) => ({
    name: series.name,
    style: rightAxisStyle(index),
  }));
  return [...leftItems, ...rightItems];
}

export type AxisSeriesResolution = {
  leftSeries: ChartSeries[];
  rightSeries: ChartSeries[];
  hasDualAxis: boolean;
};

export function resolveAxisSeries(section: ReportChartSection): AxisSeriesResolution {
  const leftCandidates = section.series.filter((s) => s.axis !== "right");
  const hasDualAxis = leftCandidates.length > 0 && section.series.some((s) => s.axis === "right");
  if (!hasDualAxis) {
    return { leftSeries: section.series, rightSeries: [], hasDualAxis: false };
  }
  return {
    leftSeries: leftCandidates,
    rightSeries: section.series.filter((s) => s.axis === "right"),
    hasDualAxis: true,
  };
}

function resolveChartCategories(
  section: ReportChartSection,
  primarySeries: ChartSeries[]
): string[] {
  if (section.chartType === "bar" || isMonthlyComboSection(section)) {
    return buildCategoryUnion({ ...section, series: primarySeries });
  }
  return primarySeries[0]?.points.map((p) => p.x) ?? [];
}

function seriesMaxY(seriesList: ChartSeries[]): number {
  return seriesList.reduce(
    (max, s) => s.points.reduce((m, p) => Math.max(m, p.y), max),
    0
  );
}

type ChartAxisScales = {
  yMax: number;
  ticks: number[];
  yMaxRight: number;
  ticksRight: number[] | null;
};

function computeChartAxisScales(
  leftSeries: ChartSeries[],
  rightSeries: ChartSeries[],
  hasDualAxis: boolean
): ChartAxisScales {
  const leftMaxValue = seriesMaxY(leftSeries);
  const rightMaxValue = seriesMaxY(rightSeries);
  const primaryScaleInput = hasDualAxis
    ? leftMaxValue
    : Math.max(leftMaxValue, rightMaxValue);
  const { max: yMax, ticks } = computeYScale(primaryScaleInput, {
    integersOnly: true,
    paddingRatio: 0.12,
  });
  if (!hasDualAxis) {
    return { yMax, ticks, yMaxRight: yMax, ticksRight: null };
  }
  const rightScale = computeYScale(rightMaxValue, { integersOnly: true });
  return {
    yMax,
    ticks,
    yMaxRight: rightScale.max,
    ticksRight: rightScale.ticks,
  };
}

/** 4 series → 2×2 grid; otherwise pack up to 3 per row without nesting ternaries. */
export function resolveLegendColumnCount(count: number): number {
  if (count === 4) return 2;
  if (count <= 3) return Math.max(1, count);
  return 2;
}

export const MIN_PLOT_HEIGHT = 56;

export function resolveChartGeometry(options: {
  width: number;
  height: number;
  hasDualAxis: boolean;
  plotTop: number;
  xCount: number;
  bottomReserve?: number;
}): ChartGeometry {
  const bottomReserve = options.bottomReserve ?? resolveXAxisBottomReserve("single-line");
  const requestedPlotBottom = options.height - bottomReserve;
  const safePlotBottom = Number.isFinite(requestedPlotBottom)
    ? Math.max(1, requestedPlotBottom)
    : 1;
  const availableHeight = Math.max(1, safePlotBottom);
  const effectiveMinimumHeight = Math.min(MIN_PLOT_HEIGHT, availableHeight);
  const maximumPlotTop = safePlotBottom - effectiveMinimumHeight;
  let safePlotTop = Math.max(0, Math.min(options.plotTop, maximumPlotTop));

  if (!Number.isFinite(safePlotTop) || safePlotTop >= safePlotBottom) {
    safePlotTop = Math.max(0, safePlotBottom - 1);
  }

  const safeWidth = Number.isFinite(options.width) ? Math.max(1, options.width) : 1;
  const requestedPlotLeft = options.hasDualAxis ? 76 : 54;
  const requestedPlotRight = safeWidth - 76;
  const safePlotLeft = Math.min(
    Math.max(0, requestedPlotLeft),
    Math.max(0, safeWidth - 1)
  );
  const safePlotRight = Math.max(
    safePlotLeft + 1,
    Math.min(safeWidth, requestedPlotRight)
  );

  return {
    plotLeft: safePlotLeft,
    plotRight: safePlotRight,
    plotTop: safePlotTop,
    plotBottom: safePlotBottom,
    xCount: options.xCount,
  };
}

type StyledSeries = { series: ChartSeries; style: SeriesStyle };

function splitRenderableSeries(
  section: ReportChartSection,
  leftSeries: ChartSeries[]
): { bars: StyledSeries[]; lines: StyledSeries[] } {
  const barSeries = leftSeries
    .map((series, index) => ({
      series,
      style: styleForSectionSeries(section, series, index),
      index,
    }))
    .filter((entry) => resolveSeriesMark(entry.series, section.chartType) === "bar");
  const lineSeries = leftSeries
    .map((series, index) => ({
      series,
      style: styleForSectionSeries(section, series, index),
      index,
    }))
    .filter((entry) => resolveSeriesMark(entry.series, section.chartType) === "line");

  // Default mark when no renderAs: section chartType drives all series as bars.
  const defaultBar =
    section.chartType === "bar" && barSeries.length === 0 && lineSeries.length === 0;
  if (defaultBar) {
    return {
      bars: leftSeries.map((series, index) => ({
        series,
        style: styleForSectionSeries(section, series, index),
      })),
      lines: [],
    };
  }
  return {
    bars: barSeries.map(({ series, style }) => ({ series, style })),
    lines: lineSeries.map(({ series, style }) => ({ series, style })),
  };
}

function resolveAxisChartType(
  sectionChartType: ReportChartSection["chartType"],
  barCount: number
): ReportChartSection["chartType"] {
  if (sectionChartType === "line" && barCount === 0) return "line";
  return "bar";
}

function resolveLineRenderChartType(
  sectionChartType: ReportChartSection["chartType"],
  barCount: number
): ReportChartSection["chartType"] {
  if (barCount > 0) return "bar";
  return sectionChartType;
}

function buildChartSvgBody(options: {
  section: ReportChartSection;
  width: number;
  height: number;
  geo: ChartGeometry;
  categories: string[];
  ticks: number[];
  yMax: number;
  ticksRight: number[] | null;
  yMaxRight: number;
  hasDualAxis: boolean;
  bars: StyledSeries[];
  lines: StyledSeries[];
  legendSvg: string;
  rightSeries: ChartSeries[];
  renderOptions: Required<ChartRenderOptions>;
}): string {
  const {
    section,
    width,
    height,
    geo,
    categories,
    ticks,
    yMax,
    ticksRight,
    yMaxRight,
    hasDualAxis,
    bars,
    lines,
    legendSvg,
    rightSeries,
    renderOptions,
  } = options;
  const title = escapeXml(section.title);
  const axisChartType = resolveAxisChartType(section.chartType, bars.length);
  const lineRenderType = resolveLineRenderChartType(section.chartType, bars.length);
  const titleSvg = section.title
    ? `<text x="${width / 2}" y="24" text-anchor="middle" font-size="15" fill="${COLORS.primary}" direction="rtl" unicode-bidi="plaintext">${title}</text>`
    : "";
  const barsSvg = bars.length > 0 ? renderBarSeries(geo, bars, yMax, categories) : "";
  const barTopYByCategory = new Map<string, number>();
  for (const { series } of bars) {
    for (const point of series.points) {
      if (point.y <= 0) continue;
      if (!barTopYByCategory.has(point.x)) {
        barTopYByCategory.set(point.x, yForValue(geo, point.y, yMax));
      }
    }
  }
  const linesSvg = lines.length > 0
    ? renderLineSeries({
      geo,
      seriesList: lines,
      yMax,
      categories,
      chartType: lineRenderType,
      showPointValues: renderOptions.showLinePointValues,
      barTopYByCategory,
    })
    : "";
  const dualSvg = hasDualAxis
    ? renderRightAxisLines(geo, rightSeries, yMaxRight, categories, section.chartType)
    : "";
  const secondaryScale: SecondaryChartAxisScale =
    hasDualAxis && ticksRight !== null
      ? {
          ticks: ticksRight,
          max: yMaxRight,
        }
      : null;
  const axesSvg = renderAxesWithOptionalSecondary({
    geo,
    primaryScale: {
      ticks,
      max: yMax,
    },
    labels: categories,
    chartType: axisChartType,
    secondaryScale,
    renderOptions,
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${fontStyleBlock()}
    <rect width="${width}" height="${height}" fill="${COLORS.white}" stroke="${COLORS.border}"/>
    ${titleSvg}
    ${legendSvg}
    ${axesSvg}
    ${barsSvg}
    ${linesSvg}
    ${dualSvg}
  </svg>`;
}

/** Exported for snapshot tests; not part of the public rendering API. */
export function buildChartSvg(
  section: ReportChartSection,
  width: number,
  height: number,
  options?: ChartRenderOptions
): string {
  const renderOptions = resolveChartRenderOptions(options);
  const { leftSeries, rightSeries, hasDualAxis } = resolveAxisSeries(section);
  const categories = resolveChartCategories(section, leftSeries);
  const scales = computeChartAxisScales(leftSeries, rightSeries, hasDualAxis);
  const legendItems = buildLegendItems(leftSeries, rightSeries, hasDualAxis, section);
  const legendTop = section.title ? 40 : 14;
  const legend = drawChartLegend(legendItems, {
    width,
    top: legendTop,
    columns: resolveLegendColumnCount(legendItems.length),
  });
  const geo = resolveChartGeometry({
    width,
    height,
    hasDualAxis,
    plotTop: legendTop + legend.height + 6,
    xCount: categories.length,
    bottomReserve: resolveXAxisBottomReserve(renderOptions.xLabelLayout),
  });
  const { bars, lines } = splitRenderableSeries(section, leftSeries);
  return buildChartSvgBody({
    section,
    width,
    height,
    geo,
    categories,
    ticks: scales.ticks,
    yMax: scales.yMax,
    ticksRight: scales.ticksRight,
    yMaxRight: scales.yMaxRight,
    hasDualAxis,
    bars,
    lines,
    legendSvg: legend.svg,
    rightSeries,
    renderOptions,
  });
}

function emptyChartSvg(section: ReportChartSection, width: number, height: number): string {
  const message = escapeXml(section.emptyState ?? "لا توجد بيانات");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${fontStyleBlock()}
    <rect width="${width}" height="${height}" fill="${COLORS.white}" stroke="${COLORS.border}"/>
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="16" fill="${COLORS.neutral}" direction="rtl">${message}</text>
  </svg>`;
}

/**
 * Renders a line chart section to a PNG buffer using sharp/librsvg.
 * Fontconfig is configured before the first call so the Amiri font is
 * available for Arabic text rendering. On empty data, returns a PNG bearing
 * the empty-state text. Throws (never swallows) if sharp fails.
 */
export async function renderLineChartPng(
  section: ReportChartSection,
  widthPx: number,
  heightPx: number,
  options?: ChartRenderOptions
): Promise<Buffer> {
  configureReportFontconfig();

  const width = Math.max(MIN_CHART_WIDTH, Math.round(widthPx));
  const height = Math.max(MIN_CHART_HEIGHT, Math.round(heightPx));

  const hasData = section.series.some((series) => series.points.length > 0);
  const svg = hasData
    ? buildChartSvg(section, width, height, options)
    : emptyChartSvg(section, width, height);

  try {
    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`تعذر تحويل الرسم البياني إلى صورة: ${reason}`);
  }
}
