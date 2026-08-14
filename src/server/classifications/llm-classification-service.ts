import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import {
  sanitizeClassificationComplaint,
  type ClassificationComplaintInput,
  type SanitizedClassificationComplaint,
} from "@/server/ai/ai-data-sanitization-service";
import { AiProviderError, callOpenAIStructured } from "@/server/ai/openai-provider";
import {
  CLASSIFIER_JSON_SCHEMA,
  LLM_CLASSIFICATION_PROMPT_VERSION,
  classifierOutputSchema,
  type ClassificationRequest,
  type ClassificationSemanticCatalog,
  type ClassifierOutput,
  type GovernedClassificationResult,
  type LlmStructuredProvider,
  type LlmTokenUsage,
} from "./llm-classification-contract";
import { buildClassifierInput, classifierInstructions } from "./llm-classification-prompt";
import { type RetryOptions, withBoundedAiRetry } from "./llm-classification-reliability";
import { retrieveClassificationCandidates } from "./classification-semantic-catalog";
import { stableStringify } from "./historical-classification-backfill";
import { verifyClassificationChange } from "./llm-classification-verifier";

export type ClassifierPassResult = {
  output: ClassifierOutput | null;
  request: ClassificationRequest;
  inputTokens: number;
  outputTokens: number;
  failureCode: string | null;
};

function emptyUsage(): LlmTokenUsage {
  return {
    classifierInputTokens: 0,
    classifierOutputTokens: 0,
    verifierInputTokens: 0,
    verifierOutputTokens: 0,
    totalRequests: 0,
  };
}

export function assertLlmClassificationRuntimeEnabled(): void {
  if (!env.aiEnabled) throw new Error("LLM_CLASSIFICATION_AI_DISABLED");
  if (!env.openAiApiKey) throw new Error("LLM_CLASSIFICATION_API_KEY_MISSING");
  if (env.aiProvider !== "openai") throw new Error("LLM_CLASSIFICATION_PROVIDER_UNSUPPORTED");
}

function validateClassifierAssignment(input: {
  output: ClassifierOutput;
  request: ClassificationRequest;
  catalog: ClassificationSemanticCatalog;
}): boolean {
  const { output, request } = input;
  if (output.decision === "KEEP") {
    if (output.targetClassificationId !== null || output.targetCategoryId !== null) return false;
    if (request.currentClassificationId === null && request.currentCategoryId === null) return true;
    if (request.currentClassificationId === null || request.currentCategoryId === null) return false;
    const current = input.catalog.entries.find(
      (entry) => entry.classificationId === request.currentClassificationId
    );
    return current?.categoryId === request.currentCategoryId;
  }
  if (output.decision === "REVIEW") {
    return output.targetClassificationId === null && output.targetCategoryId === null;
  }
  if (!output.targetClassificationId || !output.targetCategoryId) return false;
  if (output.targetClassificationId === request.currentClassificationId) return false;
  const target = input.catalog.entries.find(
    (entry) => entry.classificationId === output.targetClassificationId
  );
  return Boolean(
    target &&
    target.categoryId === output.targetCategoryId &&
    request.candidates.some((entry) => entry.classificationId === target.classificationId)
  );
}

export async function classifySanitizedComplaint(input: {
  complaint: SanitizedClassificationComplaint;
  currentClassificationId: string | null;
  currentCategoryId: string | null;
  catalog: ClassificationSemanticCatalog;
  provider?: LlmStructuredProvider;
  model: string;
  timeoutMs: number;
  retry?: RetryOptions;
  topN?: number;
}): Promise<ClassifierPassResult> {
  const candidates = retrieveClassificationCandidates({
    catalog: input.catalog,
    complaint: input.complaint,
    currentClassificationId: input.currentClassificationId,
    topN: input.topN,
  });
  const request: ClassificationRequest = {
    complaint: input.complaint,
    currentClassificationId: input.currentClassificationId,
    currentCategoryId: input.currentCategoryId,
    candidates,
  };
  const provider = input.provider ?? callOpenAIStructured;

  try {
    const response = await withBoundedAiRetry(() => provider({
      model: input.model,
      instructions: classifierInstructions(),
      input: buildClassifierInput(request),
      schemaName: "historical_complaint_classifier",
      schema: CLASSIFIER_JSON_SCHEMA,
      timeoutMs: input.timeoutMs,
      maxOutputTokens: 600,
    }), input.retry);
    const parsed = classifierOutputSchema.safeParse(response.output);
    if (!parsed.success || !validateClassifierAssignment({ output: parsed.data, request, catalog: input.catalog })) {
      return {
        output: null,
        request,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        failureCode: "INVALID_MODEL_OUTPUT",
      };
    }
    return {
      output: parsed.data,
      request,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      failureCode: null,
    };
  } catch (error: unknown) {
    return {
      output: null,
      request,
      inputTokens: 0,
      outputTokens: 0,
      failureCode: error instanceof AiProviderError ? error.code : "API_FAILED",
    };
  }
}

