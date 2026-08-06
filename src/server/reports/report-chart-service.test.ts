// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  escapeXml,
  renderLineChartPng,
  configureReportFontconfig,
  buildCategoryUnion,
  buildChartSvg,
  drawChartLegend,
  computeYScale,
  resolveLegendColumnCount,
  resolveChartGeometry,
  fitLegendLabel,
  resolveXAxisLabelStep,
  wrapCategoricalAxisLabel,
  resolveXAxisBottomReserve,
  resolveBarValueLabelPlacement,
  resolveLineValueLabelPlacement,
  LINE_VALUE_LABEL_COLLISION_PX,
  MIN_PLOT_HEIGHT,
  CHART_LEGEND_GAP,
} from "./report-chart-service";
import type { ReportChartSection } from "./report-data-service";
import { REPORT_DESIGN_TOKENS } from "@/lib/reports/design-tokens";
import sharp from "sharp";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const DANGER = REPORT_DESIGN_TOKENS.colors.danger;
const PRIMARY = REPORT_DESIGN_TOKENS.colors.primary;
const GOLD = REPORT_DESIGN_TOKENS.colors.gold;

describe("escapeXml", () => {
  it("escapes all five XML/SVG special characters", () => {
    expect(escapeXml('& < > " \'')).toBe("&amp; &lt; &gt; &quot; &apos;");
  });

  it("does not double-escape already-escaped entities", () => {
    expect(escapeXml("a & b")).toBe("a &amp; b");
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves Arabic text and digits unchanged", () => {
    const arabic = "منطقة الرياض 123";
    expect(escapeXml(arabic)).toBe(arabic);
  });

  it("handles an empty string", () => {
    expect(escapeXml("")).toBe("");
  });

  it("escapes all occurrences, not just the first", () => {
    expect(escapeXml("a & b & c")).toBe("a &amp; b &amp; c");
    expect(escapeXml("<<>>")).toBe("&lt;&lt;&gt;&gt;");
  });
});

describe("configureReportFontconfig", () => {
  it("sets FONTCONFIG_FILE to an existing file", () => {
    configureReportFontconfig();
    const confPath = process.env.FONTCONFIG_FILE;
    expect(confPath).toBeTruthy();
    expect(fs.existsSync(confPath!)).toBe(true);
  });
});

describe("Arabic font rendering smoke test", () => {
  it("fonts.conf exists in assets", () => {
    const confPath = path.join(ASSETS_DIR, "fontconfig", "fonts.conf");
    expect(fs.existsSync(confPath)).toBe(true);
  });

  it("Amiri-Regular.ttf exists in assets", () => {
    const fontPath = path.join(ASSETS_DIR, "fonts", "Amiri-Regular.ttf");
    expect(fs.existsSync(fontPath)).toBe(true);
  });

  it("renders a PNG with Arabic title and series labels without error", async () => {
    const section: ReportChartSection = {
      id: "test_chart",
      kind: "chart",
      chartType: "line",
      title: "الاتجاه الزمني للشكاوى حسب المنطقة",
      series: [
        {
          name: "منطقة الرياض",
          points: [
            { x: "2026-07-01", y: 10 },
            { x: "2026-07-02", y: 15 },
            { x: "2026-07-03", y: 8 },
          ],
        },
        {
          name: "منطقة جدة",
          points: [
            { x: "2026-07-01", y: 5 },
            { x: "2026-07-02", y: 7 },
            { x: "2026-07-03", y: 12 },
          ],
        },
      ],
    };

    const buffer = await renderLineChartPng(section, 600, 400);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("renders an Arabic grouped bar chart for all regions", async () => {
    const section: ReportChartSection = {
      id: "regions",
      kind: "chart",
      chartType: "bar",
      title: "مقارنة المناطق",
      series: [
        { name: "الفترة الحالية", points: [{ x: "منطقة الرياض", y: 10 }, { x: "منطقة مكة المكرمة", y: 7 }] },
        { name: "الفترة المقارنة", points: [{ x: "منطقة الرياض", y: 8 }, { x: "منطقة مكة المكرمة", y: 9 }] },
      ],
    };
    const buffer = await renderLineChartPng(section, 900, 360);
    expect(buffer.slice(1, 4).toString()).toBe("PNG");
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("SVG does not embed @font-face or base64 font data", async () => {
    const section: ReportChartSection = {
      id: "test",
      kind: "chart",
      chartType: "line",
      title: "اختبار",
      series: [{ name: "سلسلة", points: [{ x: "2026-07-01", y: 1 }] }],
    };
    // The smoke test above (PNG renders without error) is the functional proof.
    // This test verifies the font-family declaration appears in the module source.
    void section;
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), "src/server/reports/report-chart-service.ts"),
      "utf8"
    );
    expect(sourceCode).not.toContain("@font-face");
    expect(sourceCode).not.toContain("data:font/ttf;base64");
    expect(sourceCode).toContain('font-family: "Amiri"');
  });

  it("source code has no duplicate 'const x =' in the same function scope", () => {
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), "src/server/reports/report-chart-service.ts"),
      "utf8"
    );
    // Split by function boundaries (rough heuristic) and ensure no function block
    // contains two 'const x =' assignments.
    const functionBlocks = sourceCode.split(/^function /m);
    for (const block of functionBlocks) {
      const matches = block.match(/\bconst x\b/g);
      expect((matches?.length ?? 0)).toBeLessThanOrEqual(1);
    }
  });
});

