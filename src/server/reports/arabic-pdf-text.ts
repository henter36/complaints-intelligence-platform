/**
 * Central Arabic/RTL text preparation for PDFKit rendering.
 *
 * Background
 * ----------
 * PDFKit splits input text at whitespace before handing each token to fontkit.
 * fontkit detects Arabic script and REVERSES the glyph array after shaping, so
 * Arabic words arrive at the PDF stream in visual (right-to-left) order — letter
 * forms are correct.  Numbers and Latin tokens are detected as Common/LTR script
 * and are NOT reversed by fontkit; they arrive in logical (left-to-right) order.
 *
 * Because PDFKit places every token from left to right in PDF coordinates, the
 * word ORDER within a sentence remains the original Unicode logical order.  An
 * Arabic reader who scans right-to-left therefore encounters the words in reversed
 * sentence order (last word first, first word last).
 *
 * Fix: before passing text to doc.text() / doc.heightOfString() / doc.widthOfString()
 * we reorder the SPACE-DELIMITED TOKENS so that the visual order matches an RTL
 * paragraph.  We deliberately keep each token's internal character order unchanged
 * so fontkit can still apply correct Arabic contextual shaping.
 *
 * Two APIs are provided:
 *
 *   preparePdfText(value)
 *     For text guaranteed to fit on a single line (short headers, KPI card
 *     values, table cells with lineBreak: false, page numbers).
 *
 *   preparePdfTextLayout(doc, text, options)
 *     For text that may wrap at a given width (titles, bullets, notes).
 *     Wraps the logical text first, THEN reverses each wrapped line so that
 *     PDFKit does not re-wrap the already-reversed visual text.
 */

import type PDFKit from "pdfkit";

// ---------------------------------------------------------------------------
// Basic detection helpers
// ---------------------------------------------------------------------------

const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Returns true when the string contains at least one Arabic-script character. */
export function containsArabic(value: string): boolean {
  return ARABIC_RANGE.test(value);
}