function resolveNonChangeOutcome(classifier: ClassifierPassResult): GovernedClassificationResult | null {
  const usage = emptyUsage();
  usage.classifierInputTokens = classifier.inputTokens;
  usage.classifierOutputTokens = classifier.outputTokens;
  usage.totalRequests = 1;
  const candidateClassificationIds = classifier.request.candidates.map((entry) => entry.classificationId);

  if (!classifier.output) {
    const invalid = classifier.failureCode === "INVALID_MODEL_OUTPUT";
    return {
      outcome: invalid ? "INVALID_OUTPUT" : "API_FAILED",
      proposedClassificationId: null,
      proposedCategoryId: null,
      classifier: null,
      verifier: null,
      candidateClassificationIds,
      classifierVerifierAgreement: null,
      failureCode: classifier.failureCode,
      usage,
    };
  }
  if (classifier.output.decision === "CHANGE") return null;
  return {
    outcome: classifier.output.decision === "KEEP" ? "KEEP" : "REVIEW",
    proposedClassificationId: null,
    proposedCategoryId: null,
    classifier: classifier.output,
    verifier: null,
    candidateClassificationIds,
    classifierVerifierAgreement: null,
    failureCode: null,
    usage,
  };
}

export async function runGovernedLlmClassification(input: {
  complaint: SanitizedClassificationComplaint;
  currentClassificationId: string | null;
  currentCategoryId: string | null;
  catalog: ClassificationSemanticCatalog;
  provider?: LlmStructuredProvider;
  model: string;
  timeoutMs: number;
  retry?: RetryOptions;
  topN?: number;
}): Promise<GovernedClassificationResult> {
  const classifier = await classifySanitizedComplaint(input);
  const nonChange = resolveNonChangeOutcome(classifier);
  if (nonChange) return nonChange;

  const targetId = classifier.output?.targetClassificationId;
  const targetCategoryId = classifier.output?.targetCategoryId;
  if (!targetId || !targetCategoryId) throw new Error("CLASSIFIER_CHANGE_TARGET_MISSING");
  const verifier = await verifyClassificationChange({
    request: classifier.request,
    proposedClassificationId: targetId,
    catalog: input.catalog,
    provider: input.provider,
    model: input.model,
    timeoutMs: input.timeoutMs,
    retry: input.retry,
  });
  const usage: LlmTokenUsage = {
    classifierInputTokens: classifier.inputTokens,
    classifierOutputTokens: classifier.outputTokens,
    verifierInputTokens: verifier.inputTokens,
    verifierOutputTokens: verifier.outputTokens,
    totalRequests: 2,
  };
  if (!verifier.output) {
    const invalid = verifier.failureCode === "INVALID_MODEL_OUTPUT";
    return {
      outcome: invalid ? "INVALID_OUTPUT" : "API_FAILED",
      proposedClassificationId: targetId,
      proposedCategoryId: targetCategoryId,
      classifier: classifier.output,
      verifier: null,
      candidateClassificationIds: classifier.request.candidates.map((entry) => entry.classificationId),
      classifierVerifierAgreement: null,
      failureCode: verifier.failureCode,
      usage,
    };
  }
  const agreement = verifier.output.verdict === "APPROVE_CHANGE" &&
    verifier.output.supportedClassificationId === targetId;
  return {
    outcome: agreement ? "CHANGE_CONFIRMED" : "REVIEW",
    proposedClassificationId: targetId,
    proposedCategoryId: targetCategoryId,
    classifier: classifier.output,
    verifier: verifier.output,
    candidateClassificationIds: classifier.request.candidates.map((entry) => entry.classificationId),
    classifierVerifierAgreement: agreement,
    failureCode: null,
    usage,
  };
}

export function sanitizeComplaintForClassification(
  complaint: ClassificationComplaintInput,
  sequence: number
): SanitizedClassificationComplaint {
  return sanitizeClassificationComplaint(complaint, `C${String(sequence).padStart(6, "0")}`);
}

export function computeLlmClassificationCacheKey(input: {
  complaint: SanitizedClassificationComplaint;
  currentClassificationId: string | null;
  currentCategoryId: string | null;
  candidateClassificationIds: readonly string[];
  model: string;
  taxonomyFingerprint: string;
  semanticCatalogFingerprint: string;
}): string {
  const payload = {
    complaint: {
      sourceDetail: input.complaint.sourceDetail,
      subject: input.complaint.subject,
      description: input.complaint.description,
    },
    currentClassificationId: input.currentClassificationId,
    currentCategoryId: input.currentCategoryId,
    candidates: [...input.candidateClassificationIds].sort(
      (left, right) => left.localeCompare(right, "en")
    ),
    model: input.model,
    promptVersion: LLM_CLASSIFICATION_PROMPT_VERSION,
    taxonomyFingerprint: input.taxonomyFingerprint,
    semanticCatalogFingerprint: input.semanticCatalogFingerprint,
  };
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}
