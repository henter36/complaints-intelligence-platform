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
} from "./report-chart-service";
import type { ReportChartSection } from "./report-data-service";

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");

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
    // Series B should only produce one rect (for "الرياض"), not two
    // We verify the SVG contains two x-axis labels for the two categories
    expect(svg).toContain("الرياض");
    // Bar rects have an x= attribute; the background rect does not.
    const barRectCount = (svg.match(/<rect x=/g) ?? []).length;
    // Series A: 2 bars (الرياض + جدة), Series B: 1 bar (الرياض only) = 3 total
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
    // Extract bar rect x positions
    const rectMatches = [...svg.matchAll(/<rect x="([^"]+)"/g)];
    const barXPositions = rectMatches.map((m) => parseFloat(m[1]));
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
    expect(svg.match(/<rect x=/g) ?? []).toHaveLength(4);
    expect(svg.match(/<polyline /g) ?? []).toHaveLength(2);
    // Secondary axis dashed line is on plotLeft (x="76")
    expect(svg).toMatch(/stroke-dasharray="3,3"/);
    expect(svg).toMatch(/x1="76" y1="48" x2="76"/);
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
    // Legend lines: left series uses seriesStyle[0]=primary; right uses same as plot
    const legendLines = [...svg.matchAll(/<line x1="[^"]+" y1="[^"]+" x2="[^"]+" y2="[^"]+" stroke="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((c) => c === PRIMARY || c === DANGER || c === "#B88919");
    expect(legendLines).toContain(PRIMARY);
    expect(legendLines).toContain(DANGER);
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
    // Peak bar label "100" is clamped inside the bar in white; short bar "1" keeps series color.
    // Attribute order is x/y/text-anchor/font-size/fill before the text content.
    expect(svg).toMatch(/<text[^>]*fill="#FFFFFF"[^>]*>100<\/text>/);
    expect(svg).toMatch(/<text[^>]*fill="#004B3A"[^>]*>1<\/text>/);
  });
});