describe("buildCategoryUnion", () => {
  function barSection(
    series: Array<{ name: string; points: Array<{ x: string; y: number }> }>
  ): ReportChartSection {
    return { id: "s", kind: "chart", chartType: "bar", title: "T", series };
  }

  it("returns categories in first-occurrence order across all series", () => {
    const section = barSection([
      { name: "A", points: [{ x: "منطقة الرياض", y: 10 }, { x: "منطقة جدة", y: 5 }] },
      { name: "B", points: [{ x: "منطقة مكة المكرمة", y: 8 }, { x: "منطقة الرياض", y: 3 }] },
    ]);
    expect(buildCategoryUnion(section)).toEqual([
      "منطقة الرياض",
      "منطقة جدة",
      "منطقة مكة المكرمة",
    ]);
  });

  it("does not duplicate categories that appear in multiple series", () => {
    const section = barSection([
      { name: "A", points: [{ x: "X", y: 1 }, { x: "Y", y: 2 }] },
      { name: "B", points: [{ x: "Y", y: 3 }, { x: "Z", y: 4 }] },
    ]);
    const union = buildCategoryUnion(section);
    expect(union).toEqual(["X", "Y", "Z"]);
    expect(new Set(union).size).toBe(union.length);
  });

  it("handles a series with a missing category", () => {
    const section = barSection([
      { name: "A", points: [{ x: "Alpha", y: 5 }, { x: "Beta", y: 3 }] },
      { name: "B", points: [{ x: "Alpha", y: 2 }] },
    ]);
    expect(buildCategoryUnion(section)).toEqual(["Alpha", "Beta"]);
  });

  it("returns empty array for sections with no points", () => {
    const section = barSection([{ name: "A", points: [] }]);
    expect(buildCategoryUnion(section)).toEqual([]);
  });

  it("handles different category order between series", () => {
    const section = barSection([
      { name: "A", points: [{ x: "Beta", y: 1 }, { x: "Alpha", y: 2 }] },
      { name: "B", points: [{ x: "Alpha", y: 3 }, { x: "Beta", y: 4 }] },
    ]);
    // Order follows first-occurrence across series traversal
    expect(buildCategoryUnion(section)).toEqual(["Beta", "Alpha"]);
  });
});

