import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClassificationSemanticCatalog,
  LlmStructuredProvider,
} from "./llm-classification-contract";
import { runLlmClassificationPilot } from "./llm-classification-pilot";
import { computeSemanticCatalogFingerprint } from "./classification-semantic-catalog";
import { computeTaxonomyFingerprint } from "./taxonomy-fingerprint";

const testRoot = resolve(process.cwd(), ".local/llm-classification/pilot-test");

afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

const catalogEntries: ClassificationSemanticCatalog["entries"] = [{
  classificationId: "visit",
  classificationName: "الزيارة",
  categoryId: "rights",
  categoryName: "الحقوق",
  keywords: ["زيارة"],
  semanticDefinition: "الزيارة الأسرية",
  includedConcepts: ["زيارة"],
  excludedConcepts: [],
  confusableWith: [],
  status: "DRAFT_REQUIRES_REVIEW",
  generationStatus: "PENDING_LLM_ENRICHMENT",
}];
const taxonomyRows = [{
  id: "visit",
  nameAr: "الزيارة",
  description: null,
  keywords: ["زيارة"],
  isActive: true,
  isDeleted: false,
  category: { id: "rights", nameAr: "الحقوق", isActive: true, isDeleted: false },
}];
const catalog: ClassificationSemanticCatalog = {
  schemaVersion: 1,
  status: "DRAFT_REQUIRES_REVIEW",
  generatedAt: "2026-08-14T00:00:00.000Z",
  model: null,
  taxonomyFingerprint: computeTaxonomyFingerprint(taxonomyRows),
  semanticCatalogFingerprint: computeSemanticCatalogFingerprint(catalogEntries),
  categoryCount: 1,
  classificationCount: 1,
  entries: catalogEntries,
};

function paths() {
  mkdirSync(testRoot, { recursive: true });
  return {
    statePath: resolve(testRoot, "state.json"),
    cachePath: resolve(testRoot, "cache.json"),
    artifactPath: resolve(testRoot, "pilot.json"),
    privateReviewPath: resolve(testRoot, "private-review.json"),
  };
}

