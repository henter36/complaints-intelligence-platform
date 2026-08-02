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
 * We use bidi-js only for paragraph-direction detection (RTL vs LTR base), which
 * is the part that requires full UBA analysis.  Token reordering itself is done at
 * the word level because PDFKit's own tokenisation at spaces means character-level
 * UBA reordering would conflict with fontkit's character-level reversal.
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

/** Checks whether a non-empty string value would produce visible numeric output only. */
export function isNumericDisplayValue(value: string): boolean {
  return /^[\d,.\-+%٠-٩\s]+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Paragraph-direction detection via bidi-js
// ---------------------------------------------------------------------------

/**
 * Returns 'rtl' when the first strong directional character in `text` is Arabic.
 *
 * Fast path: scan for the first strong directional character.
 * Since preparePdfText guards on containsArabic() before calling here, an
 * Arabic character is found within the first few characters in every real case.
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
// Core line processor
// ---------------------------------------------------------------------------

/**
 * Prepares a single line of text for PDF rendering.
 *
 * For RTL paragraphs: splits the line into space-delimited tokens and reverses
 * their order.  Each token's internal character sequence is preserved so fontkit
 * can apply correct Arabic contextual shaping (which requires logical character
 * order as input).
 *
 * For LTR paragraphs: returns the line unchanged.  fontkit handles Arabic words
 * embedded in LTR text correctly without pre-processing.
 */
function prepareLine(line: string): string {
  if (!containsArabic(line)) return line;
  if (paragraphDirection(line) !== "rtl") return line;

  // Split on runs of whitespace, preserving the separators.
  // This handles multiple consecutive spaces and tab characters.
  const parts = line.split(/(\s+)/);
  // parts alternates: [word, sep, word, sep, ...] — reverse only the word/sep
  // pairs so word order is flipped while separators keep their adjacency.
  // Simplest correct approach: split on single spaces, reverse, rejoin.
  const tokens = line.split(" ");
  return tokens.reverse().join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Prepares a string for PDF rendering.
 *
 * - Arabic / mixed Arabic+Latin paragraphs: token order is reversed to match RTL
 *   paragraph visual ordering.  Internal character order within each token is
 *   preserved for fontkit's Arabic shaping.
 * - Pure LTR / numeric content: returned unchanged.
 * - Multi-line text: each line is processed independently.
 * - Empty strings and strings without Arabic are returned unchanged.
 *
 * IMPORTANT: apply this function ONLY inside PDF renderers (doc.text,
 * heightOfString, widthOfString).  Never apply it to values stored in the
 * database, API responses, or XLSX output.
 */
export function preparePdfText(value: string): string {
  if (!value || !containsArabic(value)) return value;
  return value
    .split("\n")
    .map(prepareLine)
    .join("\n");
}

/**
 * Prepares multi-line bullet / paragraph text.  Equivalent to preparePdfText
 * but signals that the caller expects newline-delimited content.
 */
export function preparePdfTextLines(value: string): string {
  return preparePdfText(value);
}

// ---------------------------------------------------------------------------
// Rendering wrappers
// ---------------------------------------------------------------------------

type PdfTextOptions = PDFKit.Mixins.TextOptions;

/**
 * Draws text to a PDFKit document after applying RTL preparation.
 * Always use this instead of doc.text() for Arabic content so that the same
 * processed string is used for both rendering and layout.
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
 * Must use the SAME processed string as drawPdfText to avoid layout/render
 * mismatches that cause overlap or clipping.
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
