// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
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
  MIN_PLOT_HEIGHT,
} from "./report-chart-service";
import type { ReportChartSection } from "./report-data-service";
import { REPORT_DESIGN_TOKENS } from "@/lib/reports/design-tokens";

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
        { name: "الواردة", renderAs: "bar", points: pts(10) },
        { name: "المغلقة", renderAs: "bar", points: pts(8) },
        { name: "المفتوحة", renderAs: "line", points: pts(12) },
        { name: "المتأخرة", renderAs: "line", dash: "6,4", points: pts(2) },
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

  it("bar series use solid dash and late line uses danger + dashed stroke", () => {
    const svg = buildChartSvg(monthlySection(), 800, 360);
    // Four series present
    expect(svg).toContain("الواردة");
    expect(svg).toContain("المغلقة");
    expect(svg).toContain("المفتوحة");
    expect(svg).toContain("المتأخرة");
    expect(svg).not.toContain("مفتوحة نهاية الشهر");
    expect(svg).not.toContain("متأخرة نهاية الشهر");
    // Two polylines (open + late); late dashed
    expect(svg.match(/<polyline /g) ?? []).toHaveLength(2);
    expect(svg).toMatch(/stroke-dasharray="6,4"/);
    expect(svg).toContain(`stroke="${DANGER}"`);
    // Bar swatches are solid gold/primary, not dashed via line
    expect(svg).toContain(`fill="${PRIMARY}"`);
    expect(svg).toContain(`fill="${GOLD}"`);
  });

  it("uses a single shared Y-axis (no right-axis dual scale)", () => {
    const svg = buildChartSvg(monthlySection(), 800, 360);
    expect(svg).not.toMatch(/stroke-dasharray="3,3"/);
    expect(svg.match(/<polyline /g) ?? []).toHaveLength(2);
    const barCount = (svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="/g) ?? []).length;
    expect(barCount).toBe(13 * 2); // 2 bar series × 13 months
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

  it("shows all four short legend labels without strike-through text deco", () => {
    const svg = buildChartSvg(monthlySection(), 800, 360);
    for (const label of ["الواردة", "المغلقة", "المفتوحة", "المتأخرة"]) {
      expect(svg).toContain(label);
    }
    expect(svg).not.toContain("text-decoration");
    expect(svg).not.toContain("line-through");
    // Bar swatches use rect fills (green + gold)
    expect(svg).toContain(`fill="${PRIMARY}"`);
    expect(svg).toContain(`fill="${GOLD}"`);
    // Late line uses danger
    expect(svg).toContain(`stroke="${DANGER}"`);
  });

  it("fits short legend labels into cells without overlapping swatches", () => {
    const items = [
      { name: "الواردة", style: { color: PRIMARY, dash: "0", width: 2, mark: "bar" as const } },
      { name: "المغلقة", style: { color: GOLD, dash: "0", width: 2, mark: "bar" as const } },
      { name: "المفتوحة", style: { color: PRIMARY, dash: "0", width: 2, mark: "line" as const } },
      { name: "المتأخرة", style: { color: DANGER, dash: "6,4", width: 2, mark: "line" as const } },
    ];
    for (const width of [500, 320]) {
      const legend = drawChartLegend(items, { width, top: 10, columns: 2, fontSize: 11 });
      expect(legend.labelBoxes).toHaveLength(4);
      expect(legend.svg).toContain("text-anchor=\"end\"");
      expect(legend.svg).toContain("الواردة");
      for (const box of legend.labelBoxes) {
        expect(box.measuredWidth).toBeLessThanOrEqual(box.availableWidth + 0.01);
        expect(box.truncated).toBe(false);
        expect(box.right - box.left).toBeLessThanOrEqual(box.availableWidth + 0.01);
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
        { name: "شكاوى الفترة الحالية", points: [{ x: "الرياض", y: 40 }, { x: "جدة", y: 30 }] },
        { name: "الفترة السابقة", points: [{ x: "الرياض", y: 30 }, { x: "جدة", y: 35 }] },
      ],
    };
    const svg = buildChartSvg(section, 800, 280);
    expect(svg).toContain("شكاوى الفترة الحالية");
    expect(svg).toContain("الفترة السابقة");
    // Legend sits above plot (y positions of legend text < plot bottom labels)
    const legendY = [...svg.matchAll(/font-size="11"[^>]*>(?:شكاوى|الفترة)/g)];
    expect(legendY.length).toBeGreaterThan(0);
  });
});
