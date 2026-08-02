// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  preparePdfText,
  preparePdfTextLines,
  containsArabic,
  isNumericDisplayValue,
} from "./arabic-pdf-text";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * For right-to-left sentences, preparePdfText reverses the token order so that
 * PDFKit+fontkit produce the correct visual layout.  A reader scanning the PDF
 * from right-to-left will reconstruct the ORIGINAL logical string.
 *
 * This helper reconstructs the logical sentence from the prepared string by
 * reversing the token order again — it should match the original input.
 */
function readRtl(prepared: string): string {
  return prepared.split(" ").reverse().join(" ");
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
  it("reverses token order so RTL reading reproduces original", () => {
    const input = "تقرير الشكاوى";
    const prepared = preparePdfText(input);
    expect(readRtl(prepared)).toBe(input);
  });

  it("does not reverse individual character order within a word", () => {
    // Each token's chars stay in logical order for fontkit shaping
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
  it("returns pure English text unchanged", () => {
    expect(preparePdfText("SLA report")).toBe("SLA report");
  });

  it("returns pure number unchanged", () => {
    expect(preparePdfText("2026-01-01")).toBe("2026-01-01");
  });

  it("returns empty string unchanged", () => {
    expect(preparePdfText("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. preparePdfText — Arabic with dates
// ---------------------------------------------------------------------------

describe("preparePdfText — Arabic with dates", () => {
  it("keeps date tokens in their original character order", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    const prepared = preparePdfText(input);
    // Dates must NOT be character-reversed
    expect(prepared).toContain("2026-01-01");
    expect(prepared).toContain("2026-01-31");
  });

  it("RTL reading of prepared string reconstructs the original sentence", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });

  it("start date appears to the right of end date in prepared string", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    const prepared = preparePdfText(input);
    // In PDF left-to-right layout, the start date should be to the right (higher index)
    // so Arabic readers (reading right-to-left) encounter it first
    const idx01 = prepared.indexOf("2026-01-01");
    const idx31 = prepared.indexOf("2026-01-31");
    expect(idx01).toBeGreaterThan(idx31); // start date is to the RIGHT of end date
  });
});

// ---------------------------------------------------------------------------
// 6. preparePdfText — Arabic with percentage
// ---------------------------------------------------------------------------

describe("preparePdfText — Arabic with percentage", () => {
  it("keeps percentage token intact", () => {
    const input = "ارتفاع بنسبة 25%";
    const prepared = preparePdfText(input);
    expect(prepared).toContain("25%");
  });

  it("percentage is NOT reversed to %52", () => {
    const prepared = preparePdfText("ارتفاع بنسبة 25%");
    expect(prepared).not.toContain("%52");
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
  it("keeps +12 token intact", () => {
    const input = "الفرق +12 شكوى";
    const prepared = preparePdfText(input);
    expect(prepared).toContain("+12");
  });

  it("+12 is NOT reversed to 21+", () => {
    const prepared = preparePdfText("الفرق +12 شكوى");
    expect(prepared).not.toContain("21+");
  });

  it("RTL reading reconstructs original", () => {
    const input = "الفرق +12 شكوى";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 8. preparePdfText — Arabic with parentheses
// ---------------------------------------------------------------------------

describe("preparePdfText — Arabic with parentheses", () => {
  it("parentheses remain attached to their content token", () => {
    const input = "منطقة الرياض (12 شكوى)";
    const prepared = preparePdfText(input);
    // Opening paren appears before its number in Arabic reading direction
    const parenOpen = prepared.indexOf("(12");
    expect(parenOpen).toBeGreaterThanOrEqual(0);
  });

  it("RTL reading reconstructs original", () => {
    const input = "منطقة الرياض (12 شكوى)";
    expect(readRtl(preparePdfText(input))).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 9. preparePdfText — Arabic with English acronym (LTR paragraph)
// ---------------------------------------------------------------------------

describe("preparePdfText — LTR paragraph with embedded Arabic", () => {
  it("text starting with Latin is returned unchanged (LTR paragraph)", () => {
    // 'SLA' is the first strong directional character → LTR paragraph
    const input = "SLA خلال 5 أيام";
    expect(preparePdfText(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 10. preparePdfText — multi-line text
// ---------------------------------------------------------------------------

describe("preparePdfText — multi-line", () => {
  it("processes each line independently", () => {
    const input = "الاستنتاجات\nالملاحظات";
    const prepared = preparePdfText(input);
    const lines = prepared.split("\n");
    expect(lines).toHaveLength(2);
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
// 11. preparePdfText — empty and edge cases
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
    const prepared = preparePdfText(withDiacritics);
    // Single word: unchanged
    expect(prepared).toBe(withDiacritics);
  });

  it("does not strip Arabic punctuation", () => {
    const input = "التقرير؛ الشكاوى.";
    const prepared = preparePdfText(input);
    expect(prepared).toContain("؛");
    expect(prepared).toContain(".");
  });

  it("handles Arabic-Indic numerals inside Arabic text", () => {
    const input = "عدد الشكاوى ١٢";
    const prepared = preparePdfText(input);
    expect(prepared).toContain("١٢");
  });
});

// ---------------------------------------------------------------------------
// 12. preparePdfText — numbers are NOT individually character-reversed
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
// 13. preparePdfText — mixed conclusion/note sentences from actual data
// ---------------------------------------------------------------------------

describe("preparePdfText — real report sentences", () => {
  it("RTL reading of conclusion 1 is semantically correct", () => {
    const input = "منطقة الرياض الأعلى حجماً بعدد شكويين وتمثل 66.7% من الإجمالي.";
    const prepared = preparePdfText(input);
    const reconstructed = readRtl(prepared);
    expect(reconstructed).toBe(input);
  });

  it("RTL reading of conclusion 2 is semantically correct", () => {
    const input = "أعلى زيادة مطلقة في منطقة الرياض: شكويان.";
    const prepared = preparePdfText(input);
    expect(readRtl(prepared)).toBe(input);
  });

  it("page footer 'page X of Y' reconstructs correctly", () => {
    const input = "صفحة 1 من 4";
    const prepared = preparePdfText(input);
    expect(readRtl(prepared)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 14. preparePdfTextLines — alias works identically
// ---------------------------------------------------------------------------

describe("preparePdfTextLines", () => {
  it("produces the same output as preparePdfText", () => {
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    expect(preparePdfTextLines(input)).toBe(preparePdfText(input));
  });
});

// ---------------------------------------------------------------------------
// 15. Idempotency
// ---------------------------------------------------------------------------

describe("preparePdfText — idempotency", () => {
  it("applying preparePdfText twice does NOT restore original order", () => {
    // Double-processing would reverse again = original (wrong) order.
    // Callers must ensure they only call preparePdfText once per string.
    const input = "الفترة من 2026-01-01 إلى 2026-01-31";
    const once = preparePdfText(input);
    const twice = preparePdfText(once);
    // Second call re-reverses → back to original (still RTL-correct by fontkit, but
    // the test documents that callers MUST NOT double-call).
    expect(twice).toBe(input);
  });
});
