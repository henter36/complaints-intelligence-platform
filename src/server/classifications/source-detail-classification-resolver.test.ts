import { describe, expect, it } from "vitest";
import {
  normalizeSourceDetailClassificationValue,
  resolveSourceDetailClassification,
  ClassificationKeywordsError,
  type SourceDetailClassificationCandidate,
} from "./source-detail-classification-resolver";

const candidates: SourceDetailClassificationCandidate[] = [
  {
    id: "classification-health",
    nameAr: "الرعاية الصحية",
    keywords: ["طلب دواء", "موعد طبي"],
    category: { id: "category-services", nameAr: "خدمات النزلاء" },
  },
  {
    id: "classification-transfer",
    nameAr: "النقل والتحويل",
    keywords: ["طلب نقل"],
    category: { id: "category-rights", nameAr: "حقوق النزلاء" },
  },
];

describe("normalizeSourceDetailClassificationValue", () => {
  it("normalizes Arabic variants and whitespace", () => {
    expect(normalizeSourceDetailClassificationValue("  طــلب   دواء ")).toBe(
      normalizeSourceDetailClassificationValue("طلب دواء")
    );
  });
});

describe("resolveSourceDetailClassification", () => {
  it("preserves an explicit classification", () => {
    expect(
      resolveSourceDetailClassification({
        sourceDetail: "طلب دواء",
        explicitClassification: "تصنيف وارد من الملف",
        classifications: candidates,
      })
    ).toEqual({ status: "SKIPPED_EXPLICIT_CLASSIFICATION" });
  });

  it("matches sourceDetail to one managed classification", () => {
    const result = resolveSourceDetailClassification({
      sourceDetail: "  طلب   دواء ",
      classifications: candidates,
    });

    expect(result).toMatchObject({
      status: "MATCHED",
      match: {
        classificationId: "classification-health",
        classificationName: "الرعاية الصحية",
        categoryId: "category-services",
        categoryName: "خدمات النزلاء",
        matchedKeyword: "طلب دواء",
      },
    });
  });

  it("returns unmatched without creating a classification", () => {
    expect(
      resolveSourceDetailClassification({
        sourceDetail: "موضوع غير معروف",
        classifications: candidates,
      })
    ).toMatchObject({ status: "UNMATCHED" });
  });

  it("ignores inactive or deleted classifications and categories", () => {
    const result = resolveSourceDetailClassification({
      sourceDetail: "طلب نقل",
      classifications: [
        {
          ...candidates[1],
          isActive: false,
        },
        {
          ...candidates[1],
          id: "deleted-category-match",
          category: {
            ...candidates[1].category,
            id: "deleted-category",
            isDeleted: true,
          },
        },
      ],
    });

    expect(result).toMatchObject({ status: "UNMATCHED" });
  });

  it("reports ambiguity instead of choosing silently", () => {
    const result = resolveSourceDetailClassification({
      sourceDetail: "طلب دواء",
      classifications: [
        ...candidates,
        {
          id: "classification-other",
          nameAr: "تصنيف آخر",
          keywords: ["طلب دواء"],
          category: { id: "category-other", nameAr: "فئة أخرى" },
        },
      ],
    });

    expect(result).toMatchObject({ status: "AMBIGUOUS" });
    if (result.status === "AMBIGUOUS") {
      expect(result.matches).toHaveLength(2);
    }
  });

  it("does not resolve an empty sourceDetail", () => {
    expect(
      resolveSourceDetailClassification({
        sourceDetail: "   ",
        classifications: candidates,
      })
    ).toEqual({ status: "NO_SOURCE_DETAIL" });
  });

  it("throws ClassificationKeywordsError when an active classification has malformed keywords", () => {
    expect(() =>
      resolveSourceDetailClassification({
        sourceDetail: "طلب دواء",
        classifications: [
          {
            id: "bad-keywords-id",
            nameAr: "تصنيف فاسد",
            keywords: { invalid: true },
            category: { id: "cat-1", nameAr: "فئة" },
          },
        ],
      })
    ).toThrow(ClassificationKeywordsError);
  });

  it("does not set classification when explicit category conflicts with the matched category", () => {
    const result = resolveSourceDetailClassification({
      sourceDetail: "طلب دواء",
      explicitCategory: "فئة مختلفة",
      classifications: candidates,
    });
    expect(result.status).toBe("CATEGORY_CONFLICT");
    if (result.status === "CATEGORY_CONFLICT") {
      expect(result.explicitCategory).toBe("فئة مختلفة");
      expect(result.matchedCategory).toBe("خدمات النزلاء");
    }
  });

  it("returns MATCHED when explicit category matches the matched category (Arabic normalization)", () => {
    const result = resolveSourceDetailClassification({
      sourceDetail: "طلب دواء",
      explicitCategory: "خدمات  النزلاء",
      classifications: candidates,
    });
    expect(result.status).toBe("MATCHED");
  });

  it("returns MATCHED and sets category when no explicit category is provided", () => {
    const result = resolveSourceDetailClassification({
      sourceDetail: "طلب نقل",
      classifications: candidates,
    });
    expect(result.status).toBe("MATCHED");
    if (result.status === "MATCHED") {
      expect(result.match.categoryName).toBe("حقوق النزلاء");
    }
  });

  it("explicit classification skips category conflict check", () => {
    expect(
      resolveSourceDetailClassification({
        sourceDetail: "طلب دواء",
        explicitClassification: "تصنيف صريح",
        explicitCategory: "فئة أخرى",
        classifications: candidates,
      })
    ).toEqual({ status: "SKIPPED_EXPLICIT_CLASSIFICATION" });
  });

  it("Arabic diacritics and extra spaces do not cause a false category conflict", () => {
    const result = resolveSourceDetailClassification({
      sourceDetail: "طلب دواء",
      explicitCategory: "خدمات النزلاء ",
      classifications: candidates,
    });
    expect(result.status).toBe("MATCHED");
  });
});
