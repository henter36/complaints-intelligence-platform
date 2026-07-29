import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  priorityBadgeClass,
  statusBadgeClass,
} from "./ar-utils";

describe("Arabic formatting utilities", () => {
  it("formats numbers and percentages with Arabic locale digits", () => {
    expect(formatNumber(1234)).toContain("١");
    expect(formatPercent(12.5)).toContain("٪");
  });

  it("formats dates using the Gregorian Arabic Saudi locale", () => {
    expect(formatDate(new Date("2024-10-15T00:00:00.000Z"))).toContain("٢٠٢٤");
  });

  it("formats durations in minutes, hours, and days", () => {
    expect(formatDuration(0.5)).toBe("30 دقيقة");
    expect(formatDuration(2.25)).toBe("2.3 ساعة");
    expect(formatDuration(48)).toBe("2 يوم");
  });

  it("falls back to known badge classes for unknown status and priority", () => {
    expect(statusBadgeClass("unknown")).toBe(statusBadgeClass("open"));
    expect(priorityBadgeClass("unknown")).toBe(priorityBadgeClass("medium"));
  });
});
