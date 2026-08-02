// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import {
  preparePdfText,
  preparePdfTextLines,
  preparePdfTextLayout,
  containsArabic,
  isNumericDisplayValue,
  drawPdfText,
} from "./arabic-pdf-text";

// ---------------------------------------------------------------------------
// Test document factory (needed for preparePdfTextLayout and drawPdfText)
// ---------------------------------------------------------------------------

const ASSETS_DIR = path.join(process.cwd(), "src/server/reports/assets");
const FONT_REGULAR_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Regular.ttf");
const FONT_BOLD_PATH = path.join(ASSETS_DIR, "fonts/Amiri-Bold.ttf");

function makeTestDoc(fontSize = 12): InstanceType<typeof PDFDocument> {
  const doc = new PDFDocument({ bufferPages: true, autoFirstPage: true });
  doc.registerFont("Body", fs.readFileSync(FONT_REGULAR_PATH));
  doc.registerFont("Bold", fs.readFileSync(FONT_BOLD_PATH));
  doc.font("Body").fontSize(fontSize);
  return doc;
}

// ---------------------------------------------------------------------------
// Helper: reconstruct logical sentence from a prepared (visually reversed) string
// ---------------------------------------------------------------------------

/**
 * Reads a prepared RTL string right-to-left by reversing the token order.
 * Should reconstruct the original logical sentence for single-line RTL text.
 */
function readRtl(prepared: string): string {
  return prepared.split(" ").toReversed().join(" ");
}

// ---------------------------------------------------------------------------
// 1. containsArabic
// ---------------------------------------------------------------------------

