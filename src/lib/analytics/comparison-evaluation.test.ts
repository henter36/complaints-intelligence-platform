import { describe, expect, it } from "vitest";
import { evaluateComparison } from "./comparison-evaluation";

describe("evaluateComparison", () => {
  it("returns unavailable when no comparison period exists", () => {
    expect(evaluateComparison(12, 7, false)).toEqual({
      current: 12,
      previous: null,
      difference: null,
      changeRate: null,
      state: "UNAVAILABLE",
      label: "غير متاح",
    });
  });

  it("returns new instead of a misleading 100% when previous is zero", () => {
    expect(evaluateComparison(8, 0, true)).toMatchObject({
      difference: 8,
      changeRate: null,
      state: "NEW",
      label: "جديد",
    });
  });

  it("returns no change when both values are zero", () => {
    expect(evaluateComparison(0, 0, true)).toMatchObject({
      difference: 0,
      changeRate: null,
      state: "NO_CHANGE",
      label: "لا تغير",
    });
  });

  it("calculates a real increase", () => {
    expect(evaluateComparison(15, 10, true)).toMatchObject({
      difference: 5,
      changeRate: 50,
      state: "INCREASE",
      label: "ارتفاع",
    });
  });

  it("calculates a full decrease", () => {
    expect(evaluateComparison(0, 10, true)).toMatchObject({
      difference: -10,
      changeRate: -100,
      state: "DECREASE",
      label: "انخفاض",
    });
  });

  it("rejects invalid negative counts", () => {
    expect(() => evaluateComparison(-1, 0, true)).toThrow(TypeError);
    expect(() => evaluateComparison(1, -1, true)).toThrow(TypeError);
  });
});
