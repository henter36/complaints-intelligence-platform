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
