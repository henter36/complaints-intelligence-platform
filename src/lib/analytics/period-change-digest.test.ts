import { describe, expect, it } from "vitest";
import { buildPeriodChangeDigest, type PatternSnapshot } from "./period-change-digest";

function snapshot(overrides: Partial<PatternSnapshot>): PatternSnapshot {
  return {
    key: "سجن X|التغذية",
    facility: "سجن X",
    classificationLabel: "التغذية",
    pattern: "CONTINUED_RISE",
    priorityBand: "MEDIUM",
    ...overrides,
  };
}

describe("buildPeriodChangeDigest", () => {
  it("reports a newly flagged problem", () => {
    const digest = buildPeriodChangeDigest([snapshot({})], []);
    expect(digest.newProblems).toHaveLength(1);
    expect(digest.continuingProblems).toHaveLength(0);
  });

  it("reports a continuing problem when it was already flagged", () => {
    const prior = snapshot({});
    const current = snapshot({});
    const digest = buildPeriodChangeDigest([current], [prior]);
    expect(digest.continuingProblems).toHaveLength(1);
    expect(digest.newProblems).toHaveLength(0);
  });

  it("reports a worsened problem when the priority band increased", () => {
    const prior = snapshot({ priorityBand: "MEDIUM" });
    const current = snapshot({ priorityBand: "HIGH" });
    const digest = buildPeriodChangeDigest([current], [prior]);
    expect(digest.worsenedProblems).toHaveLength(1);
    expect(digest.worsenedProblems[0]).toMatchObject({ from: "MEDIUM", to: "HIGH" });
  });

  it("reports a relapse only when the pattern newly became a relapse", () => {
    const prior = snapshot({ pattern: "SUSTAINED_IMPROVEMENT" });
    const current = snapshot({ pattern: "RELAPSE_AFTER_IMPROVEMENT" });
    const digest = buildPeriodChangeDigest([current], [prior]);
    expect(digest.relapsedProblems).toHaveLength(1);
  });

  it("reports a facility exiting the priority list", () => {
    const prior = snapshot({ priorityBand: "HIGH" });
    const digest = buildPeriodChangeDigest([], [prior]);
    expect(digest.exitedPriorityList).toHaveLength(1);
  });

  it("does not report a stable low-priority item as new", () => {
    const stable = snapshot({ pattern: "STABLE", priorityBand: "LOW" });
    const digest = buildPeriodChangeDigest([stable], []);
    expect(digest.newProblems).toHaveLength(0);
  });

  it("reports newly spreading classifications", () => {
    const digest = buildPeriodChangeDigest([], [], ["الرعاية الصحية"], []);
    expect(digest.newlySpreadingClassifications).toEqual(["الرعاية الصحية"]);
  });
});
