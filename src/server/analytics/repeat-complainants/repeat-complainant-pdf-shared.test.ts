// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import {
  createRepeatPdfDocument,
  drawPaginatedTable,
  type PdfColDef,
} from "./repeat-complainant-pdf-shared";
import { preparePdfTextLayout } from "@/server/reports/arabic-pdf-text";
import { REPORT_DESIGN_TOKENS } from "@/lib/reports/design-tokens";

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

  it("a 'wrap' column also wraps long English/LTR text (not just Arabic) — the long-text row is taller than a short-text row", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const columns: PdfColDef[] = [{ key: "subject", label: "Subject", weight: 1, overflow: "wrap", maxLines: 3 }];
    const narrowWidth = 140;
    const SHORT_ENGLISH = "Delayed";
    const LONG_ENGLISH = "Complaint about delayed medical appointment scheduling process";

    const yAfterShort = drawPaginatedTable({
      doc: ctx.doc, rows: [{ subject: SHORT_ENGLISH }], columns,
      x: ctx.margin, y: ctx.margin, width: narrowWidth, bottomLimit: ctx.bottomLimit,
      formatCell: (row: { subject: string }) => row.subject, newPage: () => ctx.margin,
    });
    const shortRowHeight = yAfterShort - ctx.margin - 24;

    const yAfterLong = drawPaginatedTable({
      doc: ctx.doc, rows: [{ subject: LONG_ENGLISH }], columns,
      x: ctx.margin, y: ctx.margin, width: narrowWidth, bottomLimit: ctx.bottomLimit,
      formatCell: (row: { subject: string }) => row.subject, newPage: () => ctx.margin,
    });
    const longRowHeight = yAfterLong - ctx.margin - 24;

    expect(longRowHeight).toBeGreaterThan(shortRowHeight);
    ctx.doc.end();
  });

  it("a 'wrap' column with mixed Arabic/English text also wraps correctly", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const columns: PdfColDef[] = [{ key: "subject", label: "الموضوع", weight: 1, overflow: "wrap", maxLines: 3 }];
    const narrowWidth = 140;
    const mixed = "شكوى بخصوص Medical Appointment Scheduling في العيادة المركزية";

    const yAfter = drawPaginatedTable({
      doc: ctx.doc, rows: [{ subject: mixed }], columns,
      x: ctx.margin, y: ctx.margin, width: narrowWidth, bottomLimit: ctx.bottomLimit,
      formatCell: (row: { subject: string }) => row.subject, newPage: () => ctx.margin,
    });
    const rowHeight = yAfter - ctx.margin - 24;
    expect(rowHeight).toBeGreaterThan(24);
    ctx.doc.end();
  });

  it("rowHeight for a 'wrap' column tracks the ACTUAL line count preparePdfTextLayout computes for English text (1, 2, 3 lines are each strictly taller)", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const columns: PdfColDef[] = [{ key: "subject", label: "Subject", weight: 1, overflow: "wrap", maxLines: 5 }];
    const narrowWidth = 140;
    const cellPaddingH = 8;
    const texts = [
      "Short",
      "This text needs a couple of lines to wrap across the narrow column width",
      "This considerably longer piece of English text will very likely need three or more separate wrapped lines to fit inside such a narrow column",
    ];

    const rowHeights = texts.map((text) => {
      const yAfter = drawPaginatedTable({
        doc: ctx.doc, rows: [{ subject: text }], columns,
        x: ctx.margin, y: ctx.margin, width: narrowWidth, bottomLimit: ctx.bottomLimit,
        formatCell: (row: { subject: string }) => row.subject, newPage: () => ctx.margin,
      });
      return yAfter - ctx.margin - 24;
    });

    // Cross-check against preparePdfTextLayout's own line count at the exact
    // same width the column used — drawPaginatedTable leaves the doc at its
    // own Body/table-fontSize afterward, so this measures with the SAME
    // metrics the table itself used.
    const expectedLineCounts = texts.map(
      (text) => Math.min(5, preparePdfTextLayout(ctx.doc, text, { width: narrowWidth - cellPaddingH }).lines.length)
    );
    expect(expectedLineCounts[1]!).toBeGreaterThan(expectedLineCounts[0]!);
    expect(expectedLineCounts[2]!).toBeGreaterThan(expectedLineCounts[1]!);
    expect(rowHeights[1]!).toBeGreaterThan(rowHeights[0]!);
    expect(rowHeights[2]!).toBeGreaterThan(rowHeights[1]!);
    ctx.doc.end();
  });

  it("a 'wrap' column beyond its maxLines cap truncates with a genuine ellipsis on exactly the final rendered line", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [{ key: "subject", label: "Subject", weight: 1, overflow: "wrap", maxLines: 2 }];
    const narrowWidth = 140;
    const veryLong = "This considerably longer piece of English text will need many more than two separate wrapped lines to fit inside such a narrow column width";

    drawPaginatedTable({
      doc: ctx.doc, rows: [{ subject: veryLong }], columns,
      x: ctx.margin, y: ctx.margin, width: narrowWidth, bottomLimit: ctx.bottomLimit,
      formatCell: (row: { subject: string }) => row.subject, newPage: () => ctx.margin,
    });

    const calls = collectTextCalls(textSpy);
    const subjectCalls = calls.filter((c) => veryLong.split(" ").some((word) => c.text.includes(word)));
    // Exactly maxLines (2) draw calls for this cell — never more.
    expect(subjectCalls.length).toBe(2);
    expect(subjectCalls[0]!.options.ellipsis).toBeFalsy();
    expect(subjectCalls[1]!.options.ellipsis).toBe(true);
    ctx.doc.end();
  });

  it("a single token wider than the cell (mid-paragraph, not the last visible line) still gets ellipsis so it never paints outside the cell", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [{ key: "subject", label: "Subject", weight: 1, overflow: "wrap", maxLines: 5 }];
    const narrowWidth = 90;
    const longToken = "SUPERCALIFRAGILISTICEXPIALIDOCIOUSIDENTIFIER1234567890";
    const text = `short ${longToken} more words after it`;

    drawPaginatedTable({
      doc: ctx.doc, rows: [{ subject: text }], columns,
      x: ctx.margin, y: ctx.margin, width: narrowWidth, bottomLimit: ctx.bottomLimit,
      formatCell: (row: { subject: string }) => row.subject, newPage: () => ctx.margin,
    });

    const calls = collectTextCalls(textSpy);
    const tokenCall = calls.find((c) => c.text.includes(longToken));
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.options.ellipsis).toBe(true);
    ctx.doc.end();
  });

  it("a full, normal-length identifier in a 'none' column fits within its allocated cell width", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [
      { key: "identity", label: "الهوية", weight: 1.3, overflow: "none" },
      { key: "name", label: "الاسم", weight: 2.2, overflow: "wrap" },
      { key: "count", label: "العدد", weight: 0.9 },
    ];
    const normalIdentifier = "1234567890";

    drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ identity: normalIdentifier, name: "محمد علي", count: "3" }],
      columns,
      x: ctx.margin, y: ctx.margin, width: 500, bottomLimit: ctx.bottomLimit,
      formatCell: (row: Record<string, string>, key: string) => row[key]!,
      newPage: () => ctx.margin,
    });

    const calls = collectTextCalls(textSpy);
    const identityCall = calls.find((c) => c.text.includes(normalIdentifier));
    expect(identityCall).toBeDefined();
    ctx.doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.table);
    const measuredWidth = ctx.doc.widthOfString(normalIdentifier, { wordSpacing: REPORT_DESIGN_TOKENS.typography.wordSpacing });
    // Strictly greater, not just >= : PDFKit itself silently drops the
    // trailing character of a lineBreak:false string when width equals the
    // string's own measured width EXACTLY (verified empirically — see
    // NONE_COLUMN_WIDTH_SAFETY_MARGIN in repeat-complainant-pdf-shared.ts).
    // A bare ">=" here would pass even if that safety margin regressed to 0.
    expect(identityCall!.options.width as number).toBeGreaterThan(measuredWidth);
    ctx.doc.end();
  });

  it("an unusually wide identifier in a 'none' column gets a column widened enough for its full text (never truncated, never overlapping)", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [
      { key: "identity", label: "الهوية", weight: 1.3, overflow: "none" },
      { key: "name", label: "الاسم", weight: 2.2, overflow: "wrap" },
      { key: "count", label: "العدد", weight: 0.9 },
    ];
    // Deliberately far wider than its 1.3/(1.3+2.2+0.9) weight share would allow.
    const wideIdentifier = "1234567890-ABCDEFGHIJ-1234567890-EXTRA-WIDE-IDENTIFIER-VALUE";

    drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ identity: wideIdentifier, name: "محمد علي القحطاني", count: "3" }],
      columns,
      x: ctx.margin, y: ctx.margin, width: 300, bottomLimit: ctx.bottomLimit,
      formatCell: (row: Record<string, string>, key: string) => row[key]!,
      newPage: () => ctx.margin,
    });

    const calls = collectTextCalls(textSpy);
    const identityCall = calls.find((c) => c.text.includes(wideIdentifier));
    expect(identityCall).toBeDefined();
    expect(identityCall!.options.ellipsis).toBeFalsy();

    ctx.doc.font("Body").fontSize(REPORT_DESIGN_TOKENS.fontSize.table);
    const measuredWidth = ctx.doc.widthOfString(wideIdentifier, { wordSpacing: REPORT_DESIGN_TOKENS.typography.wordSpacing });
    // Regression guard for a real, empirically-confirmed PDFKit bug: for a
    // ~60-character string, a flat few-point margin over widthOfString()
    // was NOT enough — PDFKit still dropped trailing characters — while a
    // ~5%-of-measured-width margin was. A bare ">= measuredWidth" check
    // would NOT have caught the earlier (too-small, fixed) margin, since
    // that also technically cleared "no less than the raw measurement".
    const cellWidth = identityCall!.options.width as number;
    expect(cellWidth).toBeGreaterThanOrEqual(measuredWidth + measuredWidth * 0.04);
    ctx.doc.end();
  });

  it("the identity column's rendered extent never reaches the adjacent column's own cell (no visual overlap)", () => {
    const ctx = createRepeatPdfDocument("test", { orientation: "landscape" });
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    const columns: PdfColDef[] = [
      { key: "identity", label: "الهوية", weight: 1.3, overflow: "none" },
      { key: "name", label: "الاسم", weight: 2.2, overflow: "wrap" },
    ];
    // Wide enough to need noticeably more than its 1.3/3.5 weight share of a
    // realistic (landscape-table-sized) width, but not wider than the whole
    // table — a table THAT narrow for a decoded identifier never happens in
    // the real bulk PDF (contentWidth there is ~750pt); this keeps the
    // scenario realistic while still exercising the reservation logic.
    const wideIdentifier = "1234567890-WIDE-IDENTIFIER-VALUE";

    drawPaginatedTable({
      doc: ctx.doc,
      rows: [{ identity: wideIdentifier, name: "محمد" }],
      columns,
      x: ctx.margin, y: ctx.margin, width: 700, bottomLimit: ctx.bottomLimit,
      formatCell: (row: Record<string, string>, key: string) => row[key]!,
      newPage: () => ctx.margin,
    });

    const calls = textSpy.mock.calls.map((call) => ({
      text: String(call[0]),
      x: call[1] as number,
      options: (call[3] ?? {}) as Record<string, unknown>,
    }));
    // identity is the first column (rightmost in this RTL layout, so the
    // larger x); name is the second (further left, smaller x).
    const identityCall = calls.find((c) => c.text.includes(wideIdentifier));
    const nameCall = calls.find((c) => c.text.includes("محمد"));
    expect(identityCall).toBeDefined();
    expect(nameCall).toBeDefined();
    expect(identityCall!.x).toBeGreaterThan(nameCall!.x);
    ctx.doc.end();
  });

  it("bulk (landscape) tables and single-person (portrait) tables both still render 'none'/'wrap' columns correctly side by side", () => {
    const columns: PdfColDef[] = [
      { key: "identity", label: "الهوية", weight: 1.3, overflow: "none" },
      { key: "name", label: "الاسم", weight: 2.2, overflow: "wrap", maxLines: 2 },
    ];
    for (const orientation of ["landscape", "portrait"] as const) {
      const ctx = createRepeatPdfDocument("test", { orientation });
      const yAfter = drawPaginatedTable({
        doc: ctx.doc,
        rows: [{ identity: "1234567890", name: "عبدالرحمن محمد عبدالله بن أحمد القحطاني" }],
        columns,
        x: ctx.margin, y: ctx.margin, width: ctx.contentWidth, bottomLimit: ctx.bottomLimit,
        formatCell: (row: Record<string, string>, key: string) => row[key]!,
        newPage: () => ctx.margin,
      });
      expect(yAfter).toBeGreaterThan(ctx.margin);
      ctx.doc.end();
    }
  });
});
