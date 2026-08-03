import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ReportChartSection } from "./report-data-service";
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

type SeriesStyle = { color: string; dash: string; width: number };

const COLORS = REPORT_DESIGN_TOKENS.colors;

const SERIES_STYLES: SeriesStyle[] = [
  { color: COLORS.primary, dash: "0", width: 2 },
  { color: COLORS.gold, dash: "6,3", width: 2 },
  { color: COLORS.primary, dash: "2,3", width: 2 },
  { color: COLORS.neutral, dash: "6,3,2,3", width: 2 },
  { color: COLORS.primary, dash: "10,4", width: 2 },
  { color: COLORS.neutral, dash: "4,2", width: 2 },
  { color: COLORS.primary, dash: "2,2", width: 2 },
  { color: COLORS.neutral, dash: "0", width: 1 },
];

const OTHER_STYLE: SeriesStyle = { color: COLORS.neutral, dash: "5,3", width: 1.5 };

// Right-axis (secondary) line series styles for dual-axis charts.
// Index 0 → open-at-end (green), index 1 → late-at-end (red).
const RIGHT_AXIS_STYLES: SeriesStyle[] = [
  { color: COLORS.primary, dash: "0", width: 2 },
  { color: COLORS.danger, dash: "0", width: 2 },
];

function seriesStyle(index: number, isOther: boolean): SeriesStyle {
  if (isOther) return OTHER_STYLE;
  return SERIES_STYLES[index % SERIES_STYLES.length];
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

/** Chooses a "nice" upper bound and tick step for the Y axis. */
function computeYScale(maxValue: number): { max: number; ticks: number[] } {
  if (maxValue <= 0) {
    return { max: 1, ticks: [0, 1] };
  }
  const roughStep = maxValue / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceStep: number;
  if (normalized <= 1) niceStep = magnitude;
  else if (normalized <= 2) niceStep = 2 * magnitude;
  else if (normalized <= 5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;
  const max = Math.ceil(maxValue / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let value = 0; value <= max + 1e-9; value += niceStep) {
    ticks.push(Math.round(value * 100) / 100);
  }
  return { max, ticks };
}

/** Short date label: "MM/DD" from a YYYY-MM-DD string. */
function shortDateLabel(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${parts[1]}/${parts[2]}`;
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

function xForIndex(geo: ChartGeometry, index: number): number {
  if (geo.xCount <= 1) return (geo.plotLeft + geo.plotRight) / 2;
  const t = index / (geo.xCount - 1);
  return geo.plotLeft + t * (geo.plotRight - geo.plotLeft);
}

function yForValue(geo: ChartGeometry, value: number, yMax: number): number {
  const t = yMax === 0 ? 0 : value / yMax;
  return geo.plotBottom - t * (geo.plotBottom - geo.plotTop);
}


function renderLineSeries(geo: ChartGeometry, section: ReportChartSection, yMax: number): string {
  const parts: string[] = [];
  section.series.forEach((series, seriesIndex) => {
    const style = seriesStyle(seriesIndex, series.isOther === true);
    const points = series.points.map((point, index) => {
      const x = xForIndex(geo, index);
      const y = yForValue(geo, point.y, yMax);
      return { x, y };
    });
    if (points.length === 0) return;
    const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const dashAttr = style.dash === "0" ? "" : ` stroke-dasharray="${style.dash}"`;
    parts.push(`<polyline fill="none" stroke="${style.color}" stroke-width="${style.width}"${dashAttr} points="${polyline}"/>`);
    for (const p of points) {
      parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.2" fill="${style.color}"/>`);
    }
  });
  return parts.join("\n");
}

