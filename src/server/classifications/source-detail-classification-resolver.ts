import { normalizeArabic } from "@/server/imports/arabic-normalize";

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
    };

export function normalizeSourceDetailClassificationValue(value: string): string {
  return normalizeArabic(value)
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

function parseKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && Boolean(item.trim())
  );
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
  for (const keyword of parseKeywords(candidate.keywords)) {
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
    return { status: "MATCHED", normalizedValue, match: matches[0] };
  }

  return { status: "AMBIGUOUS", normalizedValue, matches };
}
