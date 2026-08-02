// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  DIGITAL_EXECUTIVE_PAGE_SIZE,
  directionColor,
  directionFromAssessment,
  EXECUTIVE_DIRECTION_GLYPHS,
  formatReportNumber,
  REPORT_DESIGN_TOKENS,
} from "./design-tokens";

describe("report design tokens", () => {
  it("uses the approved limited report palette", () => {
    expect(REPORT_DESIGN_TOKENS.colors).toEqual({
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
    });
  });

  it("uses the readable portrait reference canvas instead of compressed A4", () => {
    expect(DIGITAL_EXECUTIVE_PAGE_SIZE).toEqual([900, 1200]);
  });

  it("formats Latin digits, one decimal at most, and a true minus sign", () => {
    expect(formatReportNumber(1234.56)).toBe("1,234.6");
    expect(formatReportNumber(100, { percent: true })).toBe("100%");
    expect(formatReportNumber(-10, { sign: true, percent: true })).toBe("−10%");
  });

  it("uses one semantic direction mapping and one glyph set", () => {
    expect(directionFromAssessment("warning")).toBe("negative");
    expect(directionColor("positive")).toBe(REPORT_DESIGN_TOKENS.colors.success);
    expect(EXECUTIVE_DIRECTION_GLYPHS).toEqual({ positive: "↑", negative: "↓", neutral: "—" });
  });

  it("keeps renderer hex colours centralized in this token module", () => {
    const rendererUrls = [
      new URL("../../server/reports/report-pdf-service.ts", import.meta.url),
      new URL("../../server/reports/report-executive-brief-pdf-service.ts", import.meta.url),
      new URL("../../server/reports/report-chart-service.ts", import.meta.url),
    ];
    for (const url of rendererUrls) {
      expect(fs.readFileSync(url, "utf8")).not.toMatch(/#[0-9A-Fa-f]{6}/);
    }
  });

  it("keeps a single PDF direction-icon implementation", () => {
    const source = fs.readFileSync(
      new URL("../../server/reports/report-executive-brief-pdf-service.ts", import.meta.url),
      "utf8"
    );
    expect(source.match(/function drawDirectionIcon/g)).toHaveLength(1);
    expect(source).not.toMatch(/[↑↓]/);
  });

  it("wordSpacing is 0 — non-zero value causes Arabic word-order reversal in PDFKit", () => {
    expect(REPORT_DESIGN_TOKENS.typography.wordSpacing).toBe(0);
  });
});
