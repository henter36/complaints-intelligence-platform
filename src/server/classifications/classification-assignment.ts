/**
 * Central policy for how Complaint.classificationId was assigned.
 * Application-level string constants (SQLite-friendly; not a Prisma enum).
 */

export const CLASSIFICATION_ASSIGNMENT_SOURCES = {
  MANUAL: "MANUAL",
  IMPORT_EXPLICIT: "IMPORT_EXPLICIT",
  SOURCE_DETAIL_RULE: "SOURCE_DETAIL_RULE",
  HISTORICAL_BACKFILL: "HISTORICAL_BACKFILL",
  LEGACY_UNKNOWN: "LEGACY_UNKNOWN",
} as const;

export type ClassificationAssignmentSource =
  (typeof CLASSIFICATION_ASSIGNMENT_SOURCES)[keyof typeof CLASSIFICATION_ASSIGNMENT_SOURCES];

export const CLASSIFICATION_ASSIGNMENT_SOURCE_VALUES = Object.values(
  CLASSIFICATION_ASSIGNMENT_SOURCES
) as ClassificationAssignmentSource[];

export function isClassificationAssignmentSource(
  value: unknown
): value is ClassificationAssignmentSource {
  return (
    typeof value === "string" &&
    (CLASSIFICATION_ASSIGNMENT_SOURCE_VALUES as string[]).includes(value)
  );
}

/** Sources that must never be overwritten by automated classification. */
export const AUTOMATION_PROTECTED_ASSIGNMENT_SOURCES: ReadonlySet<ClassificationAssignmentSource> =
  new Set([
    CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
    CLASSIFICATION_ASSIGNMENT_SOURCES.IMPORT_EXPLICIT,
    CLASSIFICATION_ASSIGNMENT_SOURCES.LEGACY_UNKNOWN,
  ]);

export function isAutomationProtectedAssignmentSource(
  source: string | null | undefined
): boolean {
  if (!source) return false;
  return AUTOMATION_PROTECTED_ASSIGNMENT_SOURCES.has(
    source as ClassificationAssignmentSource
  );
}

/**
 * Complaints with MANUAL and null classificationId were intentionally cleared
 * or left unclassified — never auto-classify them.
 */
export function isManuallyProtectedUnclassified(input: {
  classificationId: string | null | undefined;
  classificationAssignmentSource: string | null | undefined;
}): boolean {
  return (
    input.classificationId == null &&
    input.classificationAssignmentSource === CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL
  );
}

export type ClassificationAssignmentMetadata = {
  classificationAssignmentSource: ClassificationAssignmentSource | null;
  classificationAssignedAt: Date | null;
  classificationAssignedBy: string | null;
  classificationTaxonomyFingerprint: string | null;
  classificationAssignmentRunId: string | null;
};

export type BuildClassificationAssignmentInput = {
  source: ClassificationAssignmentSource;
  assignedAt?: Date;
  assignedBy: string;
  taxonomyFingerprint?: string | null;
  assignmentRunId?: string | null;
};

/**
 * Build assignment metadata for a classification write.
 * Automated sources (SOURCE_DETAIL_RULE, HISTORICAL_BACKFILL) should pass taxonomyFingerprint.
 * HISTORICAL_BACKFILL should pass assignmentRunId.
 */
export function buildClassificationAssignmentMetadata(
  input: BuildClassificationAssignmentInput
): ClassificationAssignmentMetadata {
  const assignedAt = input.assignedAt ?? new Date();
  const needsFingerprint =
    input.source === CLASSIFICATION_ASSIGNMENT_SOURCES.SOURCE_DETAIL_RULE ||
    input.source === CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL;

  return {
    classificationAssignmentSource: input.source,
    classificationAssignedAt: assignedAt,
    classificationAssignedBy: input.assignedBy,
    classificationTaxonomyFingerprint: needsFingerprint
      ? (input.taxonomyFingerprint ?? null)
      : null,
    classificationAssignmentRunId:
      input.source === CLASSIFICATION_ASSIGNMENT_SOURCES.HISTORICAL_BACKFILL
        ? (input.assignmentRunId ?? null)
        : null,
  };
}

/** Manual clear: keep MANUAL source with null classificationId. */
export function buildManualClearClassificationMetadata(input: {
  assignedBy: string;
  assignedAt?: Date;
}): ClassificationAssignmentMetadata {
  return buildClassificationAssignmentMetadata({
    source: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
    assignedAt: input.assignedAt,
    assignedBy: input.assignedBy,
  });
}

export function resolveImportClassificationAssignmentSource(input: {
  hasClassification: boolean;
  resolvedFromSourceDetail: boolean;
}): ClassificationAssignmentSource | null {
  if (!input.hasClassification) return null;
  if (input.resolvedFromSourceDetail) {
    return CLASSIFICATION_ASSIGNMENT_SOURCES.SOURCE_DETAIL_RULE;
  }
  return CLASSIFICATION_ASSIGNMENT_SOURCES.IMPORT_EXPLICIT;
}

export function rowResolvedClassificationFromSourceDetail(
  validationWarnings: unknown
): boolean {
  if (!Array.isArray(validationWarnings)) return false;
  return validationWarnings.some(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      "code" in entry &&
      (entry as { code?: unknown }).code === "CLASSIFICATION_RESOLVED_FROM_SOURCE_DETAIL"
  );
}

/**
 * Persist main + sub classification together.
 * Never write classificationId without the matching categoryId.
 */
export function buildLinkedClassificationIds(input: {
  classificationId: string;
  categoryId: string;
}): { classificationId: string; categoryId: string } {
  if (!input.classificationId || !input.categoryId) {
    throw new Error("CATEGORY_CLASSIFICATION_MISMATCH");
  }
  return {
    classificationId: input.classificationId,
    categoryId: input.categoryId,
  };
}

export function assertClassificationBelongsToCategory(input: {
  classificationCategoryId: string;
  targetCategoryId: string;
}): void {
  if (input.classificationCategoryId !== input.targetCategoryId) {
    throw new Error("CATEGORY_CLASSIFICATION_MISMATCH");
  }
}