/** Returns true when the value would produce visible numeric output only. */
export function isNumericDisplayValue(value: string): boolean {
  return /^[\d,.\-+%٠-٩\s]+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// First-strong paragraph direction detection
// ---------------------------------------------------------------------------

/**
 * Returns 'rtl' when the first strong directional character in `text` is Arabic.
 * Scans until an Arabic or Latin character is found; defaults to 'ltr'.
 *
 * Since preparePdfText and preparePdfTextLayout guard on containsArabic()
 * before calling here, an Arabic character is found within the first few
 * characters in every real report-text case.
 */
function paragraphDirection(text: string): "rtl" | "ltr" {
  if (!text) return "ltr";
  for (const ch of text) {
    if (ARABIC_RANGE.test(ch)) return "rtl";
    if (/[A-Za-z]/.test(ch)) return "ltr";
  }
  return "ltr";
}

// ---------------------------------------------------------------------------
// Token-level processing with whitespace preservation
// ---------------------------------------------------------------------------

type TextRun =
  | { kind: "token"; value: string }
  | { kind: "whitespace"; value: string };

/** Splits a line into alternating token and whitespace runs. */
function tokenizeLine(line: string): TextRun[] {
  return line
    .split(/(\s+)/)
    .filter((part) => part.length > 0)
    .map((part): TextRun =>
      /^\s+$/.test(part)
        ? { kind: "whitespace", value: part }
        : { kind: "token", value: part }
    );
}

/**
 * Reverses token positions in an array of text runs while keeping whitespace
 * runs at their original positions between tokens. Each token's internal
 * character order is preserved for fontkit's Arabic contextual shaping.
 *
 * Example: ["كلمة", " ", "أخرى"] → ["أخرى", " ", "كلمة"]
 * Example: ["أ", "\t", "ب", "  ", "ج"] → ["ج", "\t", "ب", "  ", "أ"]
 */
function reverseRunTokens(runs: TextRun[]): TextRun[] {
  const tokenValues = runs
    .filter((r): r is { kind: "token"; value: string } => r.kind === "token")
    .map((r) => r.value)
    .toReversed();
  let ti = 0;
  return runs.map((run): TextRun => {
    if (run.kind === "token") {
      return { kind: "token", value: tokenValues[ti++]! };
    }
    return run;
  });
}

function runsToString(runs: TextRun[]): string {
  return runs.map((r) => r.value).join("");
}

/**
 * Prepares a single line of text for PDF rendering.
 *
 * RTL lines: reverses token order while preserving each token's internal
 * character sequence and the original whitespace structure (multiple spaces,
 * tabs) between token positions.
 *
 * LTR lines: returned unchanged.
 */
function prepareLine(line: string): string {
  if (!containsArabic(line)) return line;
  if (paragraphDirection(line) !== "rtl") return line;
  return runsToString(reverseRunTokens(tokenizeLine(line)));
}

// ---------------------------------------------------------------------------
// Public single-line API
// ---------------------------------------------------------------------------

/**
 * Prepares a string for PDF rendering by reversing space-delimited token order
 * in RTL paragraphs. Whitespace structure (single spaces, multiple spaces,
 * tabs) is preserved between token positions. Each token's internal character
 * order is kept intact for fontkit Arabic contextual shaping.
 *
 * Use ONLY for text that is guaranteed to fit on a single visual line:
 *   - short section headers
 *   - KPI card labels and values
 *   - table cells rendered with lineBreak: false
 *   - page numbers and short footer strings
 *
 * For text that may wrap at a given width, use preparePdfTextLayout instead.
 */
export function preparePdfText(value: string): string {
  if (!value || !containsArabic(value)) return value;
  return value.split("\n").map(prepareLine).join("\n");
}

/**
 * Alias for preparePdfText; signals multi-line content with explicit \n
 * separators.  Each \n-delimited line is processed independently.
 */
export function preparePdfTextLines(value: string): string {
  return preparePdfText(value);
}

// ---------------------------------------------------------------------------
// Multi-line layout API — for text that may wrap at a given width
// ---------------------------------------------------------------------------

/** One visual line produced by preparePdfTextLayout. */
export type PreparedPdfLine = {
  /** Original logical token order (preserves semantics for debugging). */
  logicalText: string;
  /** Visual text ready to pass to doc.text() with lineBreak: false — token-reversed for an RTL line, unchanged for an LTR line. */
  visualText: string;
  /** Width constraint used when this line was laid out. */
  width: number;
  /**
   * True only when this line is a single token whose own width already
   * exceeds `width` — the one case wrapping-by-token-boundary cannot fix.
   * Callers must render such a line with `ellipsis: true` (even mid-
   * paragraph, not just the last line) so it never paints past the column
   * into a neighboring cell.
   */
  overflowsWidth: boolean;
};

export type PreparedPdfTextLayout = {
  lines: PreparedPdfLine[];
  lineHeight: number;
  height: number;
};

// ---------------------------------------------------------------------------
// preparePdfTextLayout helpers
// ---------------------------------------------------------------------------

function resolveMaxWidth(options: PDFKit.Mixins.TextOptions): number {
  return options.width !== undefined ? options.width : Infinity;
}

/**
 * A token-width record kept alongside each wrapped line so callers can tell
 * whether the line is a single unbreakable token wider than `maxWidth` (the
 * one case token-boundary wrapping cannot fix — see `overflowsWidth`).
 */
type WrappedLineTokens = { tokens: string[]; singleTokenWidth: number | null };

/**
 * Wraps a paragraph into visual lines by measuring LOGICAL token widths —
 * direction-agnostic; the caller decides whether to reverse token order per
 * line based on the paragraph's own direction. Works for RTL Arabic, LTR
 * English/numeric, and mixed-direction text alike, since word-wrap-by-width
 * is the same algorithm regardless of script.
 */
function wrapParagraphIntoLines(
  doc: PDFKit.PDFDocument,
  paragraph: string,
  maxWidth: number,
  wordSpacing: number
): WrappedLineTokens[] {
  const tokens = paragraph.split(" ").filter((t) => t.length > 0);
  const spaceWidth = doc.widthOfString(" ") + wordSpacing;
  const wrappedLines: string[][] = [];
  let lineTokens: string[] = [];
  let lineWidth = 0;

  for (const token of tokens) {
    const tokenWidth = doc.widthOfString(token);
    if (lineTokens.length > 0 && lineWidth + spaceWidth + tokenWidth > maxWidth) {
      wrappedLines.push(lineTokens);
      lineTokens = [token];
      lineWidth = tokenWidth;
    } else {
      lineWidth = lineTokens.length > 0 ? lineWidth + spaceWidth + tokenWidth : tokenWidth;
      lineTokens.push(token);
    }
  }
  if (lineTokens.length > 0) wrappedLines.push(lineTokens);

  // A line is only ever a single unbreakable token when that token's own
  // width already exceeds maxWidth (otherwise it would have absorbed the
  // next token too) — so re-measuring just single-token lines is enough to
  // flag the "cannot be fixed by wrapping" case without re-measuring every line.
  return wrappedLines.map((lineTok) => ({
    tokens: lineTok,
    singleTokenWidth: lineTok.length === 1 ? doc.widthOfString(lineTok[0]) : null,
  }));
}

/**
 * Processes one \n-delimited paragraph and appends the resulting
 * PreparedPdfLine entries to `target`. Wraps ANY paragraph (RTL Arabic, LTR,
 * or mixed) once `maxWidth` is finite; an infinite width never wraps,
 * matching the pre-existing single-line contract for unconstrained text.
 */
function appendPreparedParagraph(
  target: PreparedPdfLine[],
  doc: PDFKit.PDFDocument,
  paragraph: string,
  maxWidth: number,
  wordSpacing: number
): void {
  if (!paragraph) {
    target.push({ logicalText: "", visualText: "", width: maxWidth, overflowsWidth: false });
    return;
  }

  if (!Number.isFinite(maxWidth)) {
    target.push({ logicalText: paragraph, visualText: paragraph, width: maxWidth, overflowsWidth: false });
    return;
  }

  // First-strong-character heuristic — the SAME one prepareLine() uses for
  // single-line text, so a paragraph never reverses in the wrapped path but
  // not the single-line path (or vice versa). RTL reverses token order per
  // line (fontkit already reverses Arabic glyphs within a token); LTR keeps
  // logical order as visual order.
  const isRtl = containsArabic(paragraph) && paragraphDirection(paragraph) === "rtl";
  const wrappedLines = wrapParagraphIntoLines(doc, paragraph, maxWidth, wordSpacing);

  for (const { tokens: wTokens, singleTokenWidth } of wrappedLines) {
    const logicalText = wTokens.join(" ");
    target.push({
      logicalText,
      visualText: isRtl ? wTokens.toReversed().join(" ") : logicalText,
      width: maxWidth,
      overflowsWidth: singleTokenWidth !== null && singleTokenWidth > maxWidth,
    });
  }
}

/**
 * Prepares multi-line text for PDF rendering with correct RTL layout.
 *
 * Algorithm
 * ---------
 * 1. Split text into paragraphs at \n.
 * 2. For each RTL paragraph, wrap it into visual lines by measuring individual
 *    word widths with the current PDFKit font and size — BEFORE reversing tokens.
 * 3. Reverse token order within each wrapped line independently.
 * 4. Return all lines with their line height and total height.
 *
 * Rendering (required usage)
 * --------------------------
 *   const layout = preparePdfTextLayout(doc, text, { width, align, wordSpacing });
 *   let y = startY;
 *   for (const line of layout.lines) {
 *     doc.text(line.visualText, x, y, { ...options, lineBreak: false });
 *     y += layout.lineHeight;
 *   }
 *
 * Measuring
 * ---------
 *   const layout = preparePdfTextLayout(doc, text, { width });
 *   const height = layout.height;  // use instead of doc.heightOfString
 *
 * The caller must set the correct font and size before calling this function
 * so that widthOfString measurements match the rendered output.
 */
export function preparePdfTextLayout(
  doc: PDFKit.PDFDocument,
  text: string,
  options: PDFKit.Mixins.TextOptions
): PreparedPdfTextLayout {
  const maxWidth = resolveMaxWidth(options);
  const wordSpacing = (options as { wordSpacing?: number }).wordSpacing ?? 0;
  const lineHeight = doc.currentLineHeight(true);
  const allLines: PreparedPdfLine[] = [];

  for (const paragraph of text.split("\n")) {
    appendPreparedParagraph(allLines, doc, paragraph, maxWidth, wordSpacing);
  }

  return {
    lines: allLines,
    lineHeight,
    height: allLines.length * lineHeight,
  };
}

// ---------------------------------------------------------------------------
// Rendering wrappers (convenience API — single-line only)
// ---------------------------------------------------------------------------

type PdfTextOptions = PDFKit.Mixins.TextOptions;

/**
 * Draws text to a PDFKit document after applying RTL preparation.
 * For single-line use only. For multi-line or wrappable text, use
 * preparePdfTextLayout and draw each line with lineBreak: false.
 */
export function drawPdfText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  options: PdfTextOptions,
): PDFKit.PDFDocument {
  return doc.text(preparePdfText(text), x, y, options);
}

/**
 * Measures the rendered height of text after applying RTL preparation.
 * Use only for single-line text; for wrappable text use PreparedPdfTextLayout.height.
 */
export function measurePdfTextHeight(
  doc: PDFKit.PDFDocument,
  text: string,
  options: PdfTextOptions,
): number {
  return doc.heightOfString(preparePdfText(text), options);
}

/**
 * Measures the rendered width of text after applying RTL preparation.
 */
export function measurePdfTextWidth(
  doc: PDFKit.PDFDocument,
  text: string,
  options?: PdfTextOptions,
): number {
  return doc.widthOfString(preparePdfText(text), options);
}
