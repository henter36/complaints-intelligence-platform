import { describe, expect, it } from "vitest";
import {
  AUDIT_REASON_CODES,
  AUDIT_RESULTS,
  AUDIT_SKIP_REASONS,
  buildAuditTaxonomyIndex,
  computeComplaintStateHash,
  evaluateAuditApplyState,
  evaluateHistoricalClassification,
  type AuditComplaint,
  type AuditTaxonomyClassification,
} from "./historical-classification-audit-service";

const categoryGuidance = {
  id: "cat-guidance",
  nameAr: "التوجية والارشاد",
  isActive: true,
  isDeleted: false,
};

const categoryHealth = {
  id: "cat-health",
  nameAr: "الصحة",
  isActive: true,
  isDeleted: false,
};

function classification(
  id: string,
  nameAr: string,
  keywords: string[],
  category = categoryGuidance,
  overrides: Partial<AuditTaxonomyClassification> = {}
): AuditTaxonomyClassification {
  return {
    id,
    nameAr,
    keywords,
    isActive: true,
    isDeleted: false,
    category,
    ...overrides,
  };
}

const taxonomy = [
  classification("cls-dash", "-", []),
  classification("cls-quran", "القرآن والبرامج الدينية", ["أجزاء القرآن"]),
  classification("cls-supplies", "المستلزمات الدينية", ["سجادة صلاة"]),
  classification("cls-library", "المكتبة والقراءة", ["قلة الكتب في مكتبة السجن"]),
  classification(
    "cls-health",
    "الخدمات الصحية",
    ["دواء", "صرف العلاج", "صيدلية", "وصفة طبية"],
    categoryHealth
  ),
];

function complaint(overrides: Partial<AuditComplaint> = {}): AuditComplaint {
  return {
    id: "cmp-1",
    externalId: "external-1",
    sourceDetail: "أجزاء القرآن",
    subject: "طلب عام",
    description: "وصف عام",
    classificationId: "cls-dash",
    categoryId: "cat-guidance",
    classificationAssignmentSource: "LEGACY_UNKNOWN",
    classificationAssignedAt: null,
    classificationAssignedBy: null,
    classificationTaxonomyFingerprint: null,
    classificationAssignmentRunId: null,
    version: 4,
    updatedAt: new Date("2026-08-14T10:00:00.000Z"),
    isDeleted: false,
    ...overrides,
  };
}

