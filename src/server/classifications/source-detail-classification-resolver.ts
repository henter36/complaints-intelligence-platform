import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import { parseClassificationKeywords } from "./classification-keywords";

export type SourceDetailClassificationCandidate = {
  id: string;
  nameAr: string;
  keywords: unknown;
  isActive?: boolean;
  isDeleted?: boolean;
  category: {
    id: string;
    nameAr: string;
    isActive?: boolean;
    isDeleted?: boolean;
  };
};

export type SourceDetailClassificationMatch = {
  classificationId: string;
  classificationName: string;
  categoryId: string;
  categoryName: string;
  matchedKeyword: string;
};

export type SourceDetailClassificationResolution =
  | { status: "SKIPPED_EXPLICIT_CLASSIFICATION" }
  | { status: "NO_SOURCE_DETAIL" }
  | { status: "UNMATCHED"; normalizedValue: string }
  | {
      status: "MATCHED";
      normalizedValue: string;
      match: SourceDetailClassificationMatch;
    }
  | {
      status: "AMBIGUOUS";
      normalizedValue: string;
      matches: SourceDetailClassificationMatch[];
    }
  | {
      status: "CATEGORY_CONFLICT";
      normalizedValue: string;
      explicitCategory: string;
      matchedCategory: string;
      match: SourceDetailClassificationMatch;
    };

export class ClassificationKeywordsError extends Error {
  readonly classificationId: string;
  constructor(classificationId: string) {
    super(`CLASSIFICATION_KEYWORDS_INVALID: ${classificationId}`);
    this.name = "ClassificationKeywordsError";
    this.classificationId = classificationId;
  }
}

export function normalizeSourceDetailClassificationValue(value: string): string {
  return normalizeClassificationKeyword(value);
}

function isCandidateActive(candidate: SourceDetailClassificationCandidate): boolean {
  return (
    candidate.isDeleted !== true &&
    candidate.isActive !== false &&
    candidate.category.isDeleted !== true &&
    candidate.category.isActive !== false
  );
}

function findCandidateMatch(
  candidate: SourceDetailClassificationCandidate,
  normalizedValue: string
): SourceDetailClassificationMatch | null {
  let keywords: string[];
  try {
    keywords = parseClassificationKeywords(candidate.keywords);
  } catch {
    throw new ClassificationKeywordsError(candidate.id);
  }

  for (const keyword of keywords) {
    if (normalizeSourceDetailClassificationValue(keyword) !== normalizedValue) continue;

    return {
      classificationId: candidate.id,
      classificationName: candidate.nameAr,
      categoryId: candidate.category.id,
      categoryName: candidate.category.nameAr,
      matchedKeyword: keyword,
    };
  }

  return null;
}

export function resolveSourceDetailClassification(input: {
  sourceDetail?: string | null;
  explicitClassification?: string | null;
  explicitCategory?: string | null;
  classifications: readonly SourceDetailClassificationCandidate[];
}): SourceDetailClassificationResolution {
  if (input.explicitClassification?.trim()) {
    return { status: "SKIPPED_EXPLICIT_CLASSIFICATION" };
  }

  const sourceDetail = input.sourceDetail?.trim();
  if (!sourceDetail) return { status: "NO_SOURCE_DETAIL" };

  const normalizedValue = normalizeSourceDetailClassificationValue(sourceDetail);
  if (!normalizedValue) return { status: "NO_SOURCE_DETAIL" };

  const matches = input.classifications
    .filter(isCandidateActive)
    .map((candidate) => findCandidateMatch(candidate, normalizedValue))
    .filter((match): match is SourceDetailClassificationMatch => match !== null);

  if (matches.length === 0) {
    return { status: "UNMATCHED", normalizedValue };
  }

  if (matches.length === 1) {
    const match = matches[0];

    if (input.explicitCategory?.trim()) {
      const normalizedExplicit = normalizeSourceDetailClassificationValue(input.explicitCategory.trim());
      const normalizedMatched = normalizeSourceDetailClassificationValue(match.categoryName);

      if (normalizedExplicit !== normalizedMatched) {
        return {
          status: "CATEGORY_CONFLICT",
          normalizedValue,
          explicitCategory: input.explicitCategory.trim(),
          matchedCategory: match.categoryName,
          match,
        };
      }
    }

    return { status: "MATCHED", normalizedValue, match };
  }

  return { status: "AMBIGUOUS", normalizedValue, matches };
}