describe("buildChartSvg — bar chart category alignment", () => {
  function barSection(
    series: Array<{ name: string; points: Array<{ x: string; y: number }> }>
  ): ReportChartSection {
    return { id: "s", kind: "chart", chartType: "bar", title: "مخطط اختبار", series };
  }

  it("SVG x-axis labels match category union order when series have different orders", () => {
    const section = barSection([
      { name: "الفترة الحالية", points: [{ x: "Beta", y: 10 }, { x: "Alpha", y: 5 }] },
      { name: "الفترة السابقة", points: [{ x: "Alpha", y: 8 }, { x: "Beta", y: 3 }] },
    ]);
    const svg = buildChartSvg(section, 600, 400);
    // Both category labels must appear in the SVG
    expect(svg).toContain("Beta");
    expect(svg).toContain("Alpha");
    // Beta appears first in first series so its label should come before Alpha in SVG
    const betaPos = svg.indexOf("Beta");
    const alphaPos = svg.indexOf("Alpha");
    expect(betaPos).toBeLessThan(alphaPos);
  });

  it("SVG contains rect elements for all categories even when one series is missing a category", () => {
    const section = barSection([
      { name: "A", points: [{ x: "الرياض", y: 10 }, { x: "جدة", y: 5 }] },
      { name: "B", points: [{ x: "الرياض", y: 8 }] }, // missing "جدة"
    ]);
    const svg = buildChartSvg(section, 600, 400);
    // "جدة" should still appear as an axis label
    expect(svg).toContain("جدة");
    expect(svg).toContain("الرياض");
    // Count bar rects only (exclude legend swatches which use rx=)
    const barRectCount = (svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="/g) ?? []).length;
    // Series A: 2 bars, Series B: 1 bar = 3 total
    expect(barRectCount).toBe(3);
  });

  it("each bar rect appears at the correct x position relative to its axis label", () => {
    const section = barSection([
      { name: "فقط", points: [{ x: "الرياض", y: 20 }, { x: "جدة", y: 10 }] },
    ]);
    const svg = buildChartSvg(section, 600, 400);
    // Extract axis label x positions
    const labelMatches = [...svg.matchAll(/<text x="([^"]+)"[^>]*>([^<]+)<\/text>/g)];
    const labelXByCategory: Record<string, number> = {};
    for (const m of labelMatches) {
      const [, xStr, content] = m;
      const text = content.trim();
      if (text === "الرياض" || text === "جدة") {
        labelXByCategory[text] = parseFloat(xStr);
      }
    }
    // Extract bar rect x positions (exclude legend swatches that use rx)
    const barXPositions = [...svg.matchAll(/<rect x="([^"]+)" y="[^"]+" width="[^"]+" height="[^"]+" fill="/g)]
      .map((m) => parseFloat(m[1]));
    // الرياض should have a bar x < جدة bar x (it's the first category)
    expect(barXPositions[0]).toBeLessThan(barXPositions[1]);
    // The axis label x order should also be الرياض before جدة
    expect(labelXByCategory["الرياض"]).toBeLessThan(labelXByCategory["جدة"]);
  });
});

describe("buildChartSvg — dual-axis and legend", () => {
  const DANGER = "#C62828";
  const PRIMARY = "#004B3A";

  it("dual-axis bar: left bars + right overlay lines use category centers", () => {
    const section: ReportChartSection = {
      id: "dual-bar",
      kind: "chart",
      chartType: "bar",
      title: "اختبار",
      series: [
        { name: "واردة", points: [{ x: "أ", y: 10 }, { x: "ب", y: 20 }] },
        { name: "مغلقة", points: [{ x: "أ", y: 5 }, { x: "ب", y: 8 }] },
        { name: "مفتوحة", axis: "right", points: [{ x: "أ", y: 30 }, { x: "ب", y: 40 }] },
        { name: "متأخرة", axis: "right", points: [{ x: "أ", y: 2 }, { x: "ب", y: 4 }] },
      ],
    };
    const svg = buildChartSvg(section, 600, 400);
    expect(
      svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="/g) ?? []
    ).toHaveLength(4);
    expect(svg.match(/<polyline /g) ?? []).toHaveLength(2);
    // Secondary axis dashed line is on plotLeft (x="76")
    expect(svg).toMatch(/stroke-dasharray="3,3"/);
    expect(svg).toMatch(/x1="76"/);
    // Right-axis first series uses primary, second uses danger
    expect(svg).toContain(`stroke="${PRIMARY}"`);
    expect(svg).toContain(`stroke="${DANGER}"`);
    // Primary Y labels (right side) and secondary Y labels (left side, danger).
    expect(svg).toMatch(/text-anchor="start"[^>]*>0</);
    expect(svg).toContain(`text-anchor="end" font-size="11" fill="${DANGER}"`);
    // Axes remain in the SVG body before series polylines.
    const axesIdx = svg.indexOf('stroke-dasharray="3,3"');
    const firstPolylineIdx = svg.indexOf("<polyline ");
    expect(axesIdx).toBeGreaterThan(-1);
    expect(firstPolylineIdx).toBeGreaterThan(axesIdx);
  });

  it("dual-axis line: right-axis points use xForIndex spacing", () => {
    const section: ReportChartSection = {
      id: "dual-line",
      kind: "chart",
      chartType: "line",
      title: "خط",
      series: [
        { name: "يسار", points: [{ x: "2026-01-01", y: 1 }, { x: "2026-01-02", y: 2 }, { x: "2026-01-03", y: 3 }] },
        { name: "يمين", axis: "right", points: [{ x: "2026-01-01", y: 10 }, { x: "2026-01-02", y: 20 }, { x: "2026-01-03", y: 30 }] },
      ],
    };
    const svg = buildChartSvg(section, 600, 400);
    // plotLeft dual=76, plotRight=600-76=524 → first x=76, mid=300, last=524
    expect(svg).toContain("76.0,");
    expect(svg).toContain("300.0,");
    expect(svg).toContain("524.0,");
  });

  it("right-axis-only is treated as single-axis without double drawing", () => {
    const section: ReportChartSection = {
      id: "right-only",
      kind: "chart",
      chartType: "line",
      title: "يمين فقط",
      series: [
        { name: "مفتوحة", axis: "right", points: [{ x: "أ", y: 5 }, { x: "ب", y: 6 }] },
        { name: "متأخرة", axis: "right", points: [{ x: "أ", y: 1 }, { x: "ب", y: 2 }] },
      ],
    };
    const svg = buildChartSvg(section, 600, 400);
    // Single-axis (plotLeft 54) — no secondary dash/thick plotLeft dual margin
    expect(svg).not.toMatch(/stroke-dasharray="3,3"/);
    expect(svg).toMatch(/x1="54"/);
    // Two polylines only (one per series), not four
    expect(svg.match(/<polyline /g) ?? []).toHaveLength(2);
  });

  it("legend swatches match right-axis plot colors", () => {
    const section: ReportChartSection = {
      id: "legend",
      kind: "chart",
      chartType: "bar",
      title: "وسيلة إيضاح",
      series: [
        { name: "واردة", points: [{ x: "أ", y: 10 }] },
        { name: "مفتوحة", axis: "right", points: [{ x: "أ", y: 40 }] },
        { name: "متأخرة", axis: "right", points: [{ x: "أ", y: 5 }] },
      ],
    };
    const svg = buildChartSvg(section, 600, 400);
    // Right series 0 → primary, series 1 → danger (same as rightAxisStyle)
    const polylines = [...svg.matchAll(/<polyline[^>]*stroke="([^"]+)"/g)].map((m) => m[1]);
    expect(polylines).toEqual([PRIMARY, DANGER]);
    // Legend: bar swatch as rect for left series; lines for right-axis series
    expect(svg).toContain(`fill="${PRIMARY}"`);
    expect(svg).toContain(`stroke="${DANGER}"`);
  });

  it("clamps tall bar labels inside the bar with white fill", () => {
    const section: ReportChartSection = {
      id: "tall",
      kind: "chart",
      chartType: "bar",
      title: "عمود طويل",
      series: [
        { name: "ذروة", points: [{ x: "أ", y: 100 }, { x: "ب", y: 1 }] },
      ],
    };
    const svg = buildChartSvg(section, 600, 400);
    // Peak bar "100" keeps series color when Y pad leaves headroom; short bar "1" same.
    expect(svg).toMatch(/<text[^>]*fill="#004B3A"[^>]*>100<\/text>/);
    expect(svg).toMatch(/<text[^>]*fill="#004B3A"[^>]*>1<\/text>/);
  });
});

describe("monthly combo chart — single Y-axis, legend layout", () => {
  function monthlySection(extra?: Partial<ReportChartSection>): ReportChartSection {
    const months = [
      "أغسطس 2025", "سبتمبر 2025", "أكتوبر 2025", "نوفمبر 2025", "ديسمبر 2025",
      "يناير 2026", "فبراير 2026", "مارس 2026", "أبريل 2026", "مايو 2026",
      "يونيو 2026", "يوليو 2026", "أغسطس 2026",
    ];
    const pts = (y: number) => months.map((x) => ({ x, y }));
    return {
      id: "v2-monthly-flow",
      kind: "chart",
      chartType: "bar",
      title: "",
      series: [
        { name: "المسجلة", renderAs: "bar", points: pts(10) },
        { name: "المغلقة", renderAs: "line", dash: "0", points: pts(8) },
      ],
      ...extra,
    };
  }

  it("resolveLegendColumnCount packs 1–5 items as expected", () => {
    expect(resolveLegendColumnCount(1)).toBe(1);
    expect(resolveLegendColumnCount(2)).toBe(2);
    expect(resolveLegendColumnCount(3)).toBe(3);
    expect(resolveLegendColumnCount(4)).toBe(2);
    expect(resolveLegendColumnCount(5)).toBe(2);
  });

  it("uses dark-green registered bars and a solid gold closed line", () => {
    const svg = buildChartSvg(monthlySection(), 800, 360);
    expect(svg).toContain("المسجلة");
    expect(svg).toContain("المغلقة");
    expect(svg).not.toContain("المفتوحة");
    expect(svg).not.toContain("المتأخرة");
    expect(svg).not.toContain("الواردة");
    expect(svg.match(/<polyline /g) ?? []).toHaveLength(1);
    expect(svg).not.toMatch(/stroke-dasharray=/);
    expect(svg).toContain(`stroke="${GOLD}"`);
    expect(svg).toContain(`fill="${PRIMARY}"`);
    expect(svg).toMatch(/<circle[^>]*r="2\.6"[^>]*fill="#FFFFFF"[^>]*stroke="#B88919"/);
    expect(svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="/g) ?? []).toHaveLength(13);
    expect((svg.match(/>10</g) ?? []).length).toBeGreaterThanOrEqual(13);
  });

  it("uses a single shared Y-axis (no right-axis dual scale)", () => {
    const svg = buildChartSvg(monthlySection(), 800, 360);
    expect(svg).not.toMatch(/stroke-dasharray="3,3"/);
    expect(svg.match(/<polyline /g) ?? []).toHaveLength(1);
    const barCount = (svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="/g) ?? []).length;
    expect(barCount).toBe(13);
  });

  it("Y max is driven by monthly series only — ignore a phantom 16,993 total", () => {
    const section = monthlySection();
    // Intentionally do NOT add allTimeTotal as series; scale must stay small
    const svg = buildChartSvg(section, 800, 360);
    expect(svg).not.toContain("16,993");
    expect(svg).not.toContain("16993");
    // Scale for max ~12 should stay well below a 20k axis label
    expect(svg).not.toMatch(/>20[,.]?000</);
    expect(svg).not.toMatch(/>10[,.]?000</);
  });

  it("shows registered/closed legend labels without strike-through text deco", () => {
    const svg = buildChartSvg(monthlySection(), 800, 360);
    for (const label of ["المسجلة", "المغلقة"]) {
      expect(svg).toContain(label);
    }
    expect(svg).not.toContain("text-decoration");
    expect(svg).not.toContain("line-through");
    expect(svg).toContain(`fill="${PRIMARY}"`);
    expect(svg).toContain(`stroke="${GOLD}"`);
  });

  it("fits short legend labels into cells without overlapping swatches", () => {
    const items = [
      { name: "المسجلة", style: { color: PRIMARY, dash: "0", width: 2, mark: "bar" as const } },
      { name: "المغلقة", style: { color: GOLD, dash: "0", width: 2.2, mark: "line" as const } },
    ];
    for (const width of [500, 320]) {
      const legend = drawChartLegend(items, { width, top: 10, columns: 2, fontSize: 11 });
      expect(legend.labelBoxes).toHaveLength(2);
      expect(legend.svg).toContain('text-anchor="middle"');
      expect(legend.svg).not.toContain('text-anchor="end"');
      expect(legend.svg).toContain("المسجلة");
      for (const box of legend.labelBoxes) {
        expect(box.measuredWidth).toBeLessThanOrEqual(box.availableWidth + 0.01);
        expect(box.truncated).toBe(false);
        expect(box.left).toBeGreaterThanOrEqual(box.labelLeft - 0.01);
        expect(box.right).toBeLessThanOrEqual(box.labelRight + 0.01);
        expect(box.right + box.legendGap).toBeLessThanOrEqual(box.swatchLeft + 0.01);
        expect(box.legendGap).toBe(CHART_LEGEND_GAP);
        expect(box.right).toBeLessThanOrEqual(width);
        expect(box.left).toBeGreaterThanOrEqual(0);
      }
      for (let i = 0; i < legend.labelBoxes.length; i++) {
        for (let j = i + 1; j < legend.labelBoxes.length; j++) {
          const a = legend.labelBoxes[i];
          const b = legend.labelBoxes[j];
          if (Math.abs(a.top - b.top) >= 1) continue;
          expect(a.left < b.right && b.left < a.right).toBe(false);
        }
      }
    }
  });

  it("shows all 13 wrapped month labels and line values when requested", () => {
    const months = [
      "أغسطس 2025", "سبتمبر 2025", "أكتوبر 2025", "نوفمبر 2025", "ديسمبر 2025",
      "يناير 2026", "فبراير 2026", "مارس 2026", "أبريل 2026", "مايو 2026",
      "يونيو 2026", "يوليو 2026", "أغسطس 2026",
    ];
    const svg = buildChartSvg(monthlySection(), 900, 420, {
      xLabelPolicy: "all",
      xLabelLayout: "wrap-two-lines",
      showLinePointValues: true,
    });
    for (const month of months) {
      const [name, year] = month.split(" ");
      expect(svg).toContain(name!);
      expect(svg).toContain(year!);
    }
    expect(svg).toContain("<tspan");
    expect((svg.match(/>8</g) ?? []).length).toBeGreaterThanOrEqual(13);
  });

  it("hides line point values by default and leaves other charts unchanged", () => {
    const monthly = buildChartSvg(monthlySection(), 800, 360);
    expect(monthly.match(/>8</g) ?? []).toHaveLength(0);

    const other: ReportChartSection = {
      id: "other-line",
      kind: "chart",
      chartType: "line",
      title: "أخرى",
      series: [{ name: "سلسلة", points: [{ x: "أ", y: 8 }, { x: "ب", y: 8 }] }],
    };
    const otherSvg = buildChartSvg(other, 600, 300);
    expect(otherSvg).not.toMatch(/<text[^>]*>8<\/text>/);
  });

  it("avoids overlapping line and bar value labels on known fixtures", () => {
    const fixtures: Array<{
      name: string;
      input: {
        pointY: number;
        barTopY: number | null;
        plotTop: number;
        plotBottom: number;
      };
      expected: { y: number; insideBar: boolean; fill: string };
    }> = [
      {
        name: "above point when clear",
        input: { pointY: 160, barTopY: 100, plotTop: 40, plotBottom: 300 },
        expected: { y: 148, insideBar: false, fill: "#B88919" },
      },
      {
        name: "below point when above is out of bounds",
        input: { pointY: 55, barTopY: 100, plotTop: 40, plotBottom: 300 },
        expected: { y: 69, insideBar: false, fill: "#B88919" },
      },
      {
        name: "below point inside bar uses white fill",
        input: { pointY: 103, barTopY: 100, plotTop: 40, plotBottom: 300 },
        expected: { y: 117, insideBar: true, fill: "#FFFFFF" },
      },
      {
        name: "below bar value label after tall clamp",
        input: { pointY: 45, barTopY: 45, plotTop: 40, plotBottom: 300 },
        expected: { y: 71, insideBar: true, fill: "#FFFFFF" },
      },
      {
        name: "no bar uses below when above is tight",
        input: { pointY: 60, barTopY: null, plotTop: 40, plotBottom: 300 },
        expected: { y: 74, insideBar: false, fill: "#B88919" },
      },
      {
        name: "above out of bounds then below outside bar",
        input: { pointY: 40, barTopY: 100, plotTop: 40, plotBottom: 300 },
        expected: { y: 54, insideBar: false, fill: "#B88919" },
      },
      {
        name: "selects below clamped bar label",
        input: { pointY: 48, barTopY: 45, plotTop: 40, plotBottom: 300 },
        expected: { y: 71, insideBar: true, fill: "#FFFFFF" },
      },
      {
        name: "tight plot still finds an in-bounds candidate",
        input: { pointY: 200, barTopY: 100, plotTop: 190, plotBottom: 220 },
        expected: { y: 200, insideBar: true, fill: "#FFFFFF" },
      },
    ];

    for (const fixture of fixtures) {
      expect(
        resolveLineValueLabelPlacement(fixture.input),
        fixture.name
      ).toEqual(fixture.expected);
    }

    const barPlacement = resolveBarValueLabelPlacement({
      barTopY: 45,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(barPlacement).toEqual({ y: 57, insideBar: true });
    const tallLine = resolveLineValueLabelPlacement({
      pointY: 45,
      barTopY: 45,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(Math.abs(tallLine.y - barPlacement.y)).toBeGreaterThanOrEqual(LINE_VALUE_LABEL_COLLISION_PX);

    const normalBar = resolveBarValueLabelPlacement({
      barTopY: 100,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(normalBar.insideBar).toBe(false);
    const colliding = resolveLineValueLabelPlacement({
      pointY: 103,
      barTopY: 100,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(Math.abs(colliding.y - normalBar.y)).toBeGreaterThanOrEqual(LINE_VALUE_LABEL_COLLISION_PX);

    const svg = buildChartSvg(
      {
        id: "v2-monthly-flow",
        kind: "chart",
        chartType: "bar",
        title: "",
        series: [
          { name: "المسجلة", renderAs: "bar", points: [{ x: "أغسطس 2026", y: 50 }] },
          { name: "المغلقة", renderAs: "line", dash: "0", points: [{ x: "أغسطس 2026", y: 50 }] },
        ],
      },
      600,
      360,
      { showLinePointValues: true }
    );
    const valueTexts = [...svg.matchAll(/<text[^>]*y="([^"]+)"[^>]*>50<\/text>/g)].map((m) => Number(m[1]));
    expect(valueTexts.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(valueTexts[0]! - valueTexts[1]!)).toBeGreaterThanOrEqual(LINE_VALUE_LABEL_COLLISION_PX);
  });

  it("uses clamped fallback when no candidate fits the plot", () => {
    const placement = resolveLineValueLabelPlacement({
      pointY: 100,
      barTopY: 100,
      plotTop: 95,
      plotBottom: 120,
    });
    // minTop=105, maxBottom=106; preferredAbove=88 clamps to [105,106]
    expect(placement).toEqual({
      y: 105,
      insideBar: false,
      fill: "#B88919",
    });
  });

  it("derives insideBar from final Y relative to barTopY after clamp", () => {
    const placement = resolveLineValueLabelPlacement({
      pointY: 300,
      barTopY: 290,
      plotTop: 40,
      plotBottom: 300,
    });
    if (placement.y <= 290) {
      expect(placement.insideBar).toBe(false);
      expect(placement.fill).toBe(GOLD);
    }

    // Clamped candidate ends at/below barTopY → gold outside, never forced white.
    const clampedOutside = resolveLineValueLabelPlacement({
      pointY: 200,
      barTopY: 200,
      plotTop: 40,
      plotBottom: 194,
    });
    expect(clampedOutside.y).toBeLessThanOrEqual(200);
    expect(clampedOutside.insideBar).toBe(false);
    expect(clampedOutside.fill).toBe(GOLD);
  });

  it("uses auto inside/outside fill based on Y versus barTopY", () => {
    const inside = resolveLineValueLabelPlacement({
      pointY: 103,
      barTopY: 100,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(inside.y).toBeGreaterThan(100);
    expect(inside.insideBar).toBe(true);
    expect(inside.fill).toBe("#FFFFFF");

    const outside = resolveLineValueLabelPlacement({
      pointY: 40,
      barTopY: 100,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(outside.y).toBeLessThanOrEqual(100);
    expect(outside.insideBar).toBe(false);
    expect(outside.fill).toBe(GOLD);
  });

  it("keeps short-plot SVG line labels gold when outside the bar", () => {
    const section: ReportChartSection = {
      id: "v2-monthly-flow",
      kind: "chart",
      chartType: "bar",
      title: "",
      series: [
        { name: "المسجلة", renderAs: "bar", points: [{ x: "أغسطس 2026", y: 20 }] },
        { name: "المغلقة", renderAs: "line", dash: "0", points: [{ x: "أغسطس 2026", y: 5 }] },
      ],
    };
    const svg = buildChartSvg(section, 600, 180, { showLinePointValues: true });
    const lineValue = [...svg.matchAll(/<text[^>]*fill="([^"]+)"[^>]*>5<\/text>/g)]
      .map((m) => m[1])
      .find((fill) => fill === GOLD || fill === "#FFFFFF");
    expect(lineValue).toBe(GOLD);
    expect(svg).toContain(`stroke="${GOLD}"`);
    expect(svg).toContain(`fill="${PRIMARY}"`);
    expect(svg).toContain("أغسطس");
    expect(svg).toContain("2026");

    const midYs = [
      ...svg.matchAll(/<text[^>]*text-anchor="middle"[^>]*y="([^"]+)"[^>]*>\d+<\/text>/g),
      ...svg.matchAll(/<text[^>]*y="([^"]+)"[^>]*text-anchor="middle"[^>]*>\d+<\/text>/g),
    ].map((m) => Number(m[1]));
    expect(midYs.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(midYs[0]! - midYs[1]!)).toBeGreaterThanOrEqual(LINE_VALUE_LABEL_COLLISION_PX);
  });

  it("keeps tall-bar and line labels apart when the bar label clamps inside", () => {
    // Helper-level clamp: preferred above would sit above plotTop+10.
    const barPlacement = resolveBarValueLabelPlacement({
      barTopY: 45,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(barPlacement).toEqual({ y: 57, insideBar: true });

    const linePlacement = resolveLineValueLabelPlacement({
      pointY: 45,
      barTopY: 45,
      plotTop: 40,
      plotBottom: 300,
    });
    expect(
      Math.abs(linePlacement.y - barPlacement.y)
    ).toBeGreaterThanOrEqual(LINE_VALUE_LABEL_COLLISION_PX);
    expect(linePlacement.y).toBeGreaterThanOrEqual(50);
    expect(linePlacement.y).toBeLessThanOrEqual(286);
    expect(linePlacement).toEqual({ y: 71, insideBar: true, fill: "#FFFFFF" });

    // SVG integration: same-value bar + line must keep middle-anchored labels apart.
    const section: ReportChartSection = {
      id: "v2-monthly-flow",
      kind: "chart",
      chartType: "bar",
      title: "",
      series: [
        { name: "المسجلة", renderAs: "bar", points: [{ x: "أغسطس 2026", y: 100 }] },
        { name: "المغلقة", renderAs: "line", dash: "0", points: [{ x: "أغسطس 2026", y: 100 }] },
      ],
    };
    const svg = buildChartSvg(section, 600, 200, { showLinePointValues: true });
    const plotValueYs = [
      ...svg.matchAll(/<text[^>]*text-anchor="middle"[^>]*y="([^"]+)"[^>]*>100<\/text>/g),
      ...svg.matchAll(/<text[^>]*y="([^"]+)"[^>]*text-anchor="middle"[^>]*>100<\/text>/g),
    ].map((m) => Number(m[1]));
    const uniqueYs = [...new Set(plotValueYs)];
    expect(uniqueYs.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(uniqueYs[0]! - uniqueYs[1]!)).toBeGreaterThanOrEqual(LINE_VALUE_LABEL_COLLISION_PX);
    expect(svg).toContain("أغسطس");
    expect(svg).toContain("2026");
    expect(svg).toContain(`fill="${PRIMARY}"`);
    expect(svg).toContain(`stroke="${GOLD}"`);
  });

  it("keeps fixed SVG hashes for registered/closed label fixtures", () => {
    const hashSvg = (svg: string) => createHash("sha256").update(svg).digest("hex");

    const equalValues = buildChartSvg(
      {
        id: "v2-monthly-flow",
        kind: "chart",
        chartType: "bar",
        title: "",
        series: [
          { name: "المسجلة", renderAs: "bar", points: [{ x: "أغسطس 2026", y: 50 }] },
          { name: "المغلقة", renderAs: "line", dash: "0", points: [{ x: "أغسطس 2026", y: 50 }] },
        ],
      },
      600,
      360,
      { showLinePointValues: true }
    );
    expect(hashSvg(equalValues)).toBe(
      "357633f6da93cd213b60fb00bafd963daab871cdee6cc7e06c86f917f5d784bc"
    );

    const tallValues = buildChartSvg(
      {
        id: "v2-monthly-flow",
        kind: "chart",
        chartType: "bar",
        title: "",
        series: [
          { name: "المسجلة", renderAs: "bar", points: [{ x: "أغسطس 2026", y: 100 }] },
          { name: "المغلقة", renderAs: "line", dash: "0", points: [{ x: "أغسطس 2026", y: 100 }] },
        ],
      },
      600,
      200,
      { showLinePointValues: true }
    );
    expect(hashSvg(tallValues)).toBe(
      "9528b44bb48ecc6fd10234fd84683cd70199157a8522bb2b20bd34a83e2c88c3"
    );
  });

  it("builds valid SVG for 0, 1, and 13 monthly points", () => {
    const empty = buildChartSvg(
      {
        id: "v2-monthly-flow",
        kind: "chart",
        chartType: "bar",
        title: "",
        series: [
          { name: "المسجلة", renderAs: "bar", points: [] },
          { name: "المغلقة", renderAs: "line", dash: "0", points: [] },
        ],
      },
      600,
      300
    );
    expect(empty).toContain("<svg");

    const one = buildChartSvg(
      {
        id: "v2-monthly-flow",
        kind: "chart",
        chartType: "bar",
        title: "",
        series: [
          { name: "المسجلة", renderAs: "bar", points: [{ x: "أغسطس 2026", y: 3 }] },
          { name: "المغلقة", renderAs: "line", dash: "0", points: [{ x: "أغسطس 2026", y: 2 }] },
        ],
      },
      600,
      300,
      { showLinePointValues: true }
    );
    expect(one).toContain("<polyline");
    expect(one).toContain(">3<");
    expect(one).toContain(">2<");

    const thirteen = buildChartSvg(monthlySection(), 900, 360, {
      xLabelPolicy: "all",
      xLabelLayout: "wrap-two-lines",
      showLinePointValues: true,
    });
    expect(
      thirteen.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="/g) ?? []
    ).toHaveLength(13);
    expect(thirteen.match(/<circle /g)?.length).toBeGreaterThanOrEqual(13);
  });

  it("region legend uses short names and middle text anchors", async () => {
    const section: ReportChartSection = {
      id: "v2-region-bar",
      kind: "chart",
      chartType: "bar",
      title: "مقارنة المناطق",
      series: [
        { name: "الحالية", points: [{ x: "الرياض", y: 40 }, { x: "جدة", y: 30 }] },
        { name: "السابقة", points: [{ x: "الرياض", y: 30 }, { x: "جدة", y: 35 }] },
      ],
    };
    const svg = buildChartSvg(section, 800, 280);
    expect(svg).toContain("الحالية");
    expect(svg).toContain("السابقة");
    expect(svg).not.toContain("شكاوى الفترة الحالية");
    expect(svg).not.toContain('text-anchor="end"');
    expect(svg).toContain('text-anchor="middle"');

    const legend = drawChartLegend(
      [
        { name: "الحالية", style: { color: PRIMARY, dash: "0", width: 2, mark: "bar" } },
        { name: "السابقة", style: { color: GOLD, dash: "0", width: 2, mark: "bar" } },
      ],
      { width: 800, top: 10, columns: 2 }
    );
    for (const box of legend.labelBoxes) {
      expect(box.left).toBeGreaterThanOrEqual(box.labelLeft - 0.01);
      expect(box.right).toBeLessThanOrEqual(box.labelRight + 0.01);
      expect(box.right + CHART_LEGEND_GAP).toBeLessThanOrEqual(box.swatchLeft + 0.01);
    }

    configureReportFontconfig();
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("resolveChartGeometry keeps plotTop < plotBottom with min plot height", () => {
    const geo = resolveChartGeometry({
      width: 400,
      height: 120,
      hasDualAxis: false,
      plotTop: 200, // deliberately too large
      xCount: 4,
    });
    expect(geo.plotTop).toBeLessThan(geo.plotBottom);
    expect(geo.plotBottom - geo.plotTop).toBeGreaterThanOrEqual(
      Math.min(MIN_PLOT_HEIGHT, geo.plotBottom)
    );
    expect(Number.isFinite(geo.plotTop)).toBe(true);
    expect(Number.isFinite(geo.plotBottom)).toBe(true);
    expect(geo.plotTop).toBeGreaterThanOrEqual(0);
  });

  it("resolveChartGeometry keeps a valid horizontal plot span", () => {
    const cases: Array<{ width: number; hasDualAxis: boolean }> = [
      { width: 800, hasDualAxis: false },
      { width: 800, hasDualAxis: true },
      { width: 120, hasDualAxis: false },
      { width: 120, hasDualAxis: true },
      { width: 1, hasDualAxis: false },
      { width: 0, hasDualAxis: true },
      { width: -40, hasDualAxis: false },
      { width: Number.NaN, hasDualAxis: true },
      { width: Number.POSITIVE_INFINITY, hasDualAxis: false },
    ];
    for (const options of cases) {
      const geo = resolveChartGeometry({
        ...options,
        height: 360,
        plotTop: 40,
        xCount: 4,
      });
      expect(Number.isFinite(geo.plotLeft)).toBe(true);
      expect(Number.isFinite(geo.plotRight)).toBe(true);
      expect(geo.plotLeft).toBeGreaterThanOrEqual(0);
      expect(geo.plotRight).toBeGreaterThan(geo.plotLeft);
    }
    const normalSingle = resolveChartGeometry({
      width: 800,
      height: 360,
      hasDualAxis: false,
      plotTop: 40,
      xCount: 4,
    });
    expect(normalSingle.plotLeft).toBe(54);
    expect(normalSingle.plotRight).toBe(724);
    const normalDual = resolveChartGeometry({
      width: 800,
      height: 360,
      hasDualAxis: true,
      plotTop: 40,
      xCount: 4,
    });
    expect(normalDual.plotLeft).toBe(76);
    expect(normalDual.plotRight).toBe(724);
  });

  it("buildChartSvg with short height and many series keeps valid plot geometry", () => {
    const series = Array.from({ length: 10 }, (_, i) => ({
      name: `سلسلة رقم ${i + 1} بوصف تشغيلي طويل للتحقق من المفتاح`,
      renderAs: (i % 2 === 0 ? "bar" : "line") as "bar" | "line",
      points: [
        { x: "يوليو 2026", y: i + 1 },
        { x: "أغسطس 2026", y: i + 2 },
      ],
    }));
    const section: ReportChartSection = {
      id: "geometry-stress",
      kind: "chart",
      chartType: "bar",
      title: "اختبار",
      series,
    };
    const height = 140;
    const svg = buildChartSvg(section, 400, height);
    expect(svg).not.toMatch(/NaN|Infinity/);
    // Parse plot-ish polyline y values
    const polyYs = [...svg.matchAll(/points="([^"]+)"/g)].flatMap((m) => {
      return m[1]
        .trim()
        .split(/\s+/)
        .map((pair) => parseFloat(pair.split(",")[1] ?? "NaN"));
    });
    for (const y of polyYs) {
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(height + 5);
    }
    // Y scale top of bars (rect y) within bounds
    const rectYs = [...svg.matchAll(/<rect x="[^"]+" y="([^"]+)"/g)].map((m) => parseFloat(m[1]));
    for (const y of rectYs) {
      if (!Number.isFinite(y)) continue;
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(height + 5);
    }
  });

  it("legend reserved band sits above the plot floor", () => {
    const svg = buildChartSvg(monthlySection(), 800, 360);
    const escapeRegex = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const legendNames = ["الواردة", "المغلقة", "المفتوحة", "المتأخرة"];
    const legendTextYs: number[] = [];
    for (const name of legendNames) {
      const re = new RegExp(`<text([^>]*)>${escapeRegex(name)}</text>`, "g");
      for (const match of svg.matchAll(re)) {
        const attrs = match[1] ?? "";
        const yMatch = /(?:^|\s)y="([^"]+)"/.exec(attrs);
        const fontMatch = /(?:^|\s)font-size="([^"]+)"/.exec(attrs);
        const y = yMatch ? parseFloat(yMatch[1]) : Number.NaN;
        const fontSize = fontMatch ? parseFloat(fontMatch[1]) : Number.NaN;
        expect(Number.isFinite(y)).toBe(true);
        expect(fontSize).toBeGreaterThanOrEqual(8);
        expect(fontSize).toBeLessThanOrEqual(11);
        legendTextYs.push(y);
      }
    }
    const borderColorPattern = escapeRegex(REPORT_DESIGN_TOKENS.colors.border);
    const axisFloorYs = [
      ...svg.matchAll(
        new RegExp(
          `y1="(\\d+(?:\\.\\d+)?)"[^>]*y2="\\1" stroke="${borderColorPattern}"`,
          "g"
        )
      ),
    ].map((m) => parseFloat(m[1]));
    expect(legendTextYs.length).toBeGreaterThan(0);
    expect(axisFloorYs.length).toBeGreaterThan(0);
    expect(Math.max(...legendTextYs)).toBeLessThan(Math.max(...axisFloorYs));
  });

  it("integer Y ticks only for small monthly peaks", () => {
    const { ticks } = computeYScale(3, { integersOnly: true });
    for (const t of ticks) {
      expect(Number.isInteger(t)).toBe(true);
    }
    expect(ticks.some((t) => String(t).includes("."))).toBe(false);
  });

  it("region comparison legend does not collide either", () => {
    const section: ReportChartSection = {
      id: "v2-region-bar",
      kind: "chart",
      chartType: "bar",
      title: "مقارنة المناطق",
      series: [
        { name: "الحالية", points: [{ x: "الرياض", y: 40 }, { x: "جدة", y: 30 }] },
        { name: "السابقة", points: [{ x: "الرياض", y: 30 }, { x: "جدة", y: 35 }] },
      ],
    };
    const svg = buildChartSvg(section, 800, 280);
    expect(svg).toContain("الحالية");
    expect(svg).toContain("السابقة");
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).not.toContain('text-anchor="end"');
  });
});

describe("resolveXAxisLabelStep", () => {
  it("keeps every label when policy is all", () => {
    expect(resolveXAxisLabelStep(13, "all")).toBe(1);
  });

  it("uses every-other label for crowded auto timelines", () => {
    expect(resolveXAxisLabelStep(13, "auto")).toBe(2);
    expect(resolveXAxisLabelStep(24, "auto")).toBe(2);
  });

  it("keeps all labels for shorter auto windows", () => {
    expect(resolveXAxisLabelStep(11, "auto")).toBe(1);
  });

  it("does not divide by zero for empty or single label sets", () => {
    expect(resolveXAxisLabelStep(0, "auto")).toBe(1);
    expect(resolveXAxisLabelStep(1, "auto")).toBe(1);
    expect(resolveXAxisLabelStep(0, "all")).toBe(1);
  });
});

describe("wrapCategoricalAxisLabel", () => {
  it("wraps long region names into at most two lines", () => {
    expect(wrapCategoricalAxisLabel("الحدود الشمالية", 2)).toEqual(["الحدود", "الشمالية"]);
    expect(wrapCategoricalAxisLabel("المدينة المنورة", 2)).toEqual(["المدينة", "المنورة"]);
    expect(wrapCategoricalAxisLabel("مكة المكرمة", 2)).toEqual(["مكة", "المكرمة"]);
  });

  it("keeps short region names on one line", () => {
    for (const label of ["الرياض", "القصيم", "تبوك", "جازان", "حائل", "عسير", "نجران", "الجوف", "الباحة", "الشرقية"]) {
      expect(wrapCategoricalAxisLabel(label, 2)).toEqual([label]);
    }
  });

  it("never returns more than maxLines", () => {
    expect(wrapCategoricalAxisLabel("أ ب ج د هـ", 2)).toHaveLength(2);
  });
});

describe("region categorical x-axis labels", () => {
  const REGION_NAMES = [
    "الشرقية",
    "الباحة",
    "الجوف",
    "الحدود الشمالية",
    "الرياض",
    "القصيم",
    "المدينة المنورة",
    "تبوك",
    "جازان",
    "حائل",
    "عسير",
    "مكة المكرمة",
    "نجران",
  ] as const;

  function makeRegionSection(): ReportChartSection {
    return {
      id: "v2-region-bar",
      kind: "chart",
      chartType: "bar",
      title: "مقارنة شكاوى الفترة الحالية مقابل الفترة السابقة حسب المنطقة",
      series: [
        {
          name: "الحالية",
          points: REGION_NAMES.map((name, index) => ({ x: name, y: 100 + index * 10 })),
        },
        {
          name: "السابقة",
          points: REGION_NAMES.map((name, index) => ({ x: name, y: 80 + index * 8 })),
        },
      ],
    };
  }

  it("shows all thirteen region labels with policy=all", () => {
    const svg = buildChartSvg(makeRegionSection(), 900, 296, {
      xLabelPolicy: "all",
      xLabelLayout: "wrap-two-lines",
    });

    for (const name of REGION_NAMES) {
      if (name.includes(" ")) {
        const [first, second] = wrapCategoricalAxisLabel(name, 2);
        expect(svg).toContain(first);
        expect(svg).toContain(second);
      } else {
        expect(svg).toContain(name);
      }
    }

    // Previously dropped odd indices under auto step=2.
    for (const previouslyHidden of ["الباحة", "القصيم", "تبوك", "حائل"]) {
      expect(svg).toContain(previouslyHidden);
    }
    expect(svg).toContain("<tspan");
    expect(svg).toContain("الحدود");
    expect(svg).toContain("الشمالية");
    expect(svg).toContain("المدينة");
    expect(svg).toContain("المنورة");
    expect(svg).toContain("مكة");
    expect(svg).toContain("المكرمة");
    expect(resolveXAxisBottomReserve("wrap-two-lines")).toBe(50);
  });

  it("keeps temporal auto policy skipping labels without dropping points", () => {
    const months = Array.from({ length: 14 }, (_, i) => {
      const date = new Date(Date.UTC(2024, i, 1));
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, "0");
      return `${y}-${m}-01`;
    });
    const section: ReportChartSection = {
      id: "v2-monthly-flow",
      kind: "chart",
      chartType: "bar",
      title: "",
      series: [
        {
          name: "المسجلة",
          renderAs: "bar",
          points: months.map((x, i) => ({ x, y: 10 + i })),
        },
        {
          name: "المغلقة",
          renderAs: "line",
          dash: "0",
          points: months.map((x, i) => ({ x, y: 8 + i })),
        },
      ],
    };

    const autoSvg = buildChartSvg(section, 900, 320);
    const allSvg = buildChartSvg(section, 900, 320, { xLabelPolicy: "all" });

    // Data values remain present as bar heights / text values regardless of label step.
    expect(autoSvg).toContain('fill=');
    expect(autoSvg.match(/<rect /g)?.length ?? 0).toBeGreaterThanOrEqual(months.length);
    expect(allSvg.match(/<rect /g)?.length ?? 0).toBe(autoSvg.match(/<rect /g)?.length);

    // Auto skips some date labels; all would include more.
    const countDateLabels = (svg: string) =>
      [...svg.matchAll(/>\d{2}\/\d{2}</g)].length;
    expect(countDateLabels(autoSvg)).toBeLessThan(countDateLabels(allSvg));
    expect(countDateLabels(autoSvg)).toBeLessThan(months.length);
    expect(countDateLabels(allSvg)).toBe(months.length);
    expect(autoSvg).toContain("المسجلة");
    expect(autoSvg).toContain("المغلقة");
    expect(autoSvg).toContain(`fill="${PRIMARY}"`);
    expect(autoSvg).toContain(`stroke="${GOLD}"`);
  });
});