describe("historical classification evidence", () => {
  it("corrects the known exact sourceDetail fixture from the wrong classification", () => {
    const decision = evaluateHistoricalClassification(complaint(), taxonomy);
    expect(decision).toMatchObject({
      result: AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE,
      reasonCode: AUDIT_REASON_CODES.EXACT_SOURCE_DETAIL_KEYWORD,
      confidence: 1,
      targetClassificationId: "cls-quran",
      targetCategoryId: "cat-guidance",
    });
  });

  it("keeps an already-supported current classification", () => {
    const decision = evaluateHistoricalClassification(
      complaint({ classificationId: "cls-quran" }),
      taxonomy
    );
    expect(decision.result).toBe(AUDIT_RESULTS.KEEP);
    expect(decision.reasonCode).toBe(AUDIT_REASON_CODES.CURRENT_CLASSIFICATION_ALREADY_SUPPORTED);
  });

  it("treats the same normalized keyword on multiple targets as ambiguous", () => {
    const ambiguousTaxonomy = [
      ...taxonomy,
      classification("cls-quran-2", "برامج دينية أخرى", ["أجزاء القرآن"]),
    ];
    expect(evaluateHistoricalClassification(complaint(), ambiguousTaxonomy).result).toBe(
      AUDIT_RESULTS.AMBIGUOUS
    );
  });

  it("uses multiple local subject and description phrases conservatively", () => {
    const decision = evaluateHistoricalClassification(
      complaint({
        sourceDetail: "طلب آخر",
        subject: "تأخر صرف العلاج من صيدلية السجن",
        description: "لم أستلم دواء بوصفة طبية وتعذر صرف العلاج من الصيدلية",
      }),
      taxonomy
    );
    expect(decision.result).toBe(AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE);
    expect(decision.targetClassificationId).toBe("cls-health");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("does not modify weak or generic text", () => {
    const decision = evaluateHistoricalClassification(
      complaint({ sourceDetail: null, subject: "طلب", description: "أرجو المساعدة" }),
      taxonomy
    );
    expect(decision.result).toBe(AUDIT_RESULTS.INSUFFICIENT_EVIDENCE);
  });

  it("reuses Arabic and whitespace normalization for exact matches", () => {
    const decision = evaluateHistoricalClassification(
      complaint({ sourceDetail: "  أَجــزَاء   القُرآن  " }),
      taxonomy
    );
    expect(decision.result).toBe(AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE);
    expect(decision.targetClassificationId).toBe("cls-quran");
  });

  it("never selects an inactive target", () => {
    const inactive = taxonomy.map((entry) =>
      entry.id === "cls-quran" ? { ...entry, isActive: false } : entry
    );
    const decision = evaluateHistoricalClassification(complaint(), inactive);
    expect(decision.result).not.toBe(AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE);
    expect(decision.targetClassificationId).not.toBe("cls-quran");
  });

  it("repairs a category mismatch when the classification is exactly supported", () => {
    const decision = evaluateHistoricalClassification(
      complaint({ classificationId: "cls-quran", categoryId: "cat-health" }),
      taxonomy
    );
    expect(decision).toMatchObject({
      result: AUDIT_RESULTS.CORRECT_HIGH_CONFIDENCE,
      reasonCode: AUDIT_REASON_CODES.CATEGORY_CLASSIFICATION_MISMATCH,
      targetCategoryId: "cat-guidance",
    });
  });

  it("keeps unclassified rows in the existing backfill workflow", () => {
    const decision = evaluateHistoricalClassification(
      complaint({ classificationId: null, categoryId: null }),
      taxonomy
    );
    expect(decision.result).toBe(AUDIT_RESULTS.KEEP);
  });
});

describe("apply concurrency decision", () => {
  it("skips a row whose version changed after preview", () => {
    const original = complaint();
    const item = {
      expectedVersion: original.version,
      previousClassificationId: original.classificationId,
      previousCategoryId: original.categoryId,
      complaintStateHash: computeComplaintStateHash(original),
      targetClassificationId: "cls-quran",
      targetCategoryId: "cat-guidance",
    };
    expect(
      evaluateAuditApplyState({
        complaint: { ...original, version: original.version + 1 },
        item,
        activeTargetCategoryId: "cat-guidance",
      })
    ).toEqual({ action: "SKIP", reason: AUDIT_SKIP_REASONS.VERSION_CHANGED });
  });

  it("rejects inactive and category-mismatched targets", () => {
    const original = complaint();
    const item = {
      expectedVersion: original.version,
      previousClassificationId: original.classificationId,
      previousCategoryId: original.categoryId,
      complaintStateHash: computeComplaintStateHash(original),
      targetClassificationId: "cls-quran",
      targetCategoryId: "cat-guidance",
    };
    expect(
      evaluateAuditApplyState({ complaint: original, item, activeTargetCategoryId: null })
    ).toEqual({ action: "SKIP", reason: AUDIT_SKIP_REASONS.TARGET_INACTIVE });
    expect(
      evaluateAuditApplyState({
        complaint: original,
        item,
        activeTargetCategoryId: "cat-health",
      })
    ).toEqual({
      action: "SKIP",
      reason: AUDIT_SKIP_REASONS.CATEGORY_CLASSIFICATION_MISMATCH,
    });
  });

  it("builds a reusable taxonomy index without changing evaluation", () => {
    const index = buildAuditTaxonomyIndex(taxonomy);
    expect(evaluateHistoricalClassification(complaint(), index).targetClassificationId).toBe(
      "cls-quran"
    );
  });
});