/**
 * Builds a canonical category list by taking the union of all point.x values
 * across every series, in first-occurrence order. This is the single source of
 * truth for bar chart axis labels and bar positions so that:
 *  - missing categories in a series are filled with zero (bar simply absent)
 *  - no bar appears under the wrong category label
 *  - order is stable and predictable regardless of which series is "first"
 *
 * Exported for unit tests; not part of the public rendering API.
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
  section: ReportChartSection,
  yMax: number,
  categories: string[]
): string {
  const parts: string[] = [];
  const categoryCount = Math.max(1, categories.length);
  const seriesCount = Math.max(1, section.series.length);
  const categoryWidth = (geo.plotRight - geo.plotLeft) / categoryCount;
  const groupWidth = categoryWidth * 0.72;
  const barWidth = Math.max(2, groupWidth / seriesCount);
  const categoryIndex = new Map(categories.map((cat, i) => [cat, i]));
  const preferredLabelY = (valueY: number) => valueY - 3;
  const minLabelY = geo.plotTop + 10;
  section.series.forEach((series, seriesIndex) => {
    const style = seriesStyle(seriesIndex, series.isOther === true);
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
        const unclampedY = preferredLabelY(valueY);
        const clampedInsideBar = unclampedY < minLabelY;
        // When a tall bar would push the label above the plot, place it inside
        // the bar in white for contrast; otherwise keep series color above the bar.
        const labelY = (clampedInsideBar ? Math.min(valueY + 12, geo.plotBottom - 2) : unclampedY)
          .toFixed(1);
        const labelFill = clampedInsideBar ? COLORS.white : style.color;
        const labelFs = Math.max(7, Math.min(10, Math.round(bw * 0.55)));
        parts.push(
          `<text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="${labelFs}" fill="${labelFill}">${escapeXml(formatReportNumber(point.y))}</text>`
        );
      }
    });
  });
  return parts.join("\n");
}

function renderSeries(
  geo: ChartGeometry,
  section: ReportChartSection,
  yMax: number,
  categories: string[]
): string {
  return section.chartType === "bar"
    ? renderBarSeries(geo, section, yMax, categories)
    : renderLineSeries(geo, section, yMax);
}

/** Renders right-axis line series using a secondary Y-scale. */
function renderRightAxisLines(
  geo: ChartGeometry,
  rightSeries: ReportChartSection["series"],
  yMaxRight: number,
  categories: string[],
  chartType: ReportChartSection["chartType"]
): string {
  const parts: string[] = [];
  const catIndex = new Map(categories.map((c, i) => [c, i]));
  const catCount = Math.max(1, categories.length);
  const catWidth = (geo.plotRight - geo.plotLeft) / catCount;

  rightSeries.forEach((series, si) => {
    const style = rightAxisStyle(si);
    const points = series.points
      .map((p) => {
        const idx = catIndex.get(p.x);
        if (idx === undefined) return null;
        // Bar charts share category centers with bar groups; line charts use the shared time axis spacing.
        const x = chartType === "bar"
          ? geo.plotLeft + (idx + 0.5) * catWidth
          : xForIndex(geo, idx);
        const y = yForValue(geo, p.y, yMaxRight);
        return { x, y };
      })
      .filter((p): p is { x: number; y: number } => p !== null);
    if (points.length === 0) return;
    const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    parts.push(
      `<polyline fill="none" stroke="${style.color}" stroke-width="${style.width}" points="${polyline}"/>`
    );
    for (const p of points) {
      parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${COLORS.white}" stroke="${style.color}" stroke-width="1.5"/>`);
    }
  });
  return parts.join("\n");
}

/** Renders axes, optionally adding a secondary Y-axis on the left for dual-axis charts. */
function renderAxesWithOptionalSecondary(
  geo: ChartGeometry,
  yTicks: number[],
  yMax: number,
  dates: string[],
  chartType: ReportChartSection["chartType"],
  rightTicks: number[] | null,
  yMaxRight: number | null
): string {
  const parts: string[] = [];
  // Primary axis line (left edge of plot)
  parts.push(
    `<line x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" stroke="${COLORS.border}" stroke-width="1"/>`,
    `<line x1="${geo.plotLeft}" y1="${geo.plotBottom}" x2="${geo.plotRight}" y2="${geo.plotBottom}" stroke="${COLORS.border}" stroke-width="1"/>`
  );
  // Primary Y-axis labels (right side)
  for (const tick of yTicks) {
    const y = yForValue(geo, tick, yMax);
    parts.push(
      `<line x1="${geo.plotLeft}" y1="${y}" x2="${geo.plotRight}" y2="${y}" stroke="${COLORS.border}" stroke-width="1" opacity="0.4"/>`,
      `<text x="${geo.plotRight + 6}" y="${y + 4}" text-anchor="start" font-size="11" fill="${COLORS.neutral}">${formatReportNumber(tick)}</text>`
    );
  }
  // Secondary Y-axis (left) for dual-axis — dash line aligns with secondary labels
  if (rightTicks && yMaxRight !== null) {
    parts.push(
      `<line x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" stroke="${COLORS.border}" stroke-width="1" stroke-dasharray="3,3"/>`
    );
    for (const tick of rightTicks) {
      const y = yForValue(geo, tick, yMaxRight);
      parts.push(
        `<text x="${geo.plotLeft - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="${COLORS.danger}">${formatReportNumber(tick)}</text>`
      );
    }
  }
  // X-axis labels
  const maxLabels = 12;
  const step = Math.max(1, Math.ceil(dates.length / maxLabels));
  dates.forEach((date, index) => {
    if (index % step !== 0 && index !== dates.length - 1) return;
    const x = chartType === "bar"
      ? geo.plotLeft + (index + 0.5) * (geo.plotRight - geo.plotLeft) / Math.max(1, dates.length)
      : xForIndex(geo, index);
    parts.push(
      `<text x="${x}" y="${geo.plotBottom + 18}" text-anchor="middle" font-size="11" fill="${COLORS.neutral}" direction="rtl">${escapeXml(shortDateLabel(date))}</text>`
    );
  });
  return parts.join("\n");
}

type LegendStyleItem = {
  name: string;
  style: SeriesStyle;
};

