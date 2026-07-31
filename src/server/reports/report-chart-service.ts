import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { ReportChartSection } from "./report-data-service";

// ---------------------------------------------------------------------------
// Pure server-side SVG line-chart renderer -> PNG (via sharp). No DOM, no
// canvas, no browser, no external service. Arabic labels render correctly
// because the Amiri font is embedded into the SVG as a base64 @font-face.
// The chart is print-safe in black & white: each series has a distinct
// stroke-dasharray pattern in addition to its color.
// ---------------------------------------------------------------------------

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");

export const MIN_CHART_WIDTH = 500;
export const MIN_CHART_HEIGHT = 300;

type SeriesStyle = { color: string; dash: string; width: number };

// series index -> style. Cycles if there are more than 8 series.
const SERIES_STYLES: SeriesStyle[] = [
  { color: "#1e40af", dash: "0", width: 2 }, // solid blue
  { color: "#b45309", dash: "6,3", width: 2 }, // dashed amber
  { color: "#065f46", dash: "2,3", width: 2 }, // dotted green
  { color: "#7c3aed", dash: "6,3,2,3", width: 2 }, // dash-dot purple
  { color: "#be123c", dash: "10,4", width: 2 }, // long-dash rose
  { color: "#0e7490", dash: "4,2", width: 2 }, // short-dash cyan
  { color: "#92400e", dash: "2,2", width: 2 }, // dots brown
  { color: "#374151", dash: "0", width: 1 }, // solid-thin gray
];

// Aggregated "other" series always renders as gray/dashed.
const OTHER_STYLE: SeriesStyle = { color: "#6b7280", dash: "5,3", width: 1.5 };

let fontBase64: string | null = null;

function loadFontBase64(): string {
  fontBase64 ??= fs.readFileSync(FONT_REGULAR_PATH).toString("base64");
  return fontBase64;
}

function seriesStyle(index: number, isOther: boolean): SeriesStyle {
  if (isOther) return OTHER_STYLE;
  return SERIES_STYLES[index % SERIES_STYLES.length];
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

function fontFaceStyle(): string {
  const base64 = loadFontBase64();
  return `<style>
    @font-face {
      font-family: "Amiri";
      src: url("data:font/ttf;base64,${base64}") format("truetype");
    }
    text { font-family: "Amiri", sans-serif; }
  </style>`;
}

function emptyChartSvg(section: ReportChartSection, width: number, height: number): string {
  const message = escapeXml(section.emptyState ?? "لا توجد بيانات");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${fontFaceStyle()}
    <rect width="${width}" height="${height}" fill="#ffffff" stroke="#e2e8f0"/>
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="16" fill="#64748b" direction="rtl">${message}</text>
  </svg>`;
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

function renderAxes(geo: ChartGeometry, yTicks: number[], yMax: number, dates: string[]): string {
  const parts: string[] = [];
  // Axis lines.
  parts.push(
    `<line x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" stroke="#94a3b8" stroke-width="1"/>`,
    `<line x1="${geo.plotLeft}" y1="${geo.plotBottom}" x2="${geo.plotRight}" y2="${geo.plotBottom}" stroke="#94a3b8" stroke-width="1"/>`
  );

  // Y gridlines + labels (labels on the right for RTL).
  for (const tick of yTicks) {
    const y = yForValue(geo, tick, yMax);
    parts.push(
      `<line x1="${geo.plotLeft}" y1="${y}" x2="${geo.plotRight}" y2="${y}" stroke="#eef2f7" stroke-width="1"/>`,
      `<text x="${geo.plotRight + 6}" y="${y + 4}" text-anchor="start" font-size="10" fill="#475569">${tick}</text>`
    );
  }

  // X labels — thin them out so they never overlap.
  const maxLabels = 12;
  const step = Math.max(1, Math.ceil(dates.length / maxLabels));
  dates.forEach((date, index) => {
    if (index % step !== 0 && index !== dates.length - 1) return;
    const x = xForIndex(geo, index);
    parts.push(
      `<text x="${x}" y="${geo.plotBottom + 16}" text-anchor="middle" font-size="9" fill="#475569">${escapeXml(shortDateLabel(date))}</text>`
    );
  });

  return parts.join("\n");
}

