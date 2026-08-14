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
    expect(provider.mock.calls[0][0].schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["semanticDefinition", "includedConcepts", "excludedConcepts", "confusableWith"],
      properties: {
        semanticDefinition: { type: "string" },
        includedConcepts: { type: "array", items: { type: "string" } },
        excludedConcepts: { type: "array", items: { type: "string" } },
        confusableWith: { type: "array", items: { type: "string" } },
      },
    });
    const providerSchema = JSON.stringify(provider.mock.calls[0][0].schema);
    expect(providerSchema).not.toContain("minLength");
    expect(providerSchema).not.toContain("maxLength");
    expect(providerSchema).not.toContain("maxItems");
  });

  it.each([
    ["overly long definition", { semanticDefinition: "س".repeat(801) }],
    ["too many included concepts", { includedConcepts: Array(21).fill("مفهوم") }],
    ["too many excluded concepts", { excludedConcepts: Array(21).fill("استثناء") }],
    ["too many confusable IDs", { confusableWith: Array(13).fill("other") }],
  ])("keeps Zod output limits for %s", async (_label, override) => {
    const db = {
      classification: { findMany: vi.fn().mockResolvedValue([classification]) },
      complaint: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const provider = vi.fn().mockResolvedValue({
      output: {
        semanticDefinition: "تعريف",
        includedConcepts: ["مفهوم"],
        excludedConcepts: ["استثناء"],
        confusableWith: [],
        ...override,
      },
      inputTokens: 1,
      outputTokens: 1,
      model: "test-model",
    });

    await expect(buildClassificationSemanticCatalog({
      db,
      model: "test-model",
      provider,
      generatedAt: new Date("2026-08-14T00:00:00.000Z"),
    })).rejects.toThrow("SEMANTIC_CATALOG_MODEL_OUTPUT_INVALID");
  });

  it("bounds deterministic complaint examples per active classification", async () => {
    const secondClassification = {
      ...classification,
      id: "books",
      nameAr: "المكتبة",
    };
    const findMany = vi.fn().mockImplementation(({
      where,
      take,
    }: { where: { classificationId: string }; take: number }) =>
      Promise.resolve(Array.from({ length: Math.min(60, take) }, (_, index) => ({
        id: `${where.classificationId}-${index}`,
        sourceDetail: null,
        subject: `موضوع ${index}`,
        description: `وصف ${index}`,
      })))
    );
    const db = {
      classification: { findMany: vi.fn().mockResolvedValue([classification, secondClassification]) },
      complaint: { findMany },
    } as unknown as PrismaClient;
    const provider = vi.fn().mockResolvedValue({
      output: {
        semanticDefinition: "تعريف",
        includedConcepts: ["مفهوم"],
        excludedConcepts: [],
        confusableWith: [],
      },
      inputTokens: 1,
      outputTokens: 1,
      model: "test-model",
    });

    await buildClassificationSemanticCatalog({ db, model: "test-model", provider });

    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [query] of findMany.mock.calls) {
      expect(query).toMatchObject({ orderBy: { id: "asc" }, take: 50 });
      expect(typeof query.where.classificationId).toBe("string");
    }
    expect(provider).toHaveBeenCalledTimes(2);
    for (const [request] of provider.mock.calls) {
      const providerInput = JSON.parse(request.input) as { sanitizedExamples: unknown[] };
      expect(providerInput.sanitizedExamples.length).toBeLessThanOrEqual(3);
    }
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