function renderLegend(items: LegendStyleItem[], width: number, legendTop: number): string {
  const parts: string[] = [];
  const itemHeight = 16;
  const swatchWidth = 22;
  items.forEach((item, seriesIndex) => {
    const { style } = item;
    const row = Math.floor(seriesIndex / 3);
    const column = seriesIndex % 3;
    const centerX = width - (column + 0.5) * width / 3;
    const currentX = centerX + 52;
    const lineY = legendTop + row * itemHeight + 6;
    const dashAttr = style.dash === "0" ? "" : ` stroke-dasharray="${style.dash}"`;
    parts.push(
      `<line x1="${currentX - swatchWidth}" y1="${lineY}" x2="${currentX}" y2="${lineY}" stroke="${style.color}" stroke-width="${style.width}"${dashAttr}/>`,
      `<text x="${currentX - swatchWidth - 4}" y="${lineY + 4}" text-anchor="end" font-size="11" fill="${COLORS.primary}" direction="rtl">${escapeXml(item.name)}</text>`
    );
  });
  return parts.join("\n");
}

function buildLegendItems(
  leftSeries: ReportChartSection["series"],
  rightSeries: ReportChartSection["series"],
  hasDualAxis: boolean,
  allSeries: ReportChartSection["series"]
): LegendStyleItem[] {
  if (!hasDualAxis) {
    return allSeries.map((series, index) => ({
      name: series.name,
      style: seriesStyle(index, series.isOther === true),
    }));
  }
  const leftItems = leftSeries.map((series, index) => ({
    name: series.name,
    style: seriesStyle(index, series.isOther === true),
  }));
  const rightItems = rightSeries.map((series, index) => ({
    name: series.name,
    style: rightAxisStyle(index),
  }));
  return [...leftItems, ...rightItems];
}

/** Exported for snapshot tests; not part of the public rendering API. */
export function buildChartSvg(section: ReportChartSection, width: number, height: number): string {
  // Dual-axis only when both left and right series exist; all-right is single-axis.
  const leftCandidates = section.series.filter((s) => s.axis !== "right");
  const hasDualAxis = leftCandidates.length > 0 && section.series.some((s) => s.axis === "right");
  const leftSeries = hasDualAxis ? leftCandidates : section.series;
  const rightSeries = hasDualAxis ? section.series.filter((s) => s.axis === "right") : [];

  // Bar charts build a union of all series categories so every bar aligns
  // with its correct label even when series have different or missing entries.
  // Line charts use the first series as the shared time axis (all series are
  // expected to share the same date points).
  const primarySeries = leftSeries;
  const categories = section.chartType === "bar"
    ? buildCategoryUnion({ ...section, series: primarySeries })
    : (primarySeries[0]?.points.map((p) => p.x) ?? []);

  const leftMaxValue = leftSeries.reduce(
    (max, s) => s.points.reduce((m, p) => Math.max(m, p.y), max), 0
  );
  const rightMaxValue = rightSeries.reduce(
    (max, s) => s.points.reduce((m, p) => Math.max(m, p.y), max), 0
  );
  const { max: yMax, ticks } = computeYScale(hasDualAxis ? leftMaxValue : Math.max(leftMaxValue, rightMaxValue));
  const { max: yMaxRight, ticks: ticksRight } = hasDualAxis ? computeYScale(rightMaxValue) : { max: yMax, ticks };

  const legendItems = buildLegendItems(leftSeries, rightSeries, hasDualAxis, section.series);
  const legendRows = Math.max(1, Math.ceil(legendItems.length / 3));
  const legendHeight = 12 + legendRows * 16;
  const geo: ChartGeometry = {
    plotLeft: hasDualAxis ? 76 : 54,
    plotRight: width - 76,
    plotTop: 48,
    plotBottom: height - 46 - legendHeight,
    xCount: categories.length,
  };
  const leftSection = { ...section, series: leftSeries };
  const title = escapeXml(section.title);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${fontStyleBlock()}
    <rect width="${width}" height="${height}" fill="${COLORS.white}" stroke="${COLORS.border}"/>
    <text x="${width / 2}" y="28" text-anchor="middle" font-size="16" fill="${COLORS.primary}" direction="rtl" unicode-bidi="plaintext">${title}</text>
    ${renderAxesWithOptionalSecondary(geo, ticks, yMax, categories, section.chartType, hasDualAxis ? ticksRight : null, hasDualAxis ? yMaxRight : null)}
    ${renderSeries(geo, leftSection, yMax, categories)}
    ${hasDualAxis ? renderRightAxisLines(geo, rightSeries, yMaxRight, categories, section.chartType) : ""}
    ${renderLegend(legendItems, width, geo.plotBottom + 28)}
  </svg>`;
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
  heightPx: number
): Promise<Buffer> {
  configureReportFontconfig();

  const width = Math.max(MIN_CHART_WIDTH, Math.round(widthPx));
  const height = Math.max(MIN_CHART_HEIGHT, Math.round(heightPx));

  const hasData = section.series.some((series) => series.points.length > 0);
  const svg = hasData ? buildChartSvg(section, width, height) : emptyChartSvg(section, width, height);

  try {
    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`تعذر تحويل الرسم البياني إلى صورة: ${reason}`);
  }
}