function renderSeries(
  geo: ChartGeometry,
  section: ReportChartSection,
  yMax: number
): string {
  const parts: string[] = [];
  section.series.forEach((series, seriesIndex) => {
    const style = seriesStyle(seriesIndex, series.isOther === true);
    const points = series.points.map((point, index) => {
      const x = xForIndex(geo, index);
      const y = yForValue(geo, point.y, yMax);
      return { x, y };
    });
    if (points.length === 0) return;
    const polyline = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    const dashAttr = style.dash === "0" ? "" : ` stroke-dasharray="${style.dash}"`;
    parts.push(
      `<polyline fill="none" stroke="${style.color}" stroke-width="${style.width}"${dashAttr} points="${polyline}"/>`
    );
    for (const point of points) {
      parts.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.2" fill="${style.color}"/>`);
    }
  });
  return parts.join("\n");
}

function renderLegend(section: ReportChartSection, width: number, legendTop: number): string {
  const parts: string[] = [];
  const itemHeight = 16;
  const swatchWidth = 22;
  // Legend laid out right-to-left.
  let currentY = legendTop;
  let currentX = width - 12;
  const columnWidth = 150;
  section.series.forEach((series, seriesIndex) => {
    const style = seriesStyle(seriesIndex, series.isOther === true);
    if (currentX - columnWidth < 12) {
      currentX = width - 12;
      currentY += itemHeight;
    }
    const lineY = currentY + 6;
    const dashAttr = style.dash === "0" ? "" : ` stroke-dasharray="${style.dash}"`;
    parts.push(
      `<line x1="${currentX - swatchWidth}" y1="${lineY}" x2="${currentX}" y2="${lineY}" stroke="${style.color}" stroke-width="${style.width}"${dashAttr}/>`,
      `<text x="${currentX - swatchWidth - 4}" y="${lineY + 4}" text-anchor="end" font-size="10" fill="#334155" direction="rtl">${escapeXml(series.name)}</text>`
    );
    currentX -= columnWidth;
  });
  return parts.join("\n");
}

function buildChartSvg(section: ReportChartSection, width: number, height: number): string {
  const dates = section.series[0]?.points.map((point) => point.x) ?? [];
  const maxValue = section.series.reduce(
    (max, series) => series.points.reduce((seriesMax, point) => Math.max(seriesMax, point.y), max),
    0
  );
  const { max: yMax, ticks } = computeYScale(maxValue);

  const legendRows = Math.max(1, Math.ceil(section.series.length / 3));
  const legendHeight = 12 + legendRows * 16;
  const geo: ChartGeometry = {
    plotLeft: 40,
    plotRight: width - 44,
    plotTop: 40,
    plotBottom: height - 40 - legendHeight,
    xCount: dates.length,
  };

  const title = escapeXml(section.title);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${fontFaceStyle()}
    <rect width="${width}" height="${height}" fill="#ffffff" stroke="#e2e8f0"/>
    <text x="${width - 12}" y="24" text-anchor="end" font-size="14" fill="#0f172a" direction="rtl">${title}</text>
    ${renderAxes(geo, ticks, yMax, dates)}
    ${renderSeries(geo, section, yMax)}
    ${renderLegend(section, width, geo.plotBottom + 28)}
  </svg>`;
}

/**
 * Renders a line chart section to a PNG buffer. On empty data, returns a PNG
 * bearing the empty-state text. Throws (never swallows) if sharp fails to
 * convert the SVG, so the caller can surface a placeholder + warning.
 */
export async function renderLineChartPng(
  section: ReportChartSection,
  widthPx: number,
  heightPx: number
): Promise<Buffer> {
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
