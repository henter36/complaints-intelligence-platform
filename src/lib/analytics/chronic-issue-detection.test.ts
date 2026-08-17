import { describe, expect, it } from "vitest";
import { evaluateChronicIssue } from "./chronic-issue-detection";
import { classifyTrend } from "./multi-period-trend";

describe("evaluateChronicIssue", () => {
  it("classifies a long-running elevated issue as chronic with an explainable reason", () => {
    const trend = classifyTrend([8, 9, 8, 9, 10]);
    const result = evaluateChronicIssue({
      trend,
      repeatRatePercent: 18,
      distinctComplainants: 8,
      concentrationDeltaPercent: 20,
    });
    expect(result.isChronic).toBe(true);
    expect(result.explanation).toContain("مشكلة مزمنة بسبب");
    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("does not classify a short-lived rise with no repetition or concentration as chronic", () => {
    const trend = classifyTrend([2, 3, 8]); // below minPeriodsForChronic, no supporting signal
    const result = evaluateChronicIssue({
      trend,
      repeatRatePercent: 0,
      distinctComplainants: 0,
      concentrationDeltaPercent: 0,
    });
    expect(result.isChronic).toBe(false);
  });

  it("does not classify an improving trend as chronic even with high volume", () => {
    const trend = classifyTrend([40, 30, 20, 15]);
    const result = evaluateChronicIssue({
      trend,
      repeatRatePercent: 50,
      distinctComplainants: 20,
      concentrationDeltaPercent: 40,
    });
    expect(result.isChronic).toBe(false);
  });

  it("allows a shorter streak to qualify as chronic when repetition is high", () => {
    const trend = classifyTrend([8, 9, 8]); // exactly minPeriodsForContinuity
    const result = evaluateChronicIssue({
      trend,
      repeatRatePercent: 25,
      distinctComplainants: 5,
      concentrationDeltaPercent: 0,
    });
    expect(result.isChronic).toBe(true);
    expect(result.reasons.some((r) => r.includes("تكرار"))).toBe(true);
  });
});
