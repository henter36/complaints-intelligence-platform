import { describe, expect, it, vi } from "vitest";
import {
  evaluateLlmClassificationPredictions,
  parseLlmClassificationEvaluationArtifact,
  runLlmClassificationEvaluation,
  type EvaluationPrediction,
} from "./llm-classification-evaluation";
import type { ClassificationSemanticCatalog, LlmStructuredProvider } from "./llm-classification-contract";
import type {
  GoldSetReviewArtifact,
  GoldSetReviewItem,
} from "./llm-classification-gold-set";

function prediction(index: number, options: Partial<EvaluationPrediction> = {}): EvaluationPrediction {
  const change = index < 30;
  return {
    reviewId: `G${index}`,
    split: "HOLDOUT",
    currentClassificationId: change ? "old" : "expected",
    expectedClassificationId: "expected",
    expectedCategoryId: "category",
    outcome: change ? "CHANGE_CONFIRMED" : "KEEP",
    predictedClassificationId: change ? "expected" : null,
    predictedCategoryId: change ? "category" : null,
    candidateClassificationIds: ["expected", "old"],
    classifierDecision: change ? "CHANGE" : "KEEP",
    classifierVerifierAgreement: change ? true : null,
    ...options,
  };
}

const evaluationCatalog: ClassificationSemanticCatalog = {
  schemaVersion: 1,
  status: "DRAFT_REQUIRES_REVIEW",
  generatedAt: "2026-08-14T00:00:00.000Z",
  model: null,
  taxonomyFingerprint: "taxonomy",
  semanticCatalogFingerprint: "catalog",
  categoryCount: 1,
  classificationCount: 1,
  entries: [{
    classificationId: "expected",
    classificationName: "متوقع",
    categoryId: "category",
    categoryName: "رئيسي",
    keywords: [],
    semanticDefinition: null,
    includedConcepts: [],
    excludedConcepts: [],
    confusableWith: [],
    status: "DRAFT_REQUIRES_REVIEW",
    generationStatus: "PENDING_LLM_ENRICHMENT",
  }],
};

function reviewedItem(
  index: number,
  split: GoldSetReviewItem["split"] = "HOLDOUT",
  expectedClassificationId = "expected"
): GoldSetReviewItem {
  return {
    reviewId: `G${String(index).padStart(6, "0")}`,
    split,
    sanitizedSourceDetail: "",
    sanitizedSubject: "موضوع",
    sanitizedDescription: "وصف",
    currentCategoryId: "category",
    currentCategoryName: "رئيسي",
    currentClassificationId: "expected",
    currentClassificationName: "متوقع",
    availableClassificationChoices: [],
    humanExpectedClassificationId: expectedClassificationId,
    humanReviewStatus: "REVIEWED",
  };
}

function goldSet(items: GoldSetReviewItem[]): GoldSetReviewArtifact {
  const developmentCount = items.filter((item) => item.split === "DEVELOPMENT").length;
  return {
    schemaVersion: 1,
    status: "LABELED",
    generatedAt: "2026-08-14T00:00:00.000Z",
    taxonomyFingerprint: "taxonomy",
    semanticCatalogFingerprint: "catalog",
    requestedSize: items.length,
    selectedCount: items.length,
    developmentCount,
    holdoutCount: items.length - developmentCount,
    items,
  };
}

function keepProvider() {
  return vi.fn<LlmStructuredProvider>().mockResolvedValue({
    output: {
      decision: "KEEP",
      targetClassificationId: null,
      targetCategoryId: null,
      evidenceLevel: "STRONG",
      reasonCodes: ["CURRENT_SUPPORTED"],
      shortReason: "الحالي مدعوم.",
    },
    inputTokens: 1,
    outputTokens: 1,
    model: "test-model",
  });
}

