import { describe, expect, it } from "vitest";
import {
  countComplaintsByIdentifier,
  isRepeatedComplainantIdentifier,
  normalizeComplainantIdentifier,
} from "./repeated-complaint-identifier";

describe("normalizeComplainantIdentifier", () => {
  it.each([
    [" ١٠٩٠٠٣٠٠٣٠ ", "1090030030"],
    ["۱۰۹۰۰۳۰۰۳۰", "1090030030"],
    ["109 003 0030", "1090030030"],
    ["000123", "000123"],
  ])("normalizes %s without removing leading zeros", (input, expected) => {
    expect(normalizeComplainantIdentifier(input)).toBe(expected);
  });

  it("returns undefined for missing values", () => {
    expect(normalizeComplainantIdentifier(undefined)).toBeUndefined();
    expect(normalizeComplainantIdentifier(null)).toBeUndefined();
    expect(normalizeComplainantIdentifier("   ")).toBeUndefined();
  });
});

describe("repeated complainant identifier calculation", () => {
  it("counts normalized identifiers and ignores empty values", () => {
    const counts = countComplaintsByIdentifier([
      "1090030030",
      " ١٠٩٠٠٣٠٠٣٠ ",
      "000123",
      "",
      null,
    ]);

    expect(counts.get("1090030030")).toBe(2);
    expect(counts.get("000123")).toBe(1);
    expect(counts.size).toBe(2);
  });

  it("marks only identifiers with more than one active complaint as repeated", () => {
    const counts = countComplaintsByIdentifier([
      "1090030030",
      "1090030030",
      "000123",
    ]);

    expect(isRepeatedComplainantIdentifier("١٠٩٠٠٣٠٠٣٠", counts)).toBe(true);
    expect(isRepeatedComplainantIdentifier("000123", counts)).toBe(false);
    expect(isRepeatedComplainantIdentifier(undefined, counts)).toBe(false);
  });
});