describe("read-only LLM classification pilot", () => {
  it("never mutates classification fields and resumes completed items", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: `complaint-${index}`,
      sourceDetail: "زيارة",
      subject: "طلب زيارة",
      description: "لم تتم الزيارة",
      classificationId: "visit",
      categoryId: "rights",
      version: index + 1,
      classification: { nameAr: "الزيارة" },
      category: { nameAr: "الحقوق" },
    }));
    const snapshot = rows.map(({ classificationId, categoryId, version }) => ({
      classificationId, categoryId, version,
    }));
    const update = vi.fn(() => { throw new Error("PILOT_MUST_NOT_WRITE"); });
    const findMany = vi.fn().mockResolvedValue(rows);
    const db = {
      complaint: { findMany, update, updateMany: update },
      classification: { findMany: vi.fn().mockResolvedValue(taxonomyRows) },
    } as unknown as PrismaClient;
    const provider = vi.fn<LlmStructuredProvider>().mockResolvedValue({
      output: {
        decision: "KEEP",
        targetClassificationId: null,
        targetCategoryId: null,
        evidenceLevel: "STRONG",
        reasonCodes: ["SUPPORTED"],
        shortReason: "الحالي مناسب.",
      },
      inputTokens: 10,
      outputTokens: 3,
      model: "test-model",
    });
    const artifact = await runLlmClassificationPilot({
      db,
      catalog,
      provider,
      model: "test-model",
      timeoutMs: 1_000,
      limit: 4,
      concurrency: 2,
      smoke: true,
      ...paths(),
    });
    expect(artifact.scannedCount).toBe(4);
    expect(artifact.counts.KEEP).toBe(4);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    expect(rows.map(({ classificationId, categoryId, version }) => ({
      classificationId, categoryId, version,
    }))).toEqual(snapshot);

    const resumed = await runLlmClassificationPilot({
      db,
      catalog,
      provider,
      model: "test-model",
      timeoutMs: 1_000,
      limit: 4,
      concurrency: 2,
      smoke: true,
      ...paths(),
    });
    expect(resumed.runId).toBe(artifact.runId);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(paths().statePath, "utf8")).items)
      .toSatisfy((items: Array<{ status: string }>) => items.every((item) => item.status === "COMPLETED"));
    const publicArtifact = readFileSync(paths().artifactPath, "utf8");
    expect(publicArtifact).not.toContain("طلب زيارة");
    expect(publicArtifact).not.toContain("لم تتم الزيارة");
  });

  it("refuses a non-smoke pilot without the evaluation gate", async () => {
    const db = { complaint: { findMany: vi.fn() } } as unknown as PrismaClient;
    const provider = vi.fn<LlmStructuredProvider>();
    await expect(runLlmClassificationPilot({
      db,
      catalog,
      provider,
      model: "test-model",
      timeoutMs: 1_000,
      limit: 1,
      smoke: false,
      evaluationGate: {
        status: "PILOT_NOT_APPROVED",
        model: "test-model",
        promptVersion: "1.0.0",
        taxonomyFingerprint: catalog.taxonomyFingerprint,
        semanticCatalogFingerprint: catalog.semanticCatalogFingerprint,
      },
      ...paths(),
    })).rejects.toThrow("PILOT_NOT_APPROVED");
    expect(db.complaint.findMany).not.toHaveBeenCalled();
  });

  it("keeps private-review opaque IDs consistent with provider requests after resume", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `resume-${index}`,
      sourceDetail: "زيارة",
      subject: `موضوع فريد ${index}`,
      description: "وصف للمراجعة",
      classificationId: "visit",
      categoryId: "rights",
      version: index + 1,
      classification: { nameAr: "الزيارة" },
      category: { nameAr: "الحقوق" },
    }));
    const db = {
      complaint: { findMany: vi.fn().mockResolvedValue(rows) },
      classification: { findMany: vi.fn().mockResolvedValue(taxonomyRows) },
    } as unknown as PrismaClient;
    const provider = vi.fn<LlmStructuredProvider>().mockResolvedValue({
      output: {
        decision: "REVIEW",
        targetClassificationId: null,
        targetCategoryId: null,
        evidenceLevel: "WEAK",
        reasonCodes: ["AMBIGUOUS"],
        shortReason: "تحتاج مراجعة.",
      },
      inputTokens: 10,
      outputTokens: 3,
      model: "test-model",
    });
    const artifactPaths = paths();

    await runLlmClassificationPilot({
      db,
      catalog,
      provider,
      model: "test-model",
      timeoutMs: 1_000,
      limit: 3,
      smoke: true,
      ...artifactPaths,
    });

    const state = JSON.parse(readFileSync(artifactPaths.statePath, "utf8")) as {
      items: Array<{ status: string; result: unknown }>;
    };
    state.items.reverse();
    state.items[0].status = "PENDING";
    state.items[0].result = null;
    writeFileSync(artifactPaths.statePath, JSON.stringify(state));
    writeFileSync(artifactPaths.cachePath, "{}");

    await runLlmClassificationPilot({
      db,
      catalog,
      provider,
      model: "test-model",
      timeoutMs: 1_000,
      limit: 3,
      smoke: true,
      ...artifactPaths,
    });

    const opaqueIdBySubject = new Map<string, string>();
    for (const [request] of provider.mock.calls) {
      const firstSection = request.input.split("\n", 1)[0];
      const parsed = JSON.parse(firstSection) as {
        complaint: { opaqueId: string; subject: string };
      };
      const previous = opaqueIdBySubject.get(parsed.complaint.subject);
      if (previous) expect(parsed.complaint.opaqueId).toBe(previous);
      opaqueIdBySubject.set(parsed.complaint.subject, parsed.complaint.opaqueId);
    }

    const privateReview = JSON.parse(readFileSync(artifactPaths.privateReviewPath, "utf8")) as {
      items: Array<{ opaqueId: string; sanitizedSubject: string }>;
    };
    expect(privateReview.items).toHaveLength(3);
    for (const item of privateReview.items) {
      expect(item.opaqueId).toBe(opaqueIdBySubject.get(item.sanitizedSubject));
    }
  });
});