describe("containsArabic", () => {
  it("returns true for pure Arabic", () => {
    expect(containsArabic("تقرير الشكاوى")).toBe(true);
  });

  it("returns true for Arabic mixed with numbers", () => {
    expect(containsArabic("الفترة من 2026-01-01")).toBe(true);
  });

  it("returns false for pure English", () => {
    expect(containsArabic("SLA report")).toBe(false);
  });

  it("returns false for pure numbers", () => {
    expect(containsArabic("2026-01-01")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsArabic("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. isNumericDisplayValue
// ---------------------------------------------------------------------------

describe("isNumericDisplayValue", () => {
  it("returns true for plain number", () => {
    expect(isNumericDisplayValue("123")).toBe(true);
  });

  it("returns true for percentage string", () => {
    expect(isNumericDisplayValue("25%")).toBe(true);
  });

  it("returns true for signed number", () => {
    expect(isNumericDisplayValue("+12")).toBe(true);
  });

  it("returns false for Arabic text", () => {
    expect(isNumericDisplayValue("منطقة الرياض")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. preparePdfText — pure Arabic text
// ---------------------------------------------------------------------------

describe("preparePdfText — pure Arabic", () => {
  it("'تقرير الشكاوى': reverses token order so RTL reading reproduces original", () => {
    const input = "تقرير الشكاوى";
    const prepared = preparePdfText(input);
    expect(readRtl(prepared)).toBe(input);
  });

  it("'ملخص المؤشرات': token order reversed for correct RTL visual layout", () => {
    const input = "ملخص المؤشرات";
    const prepared = preparePdfText(input);
    expect(prepared).toBe("المؤشرات ملخص");
    expect(readRtl(prepared)).toBe(input);
  });

  it("'مقارنة مع الفترة السابقة': four-word sentence reverses correctly", () => {
    const input = "مقارنة مع الفترة السابقة";
    const prepared = preparePdfText(input);
    expect(prepared).toBe("السابقة الفترة مع مقارنة");
    expect(readRtl(prepared)).toBe(input);
  });

  it("does not reverse individual character order within a word", () => {
    const input = "تقرير الشكاوى";
    const prepared = preparePdfText(input);
    const tokens = prepared.split(" ");
    expect(tokens).toContain("تقرير");
    expect(tokens).toContain("الشكاوى");
  });

  it("single Arabic word is returned unchanged", () => {
    expect(preparePdfText("تقرير")).toBe("تقرير");
  });
});

// ---------------------------------------------------------------------------
// 4. preparePdfText — pure English / numeric
// ---------------------------------------------------------------------------

describe("preparePdfText — pure English / numeric", () => {
  it("'SLA report': pure English returned unchanged", () => {
    expect(preparePdfText("SLA report")).toBe("SLA report");
  });

  it("pure number returned unchanged", () => {
    expect(preparePdfText("2026-01-01")).toBe("2026-01-01");
  });

  it("empty string returned unchanged", () => {
    expect(preparePdfText("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. preparePdfText — Arabic with dates
// ---------------------------------------------------------------------------

describe("preparePdfText — Arabic with dates", () => {
  it("'الفترة من 2026-01-01 إلى 2026-01-31': date tokens stay in original character order", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    const prepared = preparePdfText(input);
    expect(prepared).toContain("2026-01-01");
    expect(prepared).toContain("2026-01-31");
  });

  it("RTL reading of prepared date sentence reconstructs the original", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });

  it("start date appears to the right of end date in prepared string", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    const prepared = preparePdfText(input);
    const idx01 = prepared.indexOf("2026-01-01");
    const idx31 = prepared.indexOf("2026-01-31");
    expect(idx01).toBeGreaterThan(idx31);
  });
});

// ---------------------------------------------------------------------------
// 6. preparePdfText — Arabic with percentage
// ---------------------------------------------------------------------------

describe("preparePdfText — Arabic with percentage", () => {
  it("'ارتفاع بنسبة 25%': percentage token stays intact", () => {
    const input = "ارتفاع بنسبة 25%";
    expect(preparePdfText(input)).toContain("25%");
  });

  it("percentage is NOT reversed to %52", () => {
    expect(preparePdfText("ارتفاع بنسبة 25%")).not.toContain("%52");
  });

  it("RTL reading reconstructs original sentence", () => {
    const input = "ارتفاع بنسبة 25%";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 7. preparePdfText — Arabic with positive sign
// ---------------------------------------------------------------------------

describe("preparePdfText — Arabic with positive sign", () => {
  it("'الفرق +12 شكوى': +12 token stays intact", () => {
    expect(preparePdfText("الفرق +12 شكوى")).toContain("+12");
  });

  it("+12 is NOT reversed to 21+", () => {
    expect(preparePdfText("الفرق +12 شكوى")).not.toContain("21+");
  });

  it("RTL reading reconstructs original", () => {
    const input = "الفرق +12 شكوى";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 8. preparePdfText — whitespace preservation
// ---------------------------------------------------------------------------

describe("preparePdfText — whitespace preservation", () => {
  it("double space between tokens is preserved after reversal", () => {
    const input = "كلمة  أخرى";
    const prepared = preparePdfText(input);
    expect(prepared).toBe("أخرى  كلمة");
    expect(prepared).toContain("  ");
  });

  it("tab between tokens is preserved after reversal", () => {
    const input = "كلمة\tأخرى";
    const prepared = preparePdfText(input);
    expect(prepared).toBe("أخرى\tكلمة");
    expect(prepared).toContain("\t");
  });

  it("three words with tabs preserve whitespace positions", () => {
    const input = "أ\tب\tج";
    const prepared = preparePdfText(input);
    expect(prepared).toBe("ج\tب\tأ");
  });
});

// ---------------------------------------------------------------------------
// 9. preparePdfText — Arabic with parentheses
// ---------------------------------------------------------------------------

describe("preparePdfText — Arabic with parentheses", () => {
  it("parentheses remain attached to their content token", () => {
    const input = "منطقة الرياض (12 شكوى)";
    const prepared = preparePdfText(input);
    expect(prepared.indexOf("(12")).toBeGreaterThanOrEqual(0);
  });

  it("RTL reading reconstructs original", () => {
    const input = "منطقة الرياض (12 شكوى)";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 10. preparePdfText — LTR paragraph with embedded Arabic
// ---------------------------------------------------------------------------

describe("preparePdfText — LTR paragraph detection", () => {
  it("'SLA خلال 5 أيام': text starting with Latin returned unchanged (LTR paragraph)", () => {
    const input = "SLA خلال 5 أيام";
    expect(preparePdfText(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 11. preparePdfText — multi-line text
// ---------------------------------------------------------------------------

describe("preparePdfText — multi-line", () => {
  it("processes each \\n-delimited line independently", () => {
    const input = "الاستنتاجات\nالملاحظات";
    const prepared = preparePdfText(input);
    expect(prepared.split("\n")).toHaveLength(2);
  });

  it("LTR lines inside a multi-line string stay unchanged", () => {
    const input = "تقرير الشكاوى\nSLA report\n2026-01-01";
    const prepared = preparePdfText(input);
    const lines = prepared.split("\n");
    expect(lines[1]).toBe("SLA report");
    expect(lines[2]).toBe("2026-01-01");
  });

  it("each RTL line is independently reordered", () => {
    const line1 = "الفترة من 2026-01-01 إلى 2026-01-31";
    const line2 = "منطقة الرياض";
    const prepared = preparePdfText(`${line1}\n${line2}`);
    const [prep1, prep2] = prepared.split("\n");
    expect(readRtl(prep1!)).toBe(line1);
    expect(readRtl(prep2!)).toBe(line2);
  });
});

// ---------------------------------------------------------------------------
// 12. preparePdfText — edge cases
// ---------------------------------------------------------------------------

describe("preparePdfText — edge cases", () => {
  it("empty string returns empty string", () => {
    expect(preparePdfText("")).toBe("");
  });

  it("whitespace-only string returns unchanged", () => {
    expect(preparePdfText("   ")).toBe("   ");
  });

  it("does not strip diacritics", () => {
    const withDiacritics = "رَبُّكَ";
    expect(preparePdfText(withDiacritics)).toBe(withDiacritics);
  });

  it("does not strip Arabic punctuation", () => {
    const input = "التقرير؛ الشكاوى.";
    const prepared = preparePdfText(input);
    expect(prepared).toContain("؛");
    expect(prepared).toContain(".");
  });

  it("handles Arabic-Indic numerals inside Arabic text", () => {
    const input = "عدد الشكاوى ١٢";
    expect(preparePdfText(input)).toContain("١٢");
  });
});

// ---------------------------------------------------------------------------
// 13. preparePdfText — numbers are NOT individually character-reversed
// ---------------------------------------------------------------------------

describe("preparePdfText — number ordering", () => {
  it("2026-01-01 digits stay in LTR order", () => {
    const prepared = preparePdfText("من 2026-01-01");
    expect(prepared).toContain("2026-01-01");
    expect(prepared).not.toContain("10-10-6202");
  });

  it("100% stays as 100%", () => {
    const prepared = preparePdfText("نسبة 100%");
    expect(prepared).toContain("100%");
    expect(prepared).not.toContain("%001");
  });
});

// ---------------------------------------------------------------------------
// 14. preparePdfText — mixed conclusion/note sentences from actual data
// ---------------------------------------------------------------------------

describe("preparePdfText — real report sentences", () => {
  it("RTL reading of conclusion 1 is semantically correct", () => {
    const input = "منطقة الرياض الأعلى حجماً بعدد شكويين وتمثل 66.7% من الإجمالي.";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });

  it("RTL reading of conclusion 2 is semantically correct", () => {
    const input = "أعلى زيادة مطلقة في منطقة الرياض: شكويان.";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });

  it("page footer 'page X of Y' reconstructs correctly", () => {
    const input = "صفحة 1 من 4";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 15. preparePdfTextLines — alias works identically
// ---------------------------------------------------------------------------

describe("preparePdfTextLines", () => {
  it("produces the same output as preparePdfText", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    expect(preparePdfTextLines(input)).toBe(preparePdfText(input));
  });
});

// ---------------------------------------------------------------------------
// 16. preparePdfText — idempotency: double processing restores logical order
// ---------------------------------------------------------------------------

describe("preparePdfText — double processing", () => {
  it("applying preparePdfText twice restores the logical token order, so callers must not double-process", () => {
    // preparePdfText reverses token order for RTL display.
    // Calling it again reverses back to the original — which is the LOGICAL
    // (wrong-for-PDF) order.  Callers must call preparePdfText exactly once.
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    const once = preparePdfText(input);
    const twice = preparePdfText(once);
    expect(twice).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 17. drawPdfText — no double processing in the rendering wrapper
// ---------------------------------------------------------------------------

describe("drawPdfText — no double processing", () => {
  it("draws preparePdfText(input) exactly once — not preparePdfText(preparePdfText(input))", () => {
    const doc = makeTestDoc();
    const textSpy = vi.spyOn(doc, "text");

    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    const expectedDrawn = preparePdfText(input);
    drawPdfText(doc, input, 0, 0, { width: 500 });

    const drawnText = textSpy.mock.calls[0]?.[0] as string;
    // Must match single-pass preparation.
    expect(drawnText).toBe(expectedDrawn);
    // Must NOT match double-pass preparation (which would restore the original).
    expect(drawnText).not.toBe(preparePdfText(expectedDrawn));

    textSpy.mockRestore();
    doc.end();
  });
});

// ---------------------------------------------------------------------------
// 18. preparePdfTextLayout — wrapping splits long paragraphs correctly
// ---------------------------------------------------------------------------

describe("preparePdfTextLayout — long paragraph wrapping", () => {
  it("long RTL paragraph wraps into multiple lines at a narrow width", () => {
    const doc = makeTestDoc(12);
    const longText = "التقرير التنفيذي المقارن لتحليل اتجاهات الشكاوى في المناطق والإدارات خلال الفترة المحددة";
    const layout = preparePdfTextLayout(doc, longText, { width: 100 });
    expect(layout.lines.length).toBeGreaterThan(1);
    doc.end();
  });

  it("each wrapped line's visual text is the token-reversed form of its logical text", () => {
    const doc = makeTestDoc(12);
    const longText = "التقرير التنفيذي المقارن لتحليل اتجاهات الشكاوى في المناطق والإدارات خلال الفترة المحددة";
    const layout = preparePdfTextLayout(doc, longText, { width: 100 });
    for (const line of layout.lines) {
      const logTokens = line.logicalText.split(" ").filter(Boolean);
      const visTokens = line.visualText.split(" ").filter(Boolean);
      expect(visTokens).toEqual(logTokens.toReversed());
    }
    doc.end();
  });

  it("logical lines cover all words from the original paragraph without duplication", () => {
    const doc = makeTestDoc(12);
    const text = "التقرير التنفيذي المقارن لتحليل اتجاهات الشكاوى في المناطق والإدارات خلال الفترة المحددة";
    const layout = preparePdfTextLayout(doc, text, { width: 100 });
    const allLogicalWords = layout.lines.flatMap((l) => l.logicalText.split(" ").filter(Boolean));
    const originalWords = text.split(" ").filter(Boolean);
    expect(allLogicalWords).toEqual(originalWords);
    doc.end();
  });

  it("reading each visual line RTL (reversing its tokens) reconstructs logical order", () => {
    const doc = makeTestDoc(12);
    const text = "التقرير التنفيذي المقارن لتحليل اتجاهات الشكاوى في المناطق والإدارات خلال الفترة المحددة";
    const layout = preparePdfTextLayout(doc, text, { width: 100 });

    const readWords: string[] = [];
    for (const line of layout.lines) {
      // An Arabic reader scans the PDF from right to left, encountering tokens in
      // reverse order of their left-to-right placement.  That equals the reversed
      // order of visualText tokens = the original logical tokens for this line.
      const rtlTokens = line.visualText.split(" ").filter(Boolean).toReversed();
      readWords.push(...rtlTokens);
    }

    const originalWords = text.split(" ").filter(Boolean);
    expect(readWords).toEqual(originalWords);
    doc.end();
  });

  it("LTR paragraph is passed through as a single line without reversal", () => {
    const doc = makeTestDoc(12);
    const ltrText = "SLA performance report 2026";
    const layout = preparePdfTextLayout(doc, ltrText, { width: 50 });
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.visualText).toBe(ltrText);
    doc.end();
  });

  it("single Arabic word does not wrap and is returned unchanged", () => {
    const doc = makeTestDoc(12);
    const layout = preparePdfTextLayout(doc, "تقرير", { width: 500 });
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.visualText).toBe("تقرير");
    doc.end();
  });

  it("height equals lineHeight multiplied by number of lines", () => {
    const doc = makeTestDoc(12);
    const layout = preparePdfTextLayout(doc, "التقرير التنفيذي المقارن", { width: 50 });
    expect(layout.height).toBeCloseTo(layout.lineHeight * layout.lines.length, 5);
    doc.end();
  });

  it("\\n separates paragraphs and each is processed independently", () => {
    const doc = makeTestDoc(12);
    const text = "التقرير التنفيذي\nالملاحظات والاستنتاجات";
    const layout = preparePdfTextLayout(doc, text, { width: 500 });
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0]!.logicalText).toBe("التقرير التنفيذي");
    expect(layout.lines[1]!.logicalText).toBe("الملاحظات والاستنتاجات");
    doc.end();
  });
});
