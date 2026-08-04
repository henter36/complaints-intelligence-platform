import { describe, expect, it } from "vitest";
import { normalizeClassificationKeyword } from "./classification-keyword-normalizer";

describe("normalizeClassificationKeyword", () => {
  it("strips tashkeel and tatweel", () => {
    expect(normalizeClassificationKeyword("المُــعَـرَّف")).toBe("المعرف");
  });

  it("normalizes hamza variants, alif maqsura, and ta marbuta", () => {
    expect(normalizeClassificationKeyword("إجراءات")).toBe("اجراءات");
    expect(normalizeClassificationKeyword("مستشفى")).toBe("مستشفي");
    expect(normalizeClassificationKeyword("وكالة")).toBe("وكاله");
  });

  it("collapses whitespace and lowercases with ar-SA", () => {
    expect(normalizeClassificationKeyword("  طلب   علاج  ")).toBe("طلب علاج");
  });

  it("treats display variants of the same Arabic word as equal", () => {
    expect(normalizeClassificationKeyword("وكالة")).toBe(
      normalizeClassificationKeyword("وكاله")
    );
    expect(normalizeClassificationKeyword("إجراء")).toBe(
      normalizeClassificationKeyword("اجراء")
    );
  });
});
