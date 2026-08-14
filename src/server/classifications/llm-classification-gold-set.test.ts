import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ClassificationSemanticCatalog } from "./llm-classification-contract";
import {
  prepareClassificationGoldSet,
  selectStratifiedComplaints,
} from "./llm-classification-gold-set";

const catalog: ClassificationSemanticCatalog = {
  schemaVersion: 1,
  status: "DRAFT_REQUIRES_REVIEW",
  generatedAt: "2026-08-14T00:00:00.000Z",
  model: null,
  taxonomyFingerprint: "taxonomy",
  semanticCatalogFingerprint: "catalog",
  categoryCount: 2,
  classificationCount: 2,
  entries: [
    {
      classificationId: "a",
      classificationName: "زيارة",
      categoryId: "cat-a",
      categoryName: "حقوق",
      keywords: ["زيارة"],
      semanticDefinition: null,
      includedConcepts: ["زيارة"],
      excludedConcepts: [],
      confusableWith: [],
      status: "DRAFT_REQUIRES_REVIEW",
      generationStatus: "PENDING_LLM_ENRICHMENT",
    },
    {
      classificationId: "b",
      classificationName: "كتب",
      categoryId: "cat-b",
      categoryName: "إرشاد",
      keywords: ["كتب"],
      semanticDefinition: null,
      includedConcepts: ["قراءة"],
      excludedConcepts: [],
      confusableWith: [],
      status: "DRAFT_REQUIRES_REVIEW",
      generationStatus: "PENDING_LLM_ENRICHMENT",
    },
  ],
};

function row(index: number, classificationId: string | null) {
  let categoryId: string | null = null;
  if (classificationId === "a") categoryId = "cat-a";
  if (classificationId === "b") categoryId = "cat-b";
  const classificationName = classificationId === "a" ? "زيارة" : "كتب";
  const categoryName = categoryId === "cat-a" ? "حقوق" : "إرشاد";
  return {
    id: `real-${index}`,
    sourceDetail: index % 2 === 0 ? "زيارة" : null,
    subject: `موضوع ${index}`,
    description: index % 3 === 0 ? "وصف ".repeat(150) : "وصف قصير",
    classificationId,
    categoryId,
    classification: classificationId ? { nameAr: classificationName } : null,
    category: categoryId ? { nameAr: categoryName } : null,
  };
}

describe("human Gold Set workflow", () => {
  it("selects deterministically across classification and text strata", () => {
    const rows = Array.from({ length: 30 }, (_, index) => {
      const remainder = index % 3;
      let classificationId: string | null = null;
      if (remainder === 0) classificationId = "a";
      if (remainder === 1) classificationId = "b";
      return row(index, classificationId);
    });
    const first = selectStratifiedComplaints(rows, 12);
    const second = selectStratifiedComplaints([...rows].reverse(), 12);
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(new Set(first.map((item) => item.classificationId))).toEqual(new Set(["a", "b", null]));
    expect(first.some((item) => item.sourceDetail === null)).toBe(true);
    expect(first.some((item) => (item.description?.length ?? 0) > 500)).toBe(true);
  });

  it("keeps human labels pending and separates real complaint IDs", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(index, index % 2 === 0 ? "a" : "b"));
    const findMany = vi.fn().mockResolvedValue(rows);
    const db = { complaint: { findMany } } as unknown as PrismaClient;
    const result = await prepareClassificationGoldSet({ db, catalog, size: 10 });
    expect(result.review.status).toBe("NOT_YET_LABELED");
    expect(result.review.items).toHaveLength(10);
    expect(result.review.items.every(
      (item) => item.humanExpectedClassificationId === null && item.humanReviewStatus === "PENDING"
    )).toBe(true);
    expect(JSON.stringify(result.review)).not.toContain("real-");
    expect(result.privateMap.mappings[0].complaintId).toContain("real-");
    expect(result.review.developmentCount + result.review.holdoutCount).toBe(10);
  });
});
