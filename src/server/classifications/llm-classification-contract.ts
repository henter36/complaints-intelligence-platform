import { z } from "zod";
import type { SanitizedClassificationComplaint } from "@/server/ai/ai-data-sanitization-service";

export const LLM_CLASSIFICATION_PROMPT_VERSION = "1.0.0";
export const LLM_CLASSIFICATION_SCHEMA_VERSION = 1;
export const CHANGE_CONFIRMED_PRECISION_GATE = 0.98;

export const CLASSIFIER_DECISIONS = ["KEEP", "CHANGE", "REVIEW"] as const;
export const VERIFIER_VERDICTS = ["APPROVE_CHANGE", "REJECT_CHANGE", "REVIEW"] as const;
export const EVIDENCE_LEVELS = ["STRONG", "MODERATE", "WEAK"] as const;
export const FINAL_LLM_OUTCOMES = [
  "KEEP",
  "CHANGE_CONFIRMED",
  "REVIEW",
  "UNRESOLVED",
  "INVALID_OUTPUT",
  "API_FAILED",
] as const;

const shortReasonSchema = z.string().trim().min(1).max(300);
const reasonCodesSchema = z.array(z.string().trim().min(1).max(80)).max(8);

export const classifierOutputSchema = z.strictObject({
  decision: z.enum(CLASSIFIER_DECISIONS),
  targetClassificationId: z.string().min(1).nullable(),
  targetCategoryId: z.string().min(1).nullable(),
  evidenceLevel: z.enum(EVIDENCE_LEVELS),
  reasonCodes: reasonCodesSchema,
  shortReason: shortReasonSchema,
});

export const verifierOutputSchema = z.strictObject({
  verdict: z.enum(VERIFIER_VERDICTS),
  supportedClassificationId: z.string().min(1).nullable(),
  evidenceLevel: z.enum(EVIDENCE_LEVELS),
  reasonCodes: reasonCodesSchema,
  shortReason: shortReasonSchema,
});

export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;
export type VerifierOutput = z.infer<typeof verifierOutputSchema>;
export type FinalLlmOutcome = (typeof FINAL_LLM_OUTCOMES)[number];

export const CLASSIFIER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "targetClassificationId",
    "targetCategoryId",
    "evidenceLevel",
    "reasonCodes",
    "shortReason",
  ],
  properties: {
    decision: { type: "string", enum: CLASSIFIER_DECISIONS },
    targetClassificationId: { type: ["string", "null"] },
    targetCategoryId: { type: ["string", "null"] },
    evidenceLevel: { type: "string", enum: EVIDENCE_LEVELS },
    reasonCodes: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 80 },
    },
    shortReason: { type: "string", minLength: 1, maxLength: 300 },
  },
};

export const VERIFIER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "supportedClassificationId",
    "evidenceLevel",
    "reasonCodes",
    "shortReason",
  ],
  properties: {
    verdict: { type: "string", enum: VERIFIER_VERDICTS },
    supportedClassificationId: { type: ["string", "null"] },
    evidenceLevel: { type: "string", enum: EVIDENCE_LEVELS },
    reasonCodes: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 80 },
    },
    shortReason: { type: "string", minLength: 1, maxLength: 300 },
  },
};

export type SemanticCatalogEntry = {
  classificationId: string;
  classificationName: string;
  categoryId: string;
  categoryName: string;
  keywords: string[];
  semanticDefinition: string | null;
  includedConcepts: string[];
  excludedConcepts: string[];
  confusableWith: string[];
  status: "DRAFT_REQUIRES_REVIEW";
  generationStatus: "GENERATED_BY_LLM" | "PENDING_LLM_ENRICHMENT";
};

export type ClassificationSemanticCatalog = {
  schemaVersion: number;
  status: "DRAFT_REQUIRES_REVIEW";
  generatedAt: string;
  model: string | null;
  taxonomyFingerprint: string;
  semanticCatalogFingerprint: string;
  categoryCount: number;
  classificationCount: number;
  entries: SemanticCatalogEntry[];
};

export type CandidateClassification = SemanticCatalogEntry & {
  retrievalScore: number;
  retrievalReasons: string[];
};

export type StructuredProviderRequest = {
  model: string;
  input: string;
  instructions: string;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputTokens?: number;
};

export type StructuredProviderResponse = {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export type LlmStructuredProvider = (
  request: StructuredProviderRequest
) => Promise<StructuredProviderResponse>;

export type LlmTokenUsage = {
  classifierInputTokens: number;
  classifierOutputTokens: number;
  verifierInputTokens: number;
  verifierOutputTokens: number;
  totalRequests: number;
};

export type ClassificationRequest = {
  complaint: SanitizedClassificationComplaint;
  currentClassificationId: string | null;
  currentCategoryId: string | null;
  candidates: CandidateClassification[];
};

export type GovernedClassificationResult = {
  outcome: FinalLlmOutcome;
  proposedClassificationId: string | null;
  proposedCategoryId: string | null;
  classifier: ClassifierOutput | null;
  verifier: VerifierOutput | null;
  candidateClassificationIds: string[];
  classifierVerifierAgreement: boolean | null;
  failureCode: string | null;
  usage: LlmTokenUsage;
};
