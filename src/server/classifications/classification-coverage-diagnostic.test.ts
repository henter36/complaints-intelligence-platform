import { describe, expect, it } from "vitest";
import {
  analyzeClassificationCoverage,
  analyzeCurrentResolverCoverage,
} from "./classification-coverage-diagnostic";

function row(
  complaintId: string,
  normalizedData: unknown,
  validationWarnings: unknown,
  createdAt = new Date("2026-08-01T00:00:00.000Z")
) {
  return { complaintId, normalizedData, validationWarnings, createdAt };
}

const category = {
  id: "cat_1",
  nameAr: "فئة",
  isActive: true,
  isDeleted: false,
};

const classifications = [
  {
    id: "cls_1",
    nameAr: "تصنيف أول",
    keywords: ["تفصيل مطابق", "تفصيل متكرر"],
    isActive: true,
    isDeleted: false,
    category,
  },
  {
    id: "cls_2",
    nameAr: "تصنيف ثان",
    keywords: ["تفصيل ملتبس"],
    isActive: true,
    isDeleted: false,
    category,
  },
  {
    id: "cls_3",
    nameAr: "تصنيف ثالث",
    keywords: ["تفصيل ملتبس"],
    isActive: true,
    isDeleted: false,
    category,
  },
];

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

describe("analyzeCurrentResolverCoverage", () => {
  it("projects current matches without modifying complaints", () => {
    const result = analyzeCurrentResolverCoverage(
      [
        { id: "linked", classificationId: "cls_existing", sourceDetail: "تفصيل مطابق" },
        { id: "match-1", classificationId: null, sourceDetail: "تفصيل مطابق" },
        { id: "match-2", classificationId: null, sourceDetail: "تفصيل متكرر" },
        { id: "match-3", classificationId: null, sourceDetail: "تفصيل متكرر" },
        { id: "ambiguous", classificationId: null, sourceDetail: "تفصيل ملتبس" },
        { id: "unmatched", classificationId: null, sourceDetail: "قيمة غير معروفة" },
        { id: "missing", classificationId: null, sourceDetail: null },
      ],
      classifications
    );

    expect(result).toEqual({
      evaluatedUnclassifiedWithSourceDetail: 5,
      currentMatchedComplaints: 3,
      currentAmbiguousComplaints: 1,
      currentUnmatchedComplaints: 1,
      distinctSourceDetailValues: 4,
      currentMatchedDistinctValues: 2,
      currentAmbiguousDistinctValues: 1,
      currentUnmatchedDistinctValues: 1,
      projectedClassifiedById: 4,
      projectedClassificationCoverageRate: 57.1,
    });
  });

  it("returns an empty projection when there is no data", () => {
    expect(analyzeCurrentResolverCoverage([], classifications)).toEqual({
      evaluatedUnclassifiedWithSourceDetail: 0,
      currentMatchedComplaints: 0,
      currentAmbiguousComplaints: 0,
      currentUnmatchedComplaints: 0,
      distinctSourceDetailValues: 0,
      currentMatchedDistinctValues: 0,
      currentAmbiguousDistinctValues: 0,
      currentUnmatchedDistinctValues: 0,
      projectedClassifiedById: 0,
      projectedClassificationCoverageRate: 0,
    });
  });
});
