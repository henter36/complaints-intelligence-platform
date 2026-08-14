import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  buildClassificationSemanticCatalog,
  retrieveClassificationCandidates,
} from "./classification-semantic-catalog";

const classification = {
  id: "visit",
  nameAr: "الزيارة",
  description: "شكاوى الزيارات الأسرية",
  keywords: ["زيارة الأبناء"],
  isActive: true,
  isDeleted: false,
  category: {
    id: "rights",
    nameAr: "الحقوق",
    isActive: true,
    isDeleted: false,
  },
};

describe("classification semantic catalog", () => {
  it("builds a review-only scaffold from active taxonomy without inventing definitions", async () => {
    const db = {
      classification: { findMany: vi.fn().mockResolvedValue([classification]) },
      complaint: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const catalog = await buildClassificationSemanticCatalog({
      db,
      model: "unused-model",
      generatedAt: new Date("2026-08-14T00:00:00.000Z"),
    });
    expect(catalog).toMatchObject({
      status: "DRAFT_REQUIRES_REVIEW",
      model: null,
      categoryCount: 1,
      classificationCount: 1,
    });
    expect(catalog.entries[0]).toMatchObject({
      semanticDefinition: classification.description,
      includedConcepts: classification.keywords,
      generationStatus: "PENDING_LLM_ENRICHMENT",
    });
    expect(db.complaint.findMany).not.toHaveBeenCalled();
  });

  it("validates LLM definitions and filters invented confusable IDs", async () => {
    const db = {
      classification: { findMany: vi.fn().mockResolvedValue([classification]) },
      complaint: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const provider = vi.fn().mockResolvedValue({
      output: {
        semanticDefinition: "مسودة تعريف الزيارة",
        includedConcepts: ["الزيارة العائلية"],
        excludedConcepts: ["المستلزمات"],
        confusableWith: ["invented-id", "visit"],
      },
      inputTokens: 1,
      outputTokens: 1,
      model: "test-model",
    });
    const catalog = await buildClassificationSemanticCatalog({
      db,
      model: "test-model",
      provider,
      generatedAt: new Date("2026-08-14T00:00:00.000Z"),
    });
    expect(catalog.entries[0]).toMatchObject({
      semanticDefinition: "مسودة تعريف الزيارة",
      confusableWith: [],
      generationStatus: "GENERATED_BY_LLM",
    });
  });

  it("widens weak retrieval to preserve candidate recall", () => {
    const entries = Array.from({ length: 35 }, (_, index) => ({
      classificationId: `c-${index}`,
      classificationName: `تصنيف ${index}`,
      categoryId: "category",
      categoryName: "رئيسي",
      keywords: [],
      semanticDefinition: null,
      includedConcepts: [],
      excludedConcepts: [],
      confusableWith: [],
      status: "DRAFT_REQUIRES_REVIEW" as const,
      generationStatus: "PENDING_LLM_ENRICHMENT" as const,
    }));
    const candidates = retrieveClassificationCandidates({
      catalog: {
        schemaVersion: 1,
        status: "DRAFT_REQUIRES_REVIEW",
        generatedAt: "2026-08-14T00:00:00.000Z",
        model: null,
        taxonomyFingerprint: "t",
        semanticCatalogFingerprint: "c",
        categoryCount: 1,
        classificationCount: entries.length,
        entries,
      },
      complaint: { sourceDetail: "", subject: "عام", description: "غير محدد" },
      currentClassificationId: null,
    });
    expect(candidates).toHaveLength(35);
  });

  it("preserves the CURRENT_CATEGORY score and reason with optional current assignment", () => {
    const entries = [
      {
        classificationId: "current",
        classificationName: "الحالي",
        categoryId: "shared-category",
        categoryName: "رئيسي",
        keywords: [],
        semanticDefinition: null,
        includedConcepts: [],
        excludedConcepts: [],
        confusableWith: [],
        status: "DRAFT_REQUIRES_REVIEW" as const,
        generationStatus: "PENDING_LLM_ENRICHMENT" as const,
      },
      {
        classificationId: "peer",
        classificationName: "نظير",
        categoryId: "shared-category",
        categoryName: "رئيسي",
        keywords: [],
        semanticDefinition: null,
        includedConcepts: [],
        excludedConcepts: [],
        confusableWith: [],
        status: "DRAFT_REQUIRES_REVIEW" as const,
        generationStatus: "PENDING_LLM_ENRICHMENT" as const,
      },
    ];
    const baseCatalog = {
      schemaVersion: 1,
      status: "DRAFT_REQUIRES_REVIEW" as const,
      generatedAt: "2026-08-14T00:00:00.000Z",
      model: null,
      taxonomyFingerprint: "t",
      semanticCatalogFingerprint: "c",
      categoryCount: 1,
      classificationCount: entries.length,
      entries,
    };
    const withCurrent = retrieveClassificationCandidates({
      catalog: baseCatalog,
      complaint: { sourceDetail: "", subject: "عام", description: "" },
      currentClassificationId: "current",
    });
    const peer = withCurrent.find((entry) => entry.classificationId === "peer");
    expect(peer?.retrievalScore).toBe(0.5);
    expect(peer?.retrievalReasons).toContain("CURRENT_CATEGORY");

    const withoutCurrent = retrieveClassificationCandidates({
      catalog: baseCatalog,
      complaint: { sourceDetail: "", subject: "عام", description: "" },
      currentClassificationId: null,
    });
    expect(withoutCurrent.find((entry) => entry.classificationId === "peer")?.retrievalReasons)
      .not.toContain("CURRENT_CATEGORY");
  });
});
