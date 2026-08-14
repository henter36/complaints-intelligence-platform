import { describe, expect, it } from "vitest";
import {
  AUTOMATION_PROTECTED_ASSIGNMENT_SOURCES,
  CLASSIFICATION_ASSIGNMENT_SOURCES,
  CLASSIFICATION_ASSIGNMENT_SOURCE_VALUES,
  buildClassificationAssignmentMetadata,
  buildManualClearClassificationMetadata,
  isAutomationProtectedAssignmentSource,
  isClassificationAssignmentSource,
  isManuallyProtectedUnclassified,
  resolveImportClassificationAssignmentSource,
  rowResolvedClassificationFromSourceDetail,
} from "./classification-assignment";
import { computeTaxonomyFingerprint } from "./taxonomy-fingerprint";

describe("classification assignment sources", () => {
  it("exposes the six governed assignment sources", () => {
    expect(CLASSIFICATION_ASSIGNMENT_SOURCE_VALUES).toEqual([
      "MANUAL",
      "IMPORT_EXPLICIT",
      "SOURCE_DETAIL_RULE",
      "HISTORICAL_BACKFILL",
      "HISTORICAL_CORRECTION",
      "LEGACY_UNKNOWN",
    ]);
    expect(isClassificationAssignmentSource("MANUAL")).toBe(true);
    expect(isClassificationAssignmentSource("OTHER")).toBe(false);
  });

  it("builds MANUAL metadata for manual classification", () => {
    const meta = buildClassificationAssignmentMetadata({
      source: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
      assignedBy: "admin",
      assignedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(meta.classificationAssignmentSource).toBe("MANUAL");
    expect(meta.classificationAssignedBy).toBe("admin");
    expect(meta.classificationTaxonomyFingerprint).toBeNull();
    expect(meta.classificationAssignmentRunId).toBeNull();
  });

  it("keeps cleared classification protected as MANUAL", () => {
    const meta = buildManualClearClassificationMetadata({ assignedBy: "admin" });
    expect(meta.classificationAssignmentSource).toBe("MANUAL");
    expect(
      isManuallyProtectedUnclassified({
        classificationId: null,
        classificationAssignmentSource: meta.classificationAssignmentSource,
      })
    ).toBe(true);
  });

  it("resolves IMPORT_EXPLICIT for explicit file classification", () => {
    expect(
      resolveImportClassificationAssignmentSource({
        hasClassification: true,
        resolvedFromSourceDetail: false,
      })
    ).toBe("IMPORT_EXPLICIT");
  });

  it("resolves SOURCE_DETAIL_RULE for derived classification", () => {
    expect(
      resolveImportClassificationAssignmentSource({
        hasClassification: true,
        resolvedFromSourceDetail: true,
      })
    ).toBe("SOURCE_DETAIL_RULE");
    expect(
      rowResolvedClassificationFromSourceDetail([
        { code: "CLASSIFICATION_RESOLVED_FROM_SOURCE_DETAIL" },
      ])
    ).toBe(true);
  });

  it("leaves metadata empty when no classification is present", () => {
    expect(
      resolveImportClassificationAssignmentSource({
        hasClassification: false,
        resolvedFromSourceDetail: false,
      })
    ).toBeNull();
  });

  it("protects manual, explicit, legacy, and historical corrections from automation", () => {
    expect(AUTOMATION_PROTECTED_ASSIGNMENT_SOURCES.has("MANUAL")).toBe(true);
    expect(isAutomationProtectedAssignmentSource("IMPORT_EXPLICIT")).toBe(true);
    expect(isAutomationProtectedAssignmentSource("LEGACY_UNKNOWN")).toBe(true);
    expect(isAutomationProtectedAssignmentSource("HISTORICAL_CORRECTION")).toBe(true);
    expect(isAutomationProtectedAssignmentSource("SOURCE_DETAIL_RULE")).toBe(false);
    expect(isAutomationProtectedAssignmentSource(null)).toBe(false);
  });

  it("stores fingerprint and run id for historical backfill", () => {
    const meta = buildClassificationAssignmentMetadata({
      source: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL,
      assignedBy: "system",
      taxonomyFingerprint: "abc",
      assignmentRunId: "run-1",
    });
    expect(meta.classificationTaxonomyFingerprint).toBe("abc");
    expect(meta.classificationAssignmentRunId).toBe("run-1");
  });

  it("stores a fingerprint but no backfill run id for historical correction", () => {
    const meta = buildClassificationAssignmentMetadata({
      source: CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_CORRECTION,
      assignedBy: "historical-classification-cleanup",
      taxonomyFingerprint: "taxonomy-fingerprint",
      assignmentRunId: "must-not-be-used",
    });
    expect(meta.classificationTaxonomyFingerprint).toBe("taxonomy-fingerprint");
    expect(meta.classificationAssignmentRunId).toBeNull();
    expect(isAutomationProtectedAssignmentSource(meta.classificationAssignmentSource)).toBe(true);
  });
});

describe("taxonomy fingerprint", () => {
  const base = [
    {
      id: "c2",
      nameAr: "ب",
      keywords: ["كلمة2"],
      isActive: true,
      isDeleted: false,
      category: { id: "cat1", nameAr: "فئة", isActive: true, isDeleted: false },
    },
    {
      id: "c1",
      nameAr: "أ",
      keywords: ["كلمة1", "كلمة0"],
      isActive: true,
      isDeleted: false,
      category: { id: "cat1", nameAr: "فئة", isActive: true, isDeleted: false },
    },
  ];

  it("is stable for the same taxonomy regardless of input order", () => {
    const a = computeTaxonomyFingerprint(base);
    const b = computeTaxonomyFingerprint([...base].reverse());
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when a keyword changes", () => {
    const before = computeTaxonomyFingerprint(base);
    const after = computeTaxonomyFingerprint([
      base[0]!,
      { ...base[1]!, keywords: ["كلمة1", "كلمة مختلفة"] },
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when classification moves to another category", () => {
    const before = computeTaxonomyFingerprint(base);
    const after = computeTaxonomyFingerprint([
      base[0]!,
      {
        ...base[1]!,
        category: { id: "cat2", nameAr: "فئة أخرى", isActive: true, isDeleted: false },
      },
    ]);
    expect(after).not.toBe(before);
  });
});
