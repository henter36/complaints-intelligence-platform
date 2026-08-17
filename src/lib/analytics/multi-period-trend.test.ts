import { describe, expect, it } from "vitest";
import { classifyTrend, isNegativeTrend } from "./multi-period-trend";
import { PATTERN_ANALYSIS_CONFIG } from "./pattern-analysis-config";

const config = PATTERN_ANALYSIS_CONFIG;

describe("classifyTrend", () => {
  it("returns INSUFFICIENT_DATA below the minimum period window", () => {
    const result = classifyTrend([10, 12]);
    expect(result.pattern).toBe("INSUFFICIENT_DATA");
  });

  it("detects a continued rise that stays elevated without a clear improvement", () => {
    const result = classifyTrend([8, 9, 8, 9]);
    expect(result.pattern).toBe("CONTINUED_RISE");
    expect(result.streakPeriods).toBe(4);
  });

  it("detects escalating (monotonic, material overall rise)", () => {
    const result = classifyTrend([5, 8, 12, 18]);
    expect(result.pattern).toBe("ESCALATING");
  });

  it("detects sustained improvement across multiple periods, never a single-period drop", () => {
    const singleDrop = classifyTrend([10, 10, 10, 6]);
    expect(singleDrop.pattern).not.toBe("SUSTAINED_IMPROVEMENT");

    const sustained = classifyTrend([20, 15, 10, 8]);
    expect(sustained.pattern).toBe("SUSTAINED_IMPROVEMENT");
    expect(sustained.streakPeriods).toBeGreaterThanOrEqual(config.minSustainedImprovementPeriods);
  });

  it("detects relapse after a real prior improvement", () => {
    const result = classifyTrend([30, 20, 10, 24]);
    expect(result.pattern).toBe("RELAPSE_AFTER_IMPROVEMENT");
    expect(result.priorImprovementPeriods).toBeGreaterThan(0);
  });

  it("does not call a small absolute jump a relapse", () => {
    // Drops to near-zero then a tiny absolute bump — no material rebound.
    const result = classifyTrend([1, 1, 0, 1]);
    expect(result.pattern).not.toBe("RELAPSE_AFTER_IMPROVEMENT");
  });

  it("detects an emerging issue that was essentially absent before", () => {
    const result = classifyTrend([0, 0, 1, 9]);
    expect(result.pattern).toBe("EMERGING");
  });

  it("detects a volatile pattern that never settles", () => {
    // Repeatedly crosses the signal threshold instead of settling high or low.
    const result = classifyTrend([8, 2, 9, 1, 8, 2]);
    expect(result.pattern).toBe("VOLATILE");
  });

  it("does not mistake ongoing oscillation for a clean relapse", () => {
    const result = classifyTrend([6, 12, 5, 11, 6, 12]);
    expect(result.pattern).not.toBe("RELAPSE_AFTER_IMPROVEMENT");
  });

  it("treats consistently low counts as stable", () => {
    const result = classifyTrend([1, 0, 1, 0]);
    expect(result.pattern).toBe("STABLE");
  });

  it("produces an Arabic duration label for the classified pattern", () => {
    const result = classifyTrend([8, 9, 8, 9]);
    expect(result.durationLabel).toContain("فترات");
  });

  it("flags the correct patterns as negative / needing follow-up", () => {
    expect(isNegativeTrend("CONTINUED_RISE")).toBe(true);
    expect(isNegativeTrend("SUSTAINED_IMPROVEMENT")).toBe(false);
    expect(isNegativeTrend("STABLE")).toBe(false);
  });
});
