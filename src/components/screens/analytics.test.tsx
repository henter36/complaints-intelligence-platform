import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  getComparisonStateClassName,
  formatComparisonDifference,
} from "./analytics";

describe("getComparisonStateClassName", () => {
  it("returns red class for INCREASE", () => {
    expect(getComparisonStateClassName("INCREASE")).toBe("text-red-600");
  });

  it("returns green class for DECREASE", () => {
    expect(getComparisonStateClassName("DECREASE")).toBe("text-emerald-600");
  });

  it("returns muted class for NEW", () => {
    expect(getComparisonStateClassName("NEW")).toBe("text-muted-foreground");
  });

  it("returns muted class for NO_CHANGE", () => {
    expect(getComparisonStateClassName("NO_CHANGE")).toBe("text-muted-foreground");
  });
});

describe("formatComparisonDifference", () => {
  it("returns em dash for null difference", () => {
    expect(formatComparisonDifference(null)).toBe("—");
  });

  it("prepends + for positive difference", () => {
    expect(formatComparisonDifference(5)).toContain("+");
  });

  it("does not prepend + for negative difference", () => {
    expect(formatComparisonDifference(-3)).not.toContain("+");
  });

  it("does not prepend + for zero difference", () => {
    expect(formatComparisonDifference(0)).not.toContain("+");
  });
});

describe("analytics screen exports do not crash on import", () => {
  it("module exports are defined functions", () => {
    expect(typeof getComparisonStateClassName).toBe("function");
    expect(typeof formatComparisonDifference).toBe("function");
  });
});
