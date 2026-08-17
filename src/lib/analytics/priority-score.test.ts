import { describe, expect, it } from "vitest";
import { computePriorityScore, type PriorityScoreInput } from "./priority-score";

const baseInput: PriorityScoreInput = {
  currentValue: 2,
  changeRatePercent: 200,
  hasSufficientVolume: false,
  streakPeriods: 1,
  windowPeriods: 6,
  repeatRatePercent: 0,
  distinctComplainants: 0,
  concentrationDeltaPercent: 0,
  affectedClassificationsCount: 0,
  isRelapse: false,
  crossFacilityAffectedCount: 0,
};

describe("computePriorityScore", () => {
  it("does not let a misleading percentage from a tiny sample dominate the score", () => {
    // 1 -> 3 is +200% but currentValue is far below the signal threshold.
    const result = computePriorityScore(baseInput);
    expect(result.score).toBeLessThan(20);
    expect(result.band).toBe("LOW");
  });

  it("scores high when volume, streak, repetition and concentration all align", () => {
    const result = computePriorityScore({
      currentValue: 46,
      changeRatePercent: 40,
      hasSufficientVolume: true,
      streakPeriods: 5,
      windowPeriods: 6,
      repeatRatePercent: 30,
      distinctComplainants: 15,
      concentrationDeltaPercent: 20,
      affectedClassificationsCount: 3,
      isRelapse: true,
      crossFacilityAffectedCount: 4,
    });
    expect(result.band).toBe("HIGH");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("always explains a non-trivial score instead of returning a bare number", () => {
    const result = computePriorityScore({
      ...baseInput,
      currentValue: 30,
      hasSufficientVolume: true,
      streakPeriods: 5,
      repeatRatePercent: 25,
    });
    expect(result.reasons.some((r) => r.includes("استمرار"))).toBe(true);
  });

  it("stays within 0-100 bounds", () => {
    const result = computePriorityScore({
      currentValue: 1000,
      changeRatePercent: 500,
      hasSufficientVolume: true,
      streakPeriods: 20,
      windowPeriods: 6,
      repeatRatePercent: 100,
      distinctComplainants: 500,
      concentrationDeltaPercent: 100,
      affectedClassificationsCount: 20,
      isRelapse: true,
      crossFacilityAffectedCount: 50,
    });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
