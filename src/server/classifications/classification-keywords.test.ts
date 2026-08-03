import { describe, expect, it } from "vitest";
import { parseClassificationKeywords } from "./classification-keywords";

describe("parseClassificationKeywords", () => {
  it("returns empty array for null", () => {
    expect(parseClassificationKeywords(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(parseClassificationKeywords(undefined)).toEqual([]);
  });

  it("returns trimmed strings from a valid array", () => {
    expect(parseClassificationKeywords(["طلب نقل", " موعد طبي "])).toEqual(["طلب نقل", "موعد طبي"]);
  });

  it("excludes blank strings after trim", () => {
    expect(parseClassificationKeywords(["رعاية", "  ", "", "صحة"])).toEqual(["رعاية", "صحة"]);
  });

  it("throws for a plain object", () => {
    expect(() => parseClassificationKeywords({ keyword: "رعاية" })).toThrow();
  });

  it("throws for a number", () => {
    expect(() => parseClassificationKeywords(42)).toThrow();
  });

  it("throws for a boolean", () => {
    expect(() => parseClassificationKeywords(true)).toThrow();
  });

  it("throws for an array containing a non-string element", () => {
    expect(() => parseClassificationKeywords(["valid", 123])).toThrow();
  });

  it("throws for an array containing null", () => {
    expect(() => parseClassificationKeywords(["valid", null])).toThrow();
  });
});
