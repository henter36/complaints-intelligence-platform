import { describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@/server/ai/openai-provider";
import type {
  ClassificationSemanticCatalog,
  LlmStructuredProvider,
  StructuredProviderResponse,
} from "./llm-classification-contract";
import {
  computeLlmClassificationCacheKey,
  runGovernedLlmClassification,
  sanitizeComplaintForClassification,
} from "./llm-classification-service";
import { retrieveClassificationCandidates } from "./classification-semantic-catalog";
import { buildClassifierInput } from "./llm-classification-prompt";

function catalog(): ClassificationSemanticCatalog {
  return {
    schemaVersion: 1,
    status: "DRAFT_REQUIRES_REVIEW",
    generatedAt: "2026-08-14T00:00:00.000Z",
    model: null,
    taxonomyFingerprint: "taxonomy-v1",
    semanticCatalogFingerprint: "catalog-v1",
    categoryCount: 2,
    classificationCount: 3,
    entries: [
      {
        classificationId: "visit",
        classificationName: "الزيارة",
        categoryId: "rights",
        categoryName: "الحقوق",
        keywords: ["زيارة الأبناء", "الزيارة"],
        semanticDefinition: "منع أو تأخر الزيارات الأسرية",
        includedConcepts: ["زيارة الأسرة", "زيارة الأبناء"],
        excludedConcepts: ["سجادة الصلاة"],
        confusableWith: [],
        status: "DRAFT_REQUIRES_REVIEW",
        generationStatus: "PENDING_LLM_ENRICHMENT",
      },
      {
        classificationId: "religious-supplies",
        classificationName: "المستلزمات الدينية",
        categoryId: "guidance",
        categoryName: "التوجيه والإرشاد",
        keywords: ["سجادة صلاة"],
        semanticDefinition: "توفير أدوات العبادة",
        includedConcepts: ["سجادة صلاة"],
        excludedConcepts: ["منع الزيارة"],
        confusableWith: [],
        status: "DRAFT_REQUIRES_REVIEW",
        generationStatus: "PENDING_LLM_ENRICHMENT",
      },
      {
        classificationId: "books",
        classificationName: "المكتبة والقراءة",
        categoryId: "guidance",
        categoryName: "التوجيه والإرشاد",
        keywords: ["قلة الكتب"],
        semanticDefinition: "توفر الكتب وخدمات المكتبة",
        includedConcepts: ["الكتب", "القراءة"],
        excludedConcepts: [],
        confusableWith: [],
        status: "DRAFT_REQUIRES_REVIEW",
        generationStatus: "PENDING_LLM_ENRICHMENT",
      },
    ],
  };
}

function output(value: unknown): StructuredProviderResponse {
  return { output: value, inputTokens: 10, outputTokens: 4, model: "test-model" };
}

function keepOutput() {
  return {
    decision: "KEEP",
    targetClassificationId: null,
    targetCategoryId: null,
    evidenceLevel: "STRONG",
    reasonCodes: ["CURRENT_SUPPORTED"],
    shortReason: "التصنيف الحالي يطابق مضمون الشكوى.",
  };
}

function changeOutput(categoryId = "rights") {
  return {
    decision: "CHANGE",
    targetClassificationId: "visit",
    targetCategoryId: categoryId,
    evidenceLevel: "STRONG",
    reasonCodes: ["SUBJECT_DESCRIPTION"],
    shortReason: "المضمون يتعلق بمنع الزيارة.",
  };
}

function approveOutput(id = "visit") {
  return {
    verdict: "APPROVE_CHANGE",
    supportedClassificationId: id,
    evidenceLevel: "STRONG",
    reasonCodes: ["PROPOSAL_SUPPORTED"],
    shortReason: "المقترح هو الأكثر دعمًا.",
  };
}

function requestComplaint() {
  return sanitizeComplaintForClassification({
    sourceDetail: "سجادة صلاة",
    subject: "منع الزيارة",
    description: "لم أتمكن من زيارة أبنائي منذ ثلاثة أشهر",
  }, 1);
}

describe("governed LLM classification", () => {
  it("keeps a supported active assignment", async () => {
    const provider = vi.fn<LlmStructuredProvider>().mockResolvedValue(output(keepOutput()));
    const result = await runGovernedLlmClassification({
      complaint: requestComplaint(),
      currentClassificationId: "visit",
      currentCategoryId: "rights",
      catalog: catalog(),
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    });
    expect(result.outcome).toBe("KEEP");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("confirms CHANGE only after an independent verifier approval", async () => {
    const provider = vi.fn<LlmStructuredProvider>()
      .mockResolvedValueOnce(output(changeOutput()))
      .mockResolvedValueOnce(output(approveOutput()));
    const result = await runGovernedLlmClassification({
      complaint: requestComplaint(),
      currentClassificationId: "religious-supplies",
      currentCategoryId: "guidance",
      catalog: catalog(),
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    });
    expect(result.outcome).toBe("CHANGE_CONFIRMED");
    expect(result.proposedClassificationId).toBe("visit");
    expect(result.classifierVerifierAgreement).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1][0].input).not.toContain("SUBJECT_DESCRIPTION");
  });

  it("routes verifier rejection and disagreement to REVIEW", async () => {
    const rejection = {
      verdict: "REJECT_CHANGE",
      supportedClassificationId: "religious-supplies",
      evidenceLevel: "MODERATE",
      reasonCodes: ["CURRENT_SUPPORTED"],
      shortReason: "الحالي أوضح.",
    };
    const provider = vi.fn<LlmStructuredProvider>()
      .mockResolvedValueOnce(output(changeOutput()))
      .mockResolvedValueOnce(output(rejection));
    const result = await runGovernedLlmClassification({
      complaint: requestComplaint(),
      currentClassificationId: "religious-supplies",
      currentCategoryId: "guidance",
      catalog: catalog(),
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    });
    expect(result.outcome).toBe("REVIEW");
    expect(result.classifierVerifierAgreement).toBe(false);
  });

  it("returns REVIEW for ambiguous classifier output", async () => {
    const provider = vi.fn<LlmStructuredProvider>().mockResolvedValue(output({
      decision: "REVIEW",
      targetClassificationId: null,
      targetCategoryId: null,
      evidenceLevel: "WEAK",
      reasonCodes: ["AMBIGUOUS"],
      shortReason: "لا توجد أدلة كافية.",
    }));
    const result = await runGovernedLlmClassification({
      complaint: requestComplaint(),
      currentClassificationId: "religious-supplies",
      currentCategoryId: "guidance",
      catalog: catalog(),
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    });
    expect(result.outcome).toBe("REVIEW");
  });

  it.each([
    ["unknown target", { ...changeOutput(), targetClassificationId: "inactive" }],
    ["wrong category pair", changeOutput("guidance")],
    ["malformed output", { decision: "CHANGE" }],
  ])("rejects %s as INVALID_OUTPUT", async (_label, classifierValue) => {
    const provider = vi.fn<LlmStructuredProvider>().mockResolvedValue(output(classifierValue));
    const result = await runGovernedLlmClassification({
      complaint: requestComplaint(),
      currentClassificationId: "religious-supplies",
      currentCategoryId: "guidance",
      catalog: catalog(),
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    });
    expect(result.outcome).toBe("INVALID_OUTPUT");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("redacts every governed PII class and never sends the real complaint ID", async () => {
    const provider = vi.fn<LlmStructuredProvider>().mockResolvedValue(output(keepOutput()));
    const raw = {
      id: "real-complaint-id",
      sourceDetail: "اسم مقدم الشكوى: محمد عبدالله",
      subject: "الهوية 1234567890 والهاتف 0501234567",
      description: "user@example.com https://example.com sk-secret123456 4111 1111 1111 1111",
    };
    const complaint = sanitizeComplaintForClassification(raw, 7);
    await runGovernedLlmClassification({
      complaint,
      currentClassificationId: "visit",
      currentCategoryId: "rights",
      catalog: catalog(),
      provider,
      model: "test-model",
      timeoutMs: 1_000,
    });
    const serializedRequest = JSON.stringify(provider.mock.calls[0][0]);
    for (const secret of [
      "real-complaint-id",
      "محمد عبدالله",
      "1234567890",
      "0501234567",
      "user@example.com",
      "https://example.com",
      "sk-secret123456",
      "4111 1111 1111 1111",
    ]) expect(serializedRequest).not.toContain(secret);
    expect(serializedRequest).toContain("C000007");
  });

  it("retries 429 and timeout but never retries authentication failures", async () => {
    const retrying = vi.fn<LlmStructuredProvider>()
      .mockRejectedValueOnce(new AiProviderError("RATE_LIMITED", "rate"))
      .mockRejectedValueOnce(new AiProviderError("TIMEOUT", "timeout"))
      .mockResolvedValue(output(keepOutput()));
    const retryResult = await runGovernedLlmClassification({
      complaint: requestComplaint(),
      currentClassificationId: "visit",
      currentCategoryId: "rights",
      catalog: catalog(),
      provider: retrying,
      model: "test-model",
      timeoutMs: 1_000,
      retry: { baseDelayMs: 0, sleep: async () => undefined },
    });
    expect(retryResult.outcome).toBe("KEEP");
    expect(retrying).toHaveBeenCalledTimes(3);

    const auth = vi.fn<LlmStructuredProvider>()
      .mockRejectedValue(new AiProviderError("AUTH_ERROR", "auth"));
    const authResult = await runGovernedLlmClassification({
      complaint: requestComplaint(),
      currentClassificationId: "visit",
      currentCategoryId: "rights",
      catalog: catalog(),
      provider: auth,
      model: "test-model",
      timeoutMs: 1_000,
      retry: { baseDelayMs: 0, sleep: async () => undefined },
    });
    expect(authResult.outcome).toBe("API_FAILED");
    expect(auth).toHaveBeenCalledTimes(1);
  });
});

describe("candidate retrieval, anchoring, and cache", () => {
  it("includes the semantically expected classification despite conflicting sourceDetail", () => {
    const candidates = retrieveClassificationCandidates({
      catalog: catalog(),
      complaint: requestComplaint(),
      currentClassificationId: "religious-supplies",
    });
    expect(candidates.map((entry) => entry.classificationId)).toContain("visit");
  });

  it("places current assignment after complaint and candidates", () => {
    const complaint = requestComplaint();
    const candidates = retrieveClassificationCandidates({
      catalog: catalog(), complaint, currentClassificationId: "religious-supplies",
    });
    const prompt = buildClassifierInput({
      complaint,
      candidates,
      currentClassificationId: "religious-supplies",
      currentCategoryId: "guidance",
    });
    expect(prompt.indexOf("allowedCandidateTaxonomy")).toBeLessThan(
      prompt.indexOf("currentSystemAssignmentMayBeWrong")
    );
  });

  it("invalidates cache for content, candidate, model, prompt taxonomy, or catalog changes", () => {
    const base = {
      complaint: requestComplaint(),
      candidateClassificationIds: ["visit", "religious-supplies"],
      model: "model-a",
      taxonomyFingerprint: "taxonomy-a",
      semanticCatalogFingerprint: "catalog-a",
    };
    const key = computeLlmClassificationCacheKey(base);
    expect(computeLlmClassificationCacheKey(base)).toBe(key);
    expect(computeLlmClassificationCacheKey({ ...base, model: "model-b" })).not.toBe(key);
    expect(computeLlmClassificationCacheKey({ ...base, taxonomyFingerprint: "taxonomy-b" })).not.toBe(key);
    expect(computeLlmClassificationCacheKey({ ...base, semanticCatalogFingerprint: "catalog-b" })).not.toBe(key);
    expect(computeLlmClassificationCacheKey({ ...base, candidateClassificationIds: ["visit"] })).not.toBe(key);
    expect(computeLlmClassificationCacheKey({
      ...base,
      complaint: { ...base.complaint, description: "نص آخر" },
    })).not.toBe(key);
  });
});
