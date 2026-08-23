// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import {
  createRepeatPdfDocument,
  drawPaginatedTable,
  type PdfColDef,
} from "./repeat-complainant-pdf-shared";

function collectTextCalls(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call) => ({
    text: String(call[0]),
    options: (call[3] ?? {}) as Record<string, unknown>,
  }));
}

describe("createRepeatPdfDocument — orientation", () => {
  it("defaults to A4 portrait (595.28 x 841.89)", () => {
    const ctx = createRepeatPdfDocument("test");
    expect(ctx.orientation).toBe("portrait");
    expect(ctx.pageWidth).toBeCloseTo(595.28, 1);
    expect(ctx.pageHeight).toBeCloseTo(841.89, 1);
    expect(ctx.pageWidth).toBeLessThan(ctx.pageHeight);
    ctx.doc.end();
  });

  it("orientation: 'landscape' produces A4 landscape (841.89 x 595.28) — transposed, not a different page size", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    expect(ctx.orientation).toBe("landscape");
    expect(ctx.pageWidth).toBeCloseTo(841.89, 1);
    expect(ctx.pageHeight).toBeCloseTo(595.28, 1);
    expect(ctx.pageWidth).toBeGreaterThan(ctx.pageHeight);
    ctx.doc.end();
  });

  it("each context derives its OWN contentWidth/bottomLimit/margin from its own page size — no shared global state between a portrait and a landscape document created back to back", () => {
    const portrait = createRepeatPdfDocument("p", { orientation: "portrait" });
    const landscape = createRepeatPdfDocument("l", { orientation: "landscape" });

    expect(portrait.margin).toBe(landscape.margin);
    expect(portrait.contentWidth).toBeCloseTo(595.28 - portrait.margin * 2, 1);
    expect(landscape.contentWidth).toBeCloseTo(841.89 - landscape.margin * 2, 1);
    expect(landscape.contentWidth).toBeGreaterThan(portrait.contentWidth);
    expect(portrait.bottomLimit).toBeLessThan(portrait.pageHeight);
    expect(landscape.bottomLimit).toBeLessThan(landscape.pageHeight);

    portrait.doc.end();
    landscape.doc.end();
  });
});

describe("drawPaginatedTable — dynamic row height + overflow policy", () => {
  const SHORT_NAME = "محمد علي";
  const VERY_LONG_NAME = "عبدالرحمن محمد عبدالله بن أحمد القحطاني";

  it("a row needing two wrapped lines is taller than a row that fits on one line", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const columns: PdfColDef[] = [{ key: "name", label: "الاسم", weight: 1, overflow: "wrap", maxLines: 2 }];
    // A narrow column forces the long name to wrap while the short one stays on one line.
    const narrowWidth = 140;

    const yAfterShort = drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ name: SHORT_NAME }],
      columns,
      x: ctx.margin,
      y: ctx.margin,
      width: narrowWidth,
      bottomLimit: ctx.bottomLimit,
      formatCell: (row: { name: string }) => row.name,
      newPage: () => ctx.margin,
    });
    const shortRowHeight = yAfterShort - ctx.margin - 24; // minus header height

    const yAfterLong = drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ name: VERY_LONG_NAME }],
      columns,
      x: ctx.margin,
      y: ctx.margin,
      width: narrowWidth,
      bottomLimit: ctx.bottomLimit,
      formatCell: (row: { name: string }) => row.name,
      newPage: () => ctx.margin,
    });
    const longRowHeight = yAfterLong - ctx.margin - 24;

    expect(longRowHeight).toBeGreaterThan(shortRowHeight);
    ctx.doc.end();
  });

  it("a 'wrap' column is drawn with lineBreak: false per visual line — never handed to PDFKit's own wrapping engine (which would scramble already-reversed Arabic word order)", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [{ key: "name", label: "الاسم", weight: 1, overflow: "wrap", maxLines: 2 }];

    drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ name: VERY_LONG_NAME }],
      columns,
      x: ctx.margin,
      y: ctx.margin,
      width: 140,
      bottomLimit: ctx.bottomLimit,
      formatCell: (row: { name: string }) => row.name,
      newPage: () => ctx.margin,
    });

    const calls = collectTextCalls(textSpy);
    const nameCellCalls = calls.filter((c) => VERY_LONG_NAME.split(" ").some((word) => c.text.includes(word)));
    expect(nameCellCalls.length).toBeGreaterThan(0);
    for (const call of nameCellCalls) {
      expect(call.options.lineBreak).toBe(false);
    }
    ctx.doc.end();
  });

  it("an 'ellipsis' column never allows PDFKit line-wrapping (single line only) and DOES truncate with an ellipsis", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "portrait" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [{ key: "date", label: "التاريخ", weight: 1 }]; // default overflow: "ellipsis"

    drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ date: "2026-01-01" }],
      columns,
      x: ctx.margin,
      y: ctx.margin,
      width: 200,
      bottomLimit: ctx.bottomLimit,
      formatCell: (row: { date: string }) => row.date,
      newPage: () => ctx.margin,
    });

    const calls = collectTextCalls(textSpy);
    const cellCall = calls.find((c) => c.text.includes("2026"));
    expect(cellCall).toBeDefined();
    expect(cellCall!.options.lineBreak).toBe(false);
    expect(cellCall!.options.ellipsis).toBe(true);
    ctx.doc.end();
  });

  it("a 'none' column (identity) is never given ellipsis: true — a masked/full identifier must render completely, never silently truncated", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [{ key: "identity", label: "الهوية", weight: 1, overflow: "none" }];
    const fullIdentifier = "1234567890";

    drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ identity: fullIdentifier }],
      columns,
      x: ctx.margin,
      y: ctx.margin,
      width: 200,
      bottomLimit: ctx.bottomLimit,
      formatCell: (row: { identity: string }) => row.identity,
      newPage: () => ctx.margin,
    });

    const calls = collectTextCalls(textSpy);
    const cellCall = calls.find((c) => c.text.includes(fullIdentifier));
    expect(cellCall).toBeDefined();
    expect(cellCall!.options.ellipsis).toBe(false);
    expect(cellCall!.options.lineBreak).toBe(false);
    ctx.doc.end();
  });

  it("never splits a row across two pages: a row that doesn't fully fit triggers newPage() BEFORE that row is drawn", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "portrait" });
    const columns: PdfColDef[] = [{ key: "n", label: "#", weight: 1 }];
    const rows = Array.from({ length: 3 }, (_, i) => ({ n: String(i) }));
    let newPageCalls = 0;

    // bottomLimit set just above the header height + one row, so the SECOND
    // row can never fit without a page break.
    const tightBottomLimit = ctx.margin + 24 /* header */ + 24 /* one row */ + 2;

    drawPaginatedTable({
      doc: ctx.doc,
      rows,
      columns,
      x: ctx.margin,
      y: ctx.margin,
      width: 200,
      bottomLimit: tightBottomLimit,
      formatCell: (row: { n: string }) => row.n,
      newPage: () => {
        newPageCalls += 1;
        return ctx.margin;
      },
    });

    expect(newPageCalls).toBeGreaterThan(0);
    ctx.doc.end();
  });
});
