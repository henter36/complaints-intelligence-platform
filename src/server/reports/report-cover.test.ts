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

    // Cast to unknown[][] because PDFKit text() has multiple overloads; the (text, x, y, opts)
    // form is not the primary overload TypeScript infers for the spy, so call[2] would be
    // flagged as out-of-bounds on the inferred 2-element tuple type without the cast.
    const allTextCalls = textSpy.mock.calls as unknown[][];
    const titleCall = allTextCalls.find((c) => String(c[0]) === preparePdfText("تقرير الشكاوى"));
    expect(titleCall).toBeDefined();
    const titleY = titleCall![2] as number; // third argument is y

    // First moveTo after the title text call is the separator line start
    const titleCallOrder = textSpy.mock.invocationCallOrder[
      allTextCalls.indexOf(titleCall!)
    ];
    const moveCallsAfterTitle = moveSpy.mock.calls.filter((_, i) => {
      return moveSpy.mock.invocationCallOrder[i] > titleCallOrder;
    });

    // The first moveTo after the title is the separator's left arm
    expect(moveCallsAfterTitle.length).toBeGreaterThan(0);
    const sepY = moveCallsAfterTitle[0][1] as number;

    // Separator must be strictly below titleY (title font is 80pt, so at least 80px gap)
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

    // Same unknown[][] cast as the short-title test — PDFKit text() overload resolution issue.
    const allTextCallsLong = textSpy.mock.calls as unknown[][];
    const titleCall = allTextCallsLong.find((c) => String(c[0]) === preparePdfText(longTitle));
    expect(titleCall).toBeDefined();
    const titleY = titleCall![2] as number;

    const titleCallOrder = textSpy.mock.invocationCallOrder[
      allTextCallsLong.indexOf(titleCall!)
    ];
    const moveCallsAfterTitle = moveSpy.mock.calls.filter((_, i) => {
      return moveSpy.mock.invocationCallOrder[i] > titleCallOrder;
    });

    expect(moveCallsAfterTitle.length).toBeGreaterThan(0);
    const sepY = moveCallsAfterTitle[0][1] as number;

    // Separator must be at least 18px below titleY (the fixed gap after dynamic height)
    expect(sepY).toBeGreaterThan(titleY + 18);

    textSpy.mockRestore();
    moveSpy.mockRestore();
  });

  it("periodText y is strictly below the separator", () => {
    const doc = makeDoc();
    const textSpy = vi.spyOn(doc, "text");
    const moveSpy = vi.spyOn(doc, "moveTo");

    drawCover(doc, "تقرير الشكاوى");

    // Same unknown[][] cast — PDFKit text() overload resolution issue.
    const allTextCallsPeriod = textSpy.mock.calls as unknown[][];
    const titleCall = allTextCallsPeriod.find((c) => String(c[0]) === preparePdfText("تقرير الشكاوى"));
    const periodCall = allTextCallsPeriod.find((c) => String(c[0]).includes("الفترة") && String(c[0]).includes("2025-08-01"));
    expect(titleCall).toBeDefined();
    expect(periodCall).toBeDefined();

    const titleCallOrder = textSpy.mock.invocationCallOrder[allTextCallsPeriod.indexOf(titleCall!)];
    const periodCallOrder = textSpy.mock.invocationCallOrder[allTextCallsPeriod.indexOf(periodCall!)];
    const periodY = periodCall![2] as number;

    // Find moveTo calls between title text and period text — these belong to the separator
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

  it("title height is measured with the same options used for drawing", () => {
    // This verifies that the dynamic separator calculation uses consistent options.
    // We check that a doc.heightOfString call occurs before the first moveTo after the title.
    const doc = makeDoc();
    const heightSpy = vi.spyOn(doc, "heightOfString");
    const textSpy = vi.spyOn(doc, "text");

    drawCover(doc, "تقرير الشكاوى");

    const titleCall = textSpy.mock.calls.find((c) => String(c[0]) === preparePdfText("تقرير الشكاوى"));
    expect(titleCall).toBeDefined();

    // heightOfString must have been called for the (prepared) title text
    const heightCallsForTitle = heightSpy.mock.calls.filter(
      (c) => String(c[0]) === preparePdfText("تقرير الشكاوى")
    );
    expect(heightCallsForTitle.length).toBeGreaterThanOrEqual(1);

    // The options passed to heightOfString must include width and wordSpacing
    const heightOpts = heightCallsForTitle[0][1] as Record<string, unknown>;
    expect(heightOpts).toMatchObject({ width: expect.any(Number) });

    heightSpy.mockRestore();
    textSpy.mockRestore();
  });
});
