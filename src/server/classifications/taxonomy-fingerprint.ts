import { createHash } from "node:crypto";
import { parseClassificationKeywords } from "./classification-keywords";
import { normalizeSourceDetailClassificationValue } from "./source-detail-classification-resolver";

export type TaxonomyFingerprintClassification = {
  id: string;
  nameAr: string;
  keywords: unknown;
  isActive: boolean;
  isDeleted: boolean;
  category: {
    id: string;
    nameAr: string;
    isActive: boolean;
    isDeleted: boolean;
  };
};

export type TaxonomyFingerprintEntry = {
  classificationId: string;
  classificationName: string;
  categoryId: string;
  categoryName: string;
  classificationIsActive: boolean;
  classificationIsDeleted: boolean;
  categoryIsActive: boolean;
  categoryIsDeleted: boolean;
  normalizedKeywords: string[];
};

export function buildTaxonomyFingerprintPayload(
  classifications: readonly TaxonomyFingerprintClassification[]
): TaxonomyFingerprintEntry[] {
  const entries: TaxonomyFingerprintEntry[] = classifications.map((c) => {
    const keywords = parseClassificationKeywords(c.keywords ?? []);
    const normalizedKeywords = [
      ...new Set(keywords.map((k) => normalizeSourceDetailClassificationValue(k)).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b, "ar"));

    return {
      classificationId: c.id,
      classificationName: c.nameAr,
      categoryId: c.category.id,
      categoryName: c.category.nameAr,
      classificationIsActive: c.isActive,
      classificationIsDeleted: c.isDeleted,
      categoryIsActive: c.category.isActive,
      categoryIsDeleted: c.category.isDeleted,
      normalizedKeywords,
    };
  });

  entries.sort((a, b) => a.classificationId.localeCompare(b.classificationId));
  return entries;
}

export function computeTaxonomyFingerprint(
  classifications: readonly TaxonomyFingerprintClassification[]
): string {
  const payload = buildTaxonomyFingerprintPayload(classifications);
  const canonical = JSON.stringify(payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function hashSourceDetailValue(sourceDetail: string): string {
  const normalized = normalizeSourceDetailClassificationValue(sourceDetail.trim());
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
