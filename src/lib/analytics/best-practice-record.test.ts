import { describe, expect, it } from "vitest";
import { draftBestPracticeRecordFromCandidate } from "./best-practice-record";
import type { BestPracticeCandidateEvaluation } from "./best-practice-candidate";

function candidate(overrides: Partial<BestPracticeCandidateEvaluation> = {}): BestPracticeCandidateEvaluation {
  return {
    status: "BEST_PRACTICE_CANDIDATE",
    facility: "سجن الملز",
    classificationId: "cls-doctor-access",
    classificationLabel: "الوصول إلى الطبيب",
    startValue: 73,
    currentValue: 32,
    decrease: 41,
    streakPeriods: 4,
    changeRatePercent: -56.2,
    meritScore: 83,
    reasonLabel: "تحسن قوي ومستدام",
    sourceFindingId: "sustained_improvement:سجن الملز:c1:2026-07-01",
    ...overrides,
  };
}

describe("draftBestPracticeRecordFromCandidate", () => {
  it("only pre-fills fields the system can actually prove; every documentation field starts empty", () => {
    const draft = draftBestPracticeRecordFromCandidate(candidate());

    expect(draft.facilityName).toBe("سجن الملز");
    expect(draft.classificationLabel).toBe("الوصول إلى الطبيب");
    expect(draft.indicatorBefore).toBe(73);
    expect(draft.indicatorAfter).toBe(32);
    expect(draft.measurementPeriods).toBe(4);
    expect(draft.sourceFindingId).toBe("sustained_improvement:سجن الملز:c1:2026-07-01");

    // Nothing about the OPERATIONAL practice is claimed until a human documents it.
    expect(draft.title).toBeNull();
    expect(draft.actionDescription).toBeNull();
    expect(draft.appliedFromDate).toBeNull();
    expect(draft.documentedBy).toBeNull();
    expect(draft.evidence).toEqual([]);
    expect(draft.isGeneralizable).toBeNull();
    expect(draft.approvedAt).toBeNull();
    expect(draft.approvedBy).toBeNull();
  });

  it("always starts at verificationStatus CANDIDATE, never VERIFIED/APPROVED", () => {
    const draft = draftBestPracticeRecordFromCandidate(candidate());
    expect(draft.verificationStatus).toBe("CANDIDATE");
  });
});
