import { describe, expect, it } from "vitest";
import { parsePositiveIntegerParam } from "./query-params";

describe("parsePositiveIntegerParam", () => {
  it("returns the fallback for missing/blank input", () => {
    expect(parsePositiveIntegerParam(null)).toBeUndefined();
    expect(parsePositiveIntegerParam(undefined)).toBeUndefined();
    expect(parsePositiveIntegerParam("")).toBeUndefined();
    expect(parsePositiveIntegerParam("   ")).toBeUndefined();
    expect(parsePositiveIntegerParam(null, { fallback: 25 })).toBe(25);
  });

  it("rejects NaN-producing garbage instead of propagating NaN", () => {
    expect(parsePositiveIntegerParam("abc")).toBeUndefined();
    expect(parsePositiveIntegerParam("NaN")).toBeUndefined();
    expect(parsePositiveIntegerParam("12abc")).toBeUndefined();
  });

  it("rejects Infinity", () => {
    expect(parsePositiveIntegerParam("Infinity")).toBeUndefined();
    expect(parsePositiveIntegerParam("-Infinity")).toBeUndefined();
  });

  it("rejects negative numbers and zero when min is the default (1)", () => {
    expect(parsePositiveIntegerParam("-1")).toBeUndefined();
    expect(parsePositiveIntegerParam("0")).toBeUndefined();
  });

  it("allows zero when the caller explicitly lowers min to 0", () => {
    expect(parsePositiveIntegerParam("0", { min: 0 })).toBe(0);
  });

  it("rejects fractions", () => {
    expect(parsePositiveIntegerParam("2.5")).toBeUndefined();
    expect(parsePositiveIntegerParam("1.0")).toBe(1); // 1.0 IS integer-valued
  });

  it("clamps values above max down to max, never rejecting them", () => {
    expect(parsePositiveIntegerParam("999999", { max: 100 })).toBe(100);
  });

  it("returns the parsed integer when it is well-formed and in range", () => {
    expect(parsePositiveIntegerParam("42")).toBe(42);
    expect(parsePositiveIntegerParam("2", { min: 2 })).toBe(2);
  });

  it("never returns NaN or Infinity for any input", () => {
    for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "-1", "0", "2.5", "", "   ", "999999999999999999999"]) {
      const result = parsePositiveIntegerParam(raw, { max: 1000 });
      if (result !== undefined) {
        expect(Number.isFinite(result)).toBe(true);
      }
    }
  });
});
