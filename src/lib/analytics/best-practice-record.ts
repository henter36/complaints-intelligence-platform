import type { BestPracticeCandidateEvaluation } from "./best-practice-candidate";

/**
 * Forward-looking contract for a future BestPractice table — NOT a Prisma
 * model yet (see the "no migration" note below). This is the architectural
 * foundation the report is not allowed to skip past: the report itself must
 * never assert a practice is "مثبتة" (verified), only ever generate a
 * CANDIDATE for a human to document and approve. Once a real workflow
 * (documentation form, approval screen) is built, a BestPractice Prisma
 * model can mirror these exact fields with an actual migration.
 *
 * CANDIDATE   — surfaced by the report engine; nothing has been documented yet.
 * VERIFIED    — a human has documented the actual operational action taken and evidence exists.
 * APPROVED    — verified AND cleared for generalization to other facilities.
 * REJECTED    — reviewed and found not to be a real/generalizable practice (e.g. a data artifact).
 */
export const BEST_PRACTICE_VERIFICATION_STATUSES = ["CANDIDATE", "VERIFIED", "APPROVED", "REJECTED"] as const;
export type BestPracticeVerificationStatus = (typeof BEST_PRACTICE_VERIFICATION_STATUSES)[number];

export type BestPracticeRecordDraft = {
  /** Facility.id (prisma/schema.prisma) once a real facility dimension table is joined; null while facilities are still name-keyed strings in the pattern-analysis engine. */
  facilityId: string | null;
  facilityName: string;
  /** Classification.id (prisma/schema.prisma); null when the finding was UNCLASSIFIED. */
  classificationId: string | null;
  classificationLabel: string;
  /** Human-authored once documented — the engine only ever proposes a neutral placeholder ("ممارسة مرشحة للدراسة"), never a specific action (spec item 6). */
  title: string | null;
  /** The actual operational action taken, in the facility's own words — null until a human documents it. */
  actionDescription: string | null;
  /** When the facility says the change was applied — null until documented. */
  appliedFromDate: string | null;
  /** The metric value before the change — sourced directly from the finding, never re-derived. */
  indicatorBefore: number;
  /** The metric value after the change — sourced directly from the finding, never re-derived. */
  indicatorAfter: number;
  /** How many periods the indicator was tracked over — sourced directly from the finding. */
  measurementPeriods: number;
  /** Who documented the practice — null until documented. */
  documentedBy: string | null;
  /** Attachment/reference ids or URLs supporting the claim — empty until documented. */
  evidence: string[];
  verificationStatus: BestPracticeVerificationStatus;
  approvedAt: string | null;
  approvedBy: string | null;
  /** Never true until a human has actually compared against other facilities' outcomes — the report itself only ever suggests the comparison (spec item 10), it never concludes generalizability. */
  isGeneralizable: boolean | null;
  notes: string | null;
  /** Traceability back to the AnalyticalFinding that produced this candidate. */
  sourceFindingId: string;
};

/**
 * Turns a report-level candidacy evaluation into an unsaved draft record —
 * the shape a future BestPractice table would persist once documentation
 * begins. Every documentation field starts null/empty; only the
 * data-verifiable fields (facility, classification, before/after, periods,
 * source finding) are pre-filled, because those are the only ones the
 * system itself can prove.
 */
export function draftBestPracticeRecordFromCandidate(
  candidate: BestPracticeCandidateEvaluation
): BestPracticeRecordDraft {
  return {
    facilityId: null,
    facilityName: candidate.facility,
    classificationId: null,
    classificationLabel: candidate.classificationLabel,
    title: null,
    actionDescription: null,
    appliedFromDate: null,
    indicatorBefore: candidate.startValue,
    indicatorAfter: candidate.currentValue,
    measurementPeriods: candidate.streakPeriods,
    documentedBy: null,
    evidence: [],
    verificationStatus: "CANDIDATE",
    approvedAt: null,
    approvedBy: null,
    isGeneralizable: null,
    notes: null,
    sourceFindingId: candidate.sourceFindingId,
  };
}
