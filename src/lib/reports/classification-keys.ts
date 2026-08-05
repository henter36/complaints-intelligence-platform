/** Internal sentinel for complaints with no classificationId. Never use as a display label. */
export const UNCLASSIFIED_CLASSIFICATION_KEY = "__unclassified__";

/** Arabic display label for the unclassified bucket. */
export const UNCLASSIFIED_CLASSIFICATION_LABEL = "غير مصنف";

export function classificationKey(classificationId: string | null | undefined): string {
  return classificationId?.trim() ? classificationId : UNCLASSIFIED_CLASSIFICATION_KEY;
}

/** Display label for a classification bucket. Prefer nameAr; fall back to Arabic unclassified. */
export function classificationDisplayName(
  nameAr: string | null | undefined
): string {
  return nameAr?.trim() || UNCLASSIFIED_CLASSIFICATION_LABEL;
}
