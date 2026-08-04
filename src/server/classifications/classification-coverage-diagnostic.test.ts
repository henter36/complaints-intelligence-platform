import { describe, expect, it } from "vitest";
import { analyzeClassificationCoverage } from "./classification-coverage-diagnostic";

function row(
  complaintId: string,
  normalizedData: unknown,
  validationWarnings: unknown,
  createdAt = new Date("2026-08-01T00:00:00.000Z")
) {
  return { complaintId, normalizedData, validationWarnings, createdAt };
}

describe("analyzeClassificationCoverage", () => {
  it("separates linked, text-only, matched-but-unlinked, ambiguous, unresolved, and missing cases", () => {
    const result = analyzeClassificationCoverage(
      [
        { id: "linked", classificationId: "cls_1", sourceDetail: "تفصيل" },
        { id: "matched", classificationId: null, sourceDetail: "تفصيل مطابق" },
        { id: "ambiguous", classificationId: null, sourceDetail: "تفصيل ملتبس" },
        { id: "text-only", classificationId: null, sourceDetail: null },
        { id: "unresolved", classificationId: null, sourceDetail: "قيمة غير معروفة" },
        { id: "missing", classificationId: null, sourceDetail: null },
      ],
      [
        row("matched", { classification: "تصنيف", sourceDetail: "تفصيل مطابق" }, [
          { code: "CLASSIFICATION_RESOLVED_FROM_SOURCE_DETAIL" },
        ]),
        row("ambiguous", { sourceDetail: "تفصيل ملتبس" }, [
          { code: "SOURCE_DETAIL_CLASSIFICATION_AMBIGUOUS" },
        ]),
        row("text-only", { classification: "تصنيف نصي" }, []),
        row("unresolved", { sourceDetail: "قيمة غير معروفة" }, []),
      ]
    );

    expect(result).toEqual({
      periodTotal: 6,
      classifiedById: 1,
      unclassifiedTotal: 5,
      classificationTextOnly: 2,
      withSourceDetail: 4,
      resolvedMatched: 1,
      resolvedMatchedButUnlinked: 1,
      resolvedAmbiguous: 1,
      unresolved: 2,
      missingClassificationInput: 1,
      classificationCoverageRate: 16.7,
    });
  });

  it("uses the latest import row for each complaint", () => {
    const result = analyzeClassificationCoverage(
      [{ id: "c1", classificationId: null, sourceDetail: null }],
      [
        row(
          "c1",
          { classification: "قديم" },
          [],
          new Date("2026-07-01T00:00:00.000Z")
        ),
        row(
          "c1",
          {},
          [],
          new Date("2026-08-01T00:00:00.000Z")
        ),
      ]
    );

    expect(result.classificationTextOnly).toBe(0);
    expect(result.missingClassificationInput).toBe(1);
  });

  it("returns zero coverage for an empty period", () => {
    expect(analyzeClassificationCoverage([], [])).toEqual({
      periodTotal: 0,
      classifiedById: 0,
      unclassifiedTotal: 0,
      classificationTextOnly: 0,
      withSourceDetail: 0,
      resolvedMatched: 0,
      resolvedMatchedButUnlinked: 0,
      resolvedAmbiguous: 0,
      unresolved: 0,
      missingClassificationInput: 0,
      classificationCoverageRate: 0,
    });
  });
});