describe("LLM classification evaluation", () => {
  it("calculates metrics and approves only a suitable >=98% CHANGE holdout", () => {
    const rows = Array.from({ length: 100 }, (_, index) => prediction(index));
    const result = evaluateLlmClassificationPredictions(rows);
    expect(result.status).toBe("PILOT_APPROVED");
    expect(result.change.precision).toBe(1);
    expect(result.change.recall).toBe(1);
    expect(result.overallAccuracy).toBe(1);
    expect(result.candidateRetrievalRecall).toBe(1);
    expect(result.gate.requiredChangePrecision).toBe(0.98);
  });

  it("blocks the pilot when CHANGE_CONFIRMED precision is below 98%", () => {
    const rows = Array.from({ length: 100 }, (_, index) => prediction(index));
    rows[0] = prediction(0, {
      predictedClassificationId: "wrong",
      candidateClassificationIds: ["wrong", "expected"],
    });
    const result = evaluateLlmClassificationPredictions(rows);
    expect(result.change.precision).toBeCloseTo(29 / 30);
    expect(result.status).toBe("PILOT_NOT_APPROVED");
    expect(result.gate.passed).toBe(false);
  });

  it("measures abstention, REVIEW, retrieval recall, and verifier disagreement", () => {
    const rows = Array.from({ length: 100 }, (_, index) => prediction(index));
    rows[0] = prediction(0, {
      outcome: "REVIEW",
      predictedClassificationId: null,
      classifierVerifierAgreement: false,
      candidateClassificationIds: ["old"],
    });
    const result = evaluateLlmClassificationPredictions(rows);
    expect(result.abstentionRate).toBe(0.01);
    expect(result.reviewRate).toBe(0.01);
    expect(result.candidateRetrievalRecall).toBe(0.99);
    expect(result.classifierVerifierDisagreementRate).toBeCloseTo(1 / 30);
    expect(result.confusionMatrix.expected.__REVIEW__).toBe(1);
  });

  it("does not approve a small holdout even with perfect agreement", () => {
    const rows = Array.from({ length: 50 }, (_, index) => prediction(index));
    expect(evaluateLlmClassificationPredictions(rows).status).toBe("PILOT_NOT_APPROVED");
  });

  it("orders multiple systematic failure IDs deterministically", () => {
    const targets = ["zeta", "alpha", "middle"];
    const rows = targets.flatMap((target, targetIndex) =>
      Array.from({ length: 5 }, (_, itemIndex) => prediction(targetIndex * 5 + itemIndex, {
        expectedClassificationId: `expected-${target}`,
        predictedClassificationId: target,
        candidateClassificationIds: [target, `expected-${target}`],
      }))
    );
    expect(evaluateLlmClassificationPredictions(rows).systematicFailures).toEqual([
      "alpha",
      "middle",
      "zeta",
    ]);
  });

  it("stops before provider calls when human labels do not exist", async () => {
    const provider = vi.fn();
    await expect(runLlmClassificationEvaluation({
      goldSet: {
        schemaVersion: 1,
        status: "NOT_YET_LABELED",
        generatedAt: "2026-08-14T00:00:00.000Z",
        taxonomyFingerprint: "taxonomy",
        semanticCatalogFingerprint: "catalog",
        requestedSize: 1,
        selectedCount: 1,
        developmentCount: 1,
        holdoutCount: 0,
        items: [{
          reviewId: "G000001",
          split: "DEVELOPMENT",
          sanitizedSourceDetail: "",
          sanitizedSubject: "موضوع",
          sanitizedDescription: "وصف",
          currentCategoryId: null,
          currentCategoryName: null,
          currentClassificationId: null,
          currentClassificationName: null,
          availableClassificationChoices: [],
          humanExpectedClassificationId: null,
          humanReviewStatus: "PENDING",
        }],
      },
      catalog: {
        schemaVersion: 1,
        status: "DRAFT_REQUIRES_REVIEW",
        generatedAt: "2026-08-14T00:00:00.000Z",
        model: null,
        taxonomyFingerprint: "taxonomy",
        semanticCatalogFingerprint: "catalog",
        categoryCount: 0,
        classificationCount: 0,
        entries: [],
      },
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    })).rejects.toThrow("GOLD_SET_NOT_YET_LABELED");
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not call the provider for reviewed DEVELOPMENT items in approval evaluation", async () => {
    const provider = keepProvider();
    const result = await runLlmClassificationEvaluation({
      goldSet: goldSet([
        reviewedItem(1, "DEVELOPMENT"),
        reviewedItem(2, "HOLDOUT"),
      ]),
      catalog: evaluationCatalog,
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    });

    expect(provider).toHaveBeenCalledOnce();
    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0].split).toBe("HOLDOUT");
  });

  it("validates every HOLDOUT expected ID before the first provider call", async () => {
    const provider = keepProvider();
    const items = Array.from({ length: 10 }, (_, index) => reviewedItem(
      index + 1,
      "HOLDOUT",
      index === 9 ? "missing-classification" : "expected"
    ));

    await expect(runLlmClassificationEvaluation({
      goldSet: goldSet(items),
      catalog: evaluationCatalog,
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    })).rejects.toThrow("GOLD_SET_EXPECTED_CLASSIFICATION_INVALID");
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects malformed operator-controlled evaluation artifacts with a stable error", () => {
    expect(() => parseLlmClassificationEvaluationArtifact({
      schemaVersion: 1,
      model: "test-model",
      metrics: { status: "PILOT_APPROVED" },
    })).toThrow("LLM_CLASSIFICATION_EVALUATION_ARTIFACT_INVALID");
  });
});
