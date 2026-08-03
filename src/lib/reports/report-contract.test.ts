// @vitest-environment node
//
// Unit tests for the shared report contract types and helpers.

import { describe, expect, it } from "vitest";
import {
  COMPARISON_MODES,
  REPORT_MODES,
  isComparisonMode,
  isReportMode,
} from "./report-contract";

describe("REPORT_MODES", () => {
  it("contains exactly 4 modes", () => {
    expect(REPORT_MODES).toHaveLength(4);
  });

  it("contains STANDARD", () => {
    expect(REPORT_MODES).toContain("STANDARD");
  });

  it("contains DIGITAL_EXECUTIVE_BRIEF", () => {
    expect(REPORT_MODES).toContain("DIGITAL_EXECUTIVE_BRIEF");
  });

  it("contains FULL_ANALYTICAL", () => {
    expect(REPORT_MODES).toContain("FULL_ANALYTICAL");
  });

  it("contains PRINT_EXECUTIVE_BRIEF", () => {
    expect(REPORT_MODES).toContain("PRINT_EXECUTIVE_BRIEF");
  });

  it("modes are unique", () => {
    expect(new Set(REPORT_MODES).size).toBe(REPORT_MODES.length);
  });
});

describe("isReportMode", () => {
  it("returns true for STANDARD", () => {
    expect(isReportMode("STANDARD")).toBe(true);
  });
  it("returns true for DIGITAL_EXECUTIVE_BRIEF", () => {
    expect(isReportMode("DIGITAL_EXECUTIVE_BRIEF")).toBe(true);
  });

  it("returns true for FULL_ANALYTICAL", () => {
    expect(isReportMode("FULL_ANALYTICAL")).toBe(true);
  });

  it("returns true for PRINT_EXECUTIVE_BRIEF", () => {
    expect(isReportMode("PRINT_EXECUTIVE_BRIEF")).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isReportMode("")).toBe(false);
  });

  it("returns false for an unknown mode string", () => {
    expect(isReportMode("EXECUTIVE_SUMMARY")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isReportMode(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isReportMode(undefined)).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isReportMode(42)).toBe(false);
  });

  it("returns false for an object", () => {
    expect(isReportMode({})).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isReportMode("digital_executive_brief")).toBe(false);
    expect(isReportMode("DIGITAL_executive_BRIEF")).toBe(false);
  });
});

describe("comparison modes", () => {
  it("contains the two temporal comparison strategies", () => {
    expect(COMPARISON_MODES).toEqual([
      "PREVIOUS_EQUIVALENT_PERIOD",
      "SAME_PERIOD_LAST_YEAR",
    ]);
  });

  it("accepts only supported temporal comparison modes", () => {
    expect(isComparisonMode("PREVIOUS_EQUIVALENT_PERIOD")).toBe(true);
    expect(isComparisonMode("SAME_PERIOD_LAST_YEAR")).toBe(true);
    expect(isComparisonMode("IMPORT_BATCH")).toBe(false);
  });
});
