/** Internal sentinel for complaints with no classificationId. Never use as a display label. */
export const UNCLASSIFIED_CLASSIFICATION_KEY = "__unclassified__";

/** Arabic display label for the unclassified bucket. */
export const UNCLASSIFIED_CLASSIFICATION_LABEL = "غير مصنف";

export function classificationKey(classificationId: string | null | undefined): string {
  return classificationId?.trim() ? classificationId : UNCLASSIFIED_CLASSIFICATION_KEY;
}

/** Display label for a classification leaf name. Prefer nameAr; fall back to Arabic unclassified. */
export function classificationDisplayName(
  nameAr: string | null | undefined
): string {
  return nameAr?.trim() || UNCLASSIFIED_CLASSIFICATION_LABEL;
}

/**
 * Full display path: Category (main) / Classification (sub).
 * When names are equal (legacy), show a single name to avoid "X / X".
 */
export function buildClassificationPath(
  categoryName: string | null | undefined,
  classificationName: string | null | undefined
): string {
  const category = categoryName?.trim() ?? "";
  const classification = classificationName?.trim() ?? "";
  if (!classification && !category) return UNCLASSIFIED_CLASSIFICATION_LABEL;
  if (!classification) return category || UNCLASSIFIED_CLASSIFICATION_LABEL;
  if (!category) return classification;
  if (category === classification) return classification;
  return `${category} / ${classification}`;
}
