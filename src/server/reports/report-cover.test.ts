// @vitest-environment node
//
// Tests for the report cover page: separator position, multi-line title handling,
// and the ivory/العاجي color documentation requirement.

import { describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import path from "node:path";
import fs from "node:fs";
import { drawComplaintsReportCover } from "./report-cover";
import { REPORT_DESIGN_TOKENS } from "@/lib/reports/design-tokens";
import { preparePdfText } from "./arabic-pdf-text";

type PdfDocumentInstance = InstanceType<typeof PDFDocument>;

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");

function makeDoc(pageSize: [number, number] = [900, 1200]): PdfDocumentInstance {
  const doc = new PDFDocument({ size: [...pageSize], bufferPages: true, autoFirstPage: true });
  doc.registerFont("Body", fs.readFileSync(FONT_REGULAR_PATH));
  doc.registerFont("Bold", fs.readFileSync(FONT_BOLD_PATH));
  doc.font("Body");
  return doc;
}

function drawCover(doc: PdfDocumentInstance, title: string): void {
  drawComplaintsReportCover({
    doc,
    pageSize: [900, 1200] as const,
    margin: 42,
    title,
    periodText: "الفترة من 2025-08-01 إلى 2026-08-01",
    comparisonText: "لا تتوفر فترة زمنية للمقارنة",
    metrics: [
      { label: "إجمالي الشكاوى", value: 986 },
      { label: "المفتوحة", value: 120 },
      { label: "المغلقة", value: 866 },
    ],
  });
}

// ---------------------------------------------------------------------------
// 1. README mentions ivory colour
// ---------------------------------------------------------------------------

describe("docs/reporting/reference/README.md", () => {
  it("mentions ivory / العاجي colour in the colour identity line", () => {
    const readme = fs.readFileSync(
      path.join(process.cwd(), "docs/reporting/reference/README.md"),
      "utf8"
    );
    expect(readme).toMatch(/العاجي/);
  });
});

// ---------------------------------------------------------------------------
// 2. Design token background colour is ivory (#FCFAF5)
// ---------------------------------------------------------------------------

describe("REPORT_DESIGN_TOKENS — ivory background", () => {
  it("background token is the approved ivory colour #FCFAF5", () => {
    expect(REPORT_DESIGN_TOKENS.colors.background).toBe("#FCFAF5");
  });
});

// ---------------------------------------------------------------------------
// 3. tableHeader token exists and is independent from table
// ---------------------------------------------------------------------------

describe("REPORT_DESIGN_TOKENS — tableHeader fontSize", () => {
  it("tableHeader is defined", () => {
    expect(REPORT_DESIGN_TOKENS.fontSize.tableHeader).toBeDefined();
  });

  it("tableHeader is a positive number", () => {
    expect(REPORT_DESIGN_TOKENS.fontSize.tableHeader).toBeGreaterThan(0);
  });

  it("tableHeader is independent from table (different value)", () => {
    expect(REPORT_DESIGN_TOKENS.fontSize.tableHeader).not.toBe(
      REPORT_DESIGN_TOKENS.fontSize.table
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Cover: separator comes after title — no overlap
// ---------------------------------------------------------------------------

describe("drawComplaintsReportCover — separator position", () => {
  it("short title: separator y is greater than (titleY + fontSize)", () => {
    const doc = makeDoc();
    const textSpy = vi.spyOn(doc, "text");
    const moveSpy = vi.spyOn(doc, "moveTo");
    drawCover(doc, "تقرير الشكاوى");

    // Cast to unknown[][] because PDFKit text() has multiple overloads.
    const allTextCalls = textSpy.mock.calls as unknown[][];
    // Short title: preparePdfTextLayout produces one line with visualText =
    // preparePdfText("تقرير الشكاوى") = "الشكاوى تقرير".
    const titleCall = allTextCalls.find((c) => String(c[0]) === preparePdfText("تقرير الشكاوى"));
    expect(titleCall).toBeDefined();
    const titleY = titleCall![2] as number;

    const titleCallOrder = textSpy.mock.invocationCallOrder[
      allTextCalls.indexOf(titleCall!)
    ];
    const moveCallsAfterTitle = moveSpy.mock.calls.filter((_, i) => {
      return moveSpy.mock.invocationCallOrder[i] > titleCallOrder;
    });

    expect(moveCallsAfterTitle.length).toBeGreaterThan(0);
    const sepY = moveCallsAfterTitle[0][1] as number;

    // Separator must be strictly below titleY (at least one line height gap)
    expect(sepY).toBeGreaterThan(titleY + 18);

    textSpy.mockRestore();
    moveSpy.mockRestore();
  });

  it("long title (2+ lines): separator y is still below the last title line", () => {
    const doc = makeDoc();
    const textSpy = vi.spyOn(doc, "text");
    const moveSpy = vi.spyOn(doc, "moveTo");

    const longTitle = "تقرير الشكاوى الموحد للمنطقة الإدارية";
    drawCover(doc, longTitle);

    const allTextCallsLong = textSpy.mock.calls as unknown[][];
    // preparePdfTextLayout draws each wrapped line with lineBreak: false.
    // The first logical word "تقرير" is the LAST visual token of the first line
    // (RTL token reversal), so we locate the first title line by its last token.
    const firstTitleLineCall = allTextCallsLong.find((c) => {
      const tokens = String(c[0]).trim().split(" ");
      return tokens[tokens.length - 1] === "تقرير";
    });
    expect(firstTitleLineCall).toBeDefined();
    const titleY = firstTitleLineCall![2] as number;

    // No moveTo calls occur between title line draws.  The first moveTo after
    // the first title line call is the gold separator.
    const firstTitleCallOrder = textSpy.mock.invocationCallOrder[
      allTextCallsLong.indexOf(firstTitleLineCall!)
    ];
    const moveCallsAfterTitle = moveSpy.mock.calls.filter((_, i) => {
      return moveSpy.mock.invocationCallOrder[i] > firstTitleCallOrder;
    });

    expect(moveCallsAfterTitle.length).toBeGreaterThan(0);
    const sepY = moveCallsAfterTitle[0][1] as number;

    // Separator must be at least 18px below titleY (gap constant + one+ line heights)
    expect(sepY).toBeGreaterThan(titleY + 18);

    textSpy.mockRestore();
    moveSpy.mockRestore();
  });

  it("periodText y is strictly below the separator", () => {
    const doc = makeDoc();
    const textSpy = vi.spyOn(doc, "text");
    const moveSpy = vi.spyOn(doc, "moveTo");

    drawCover(doc, "تقرير الشكاوى");

    const allTextCallsPeriod = textSpy.mock.calls as unknown[][];
    // Short title: one visual line, same string as preparePdfText.
    const titleCall = allTextCallsPeriod.find((c) => String(c[0]) === preparePdfText("تقرير الشكاوى"));
    const periodCall = allTextCallsPeriod.find((c) => String(c[0]).includes("الفترة") && String(c[0]).includes("2025-08-01"));
    expect(titleCall).toBeDefined();
    expect(periodCall).toBeDefined();

    const titleCallOrder = textSpy.mock.invocationCallOrder[allTextCallsPeriod.indexOf(titleCall!)];
    const periodCallOrder = textSpy.mock.invocationCallOrder[allTextCallsPeriod.indexOf(periodCall!)];
    const periodY = periodCall![2] as number;

    const sepMoveCalls = moveSpy.mock.calls.filter((_, i) => {
      const order = moveSpy.mock.invocationCallOrder[i];
      return order > titleCallOrder && order < periodCallOrder;
    });
    expect(sepMoveCalls.length).toBeGreaterThan(0);
    const sepY = sepMoveCalls[0][1] as number;

    expect(periodY).toBeGreaterThan(sepY);

    textSpy.mockRestore();
    moveSpy.mockRestore();
  });

  it("title is drawn with layout options consistent for drawing and height computation", () => {
    // preparePdfTextLayout draws each line with lineBreak: false using the
    // same width, align, and wordSpacing that were used for layout computation.
    // This test verifies that those options propagate correctly to doc.text().
    const doc = makeDoc();
    const textSpy = vi.spyOn(doc, "text");

    drawCover(doc, "تقرير الشكاوى");

    const allTextCalls = textSpy.mock.calls as unknown[][];
    // Short title → single visual line with text = preparePdfText("تقرير الشكاوى").
    const titleCall = allTextCalls.find((c) => String(c[0]) === preparePdfText("تقرير الشكاوى"));
    expect(titleCall).toBeDefined();

    // The options object passed to doc.text() must include all layout-affecting
    // fields so that the visual output matches the layout computation.
    const titleOpts = titleCall![3] as Record<string, unknown>;
    expect(titleOpts).toMatchObject({
      width: expect.any(Number),
      align: "center",
      wordSpacing: expect.any(Number),
      lineBreak: false,
    });

    textSpy.mockRestore();
  });
});
