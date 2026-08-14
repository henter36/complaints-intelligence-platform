import { AiProviderError, callOpenAIStructured } from "@/server/ai/openai-provider";
import {
  VERIFIER_JSON_SCHEMA,
  verifierOutputSchema,
  type ClassificationRequest,
  type ClassificationSemanticCatalog,
  type LlmStructuredProvider,
  type VerifierOutput,
} from "./llm-classification-contract";
import { buildVerifierInput, verifierInstructions } from "./llm-classification-prompt";
import { withBoundedAiRetry, type RetryOptions } from "./llm-classification-reliability";

export type VerifierPassResult = {
  output: VerifierOutput | null;
  inputTokens: number;
  outputTokens: number;
  failureCode: string | null;
};

function validateSupportedClassification(input: {
  output: VerifierOutput;
  request: ClassificationRequest;
  catalog: ClassificationSemanticCatalog;
}): boolean {
  const id = input.output.supportedClassificationId;
  if (id === null) return input.output.verdict !== "APPROVE_CHANGE";
  const candidateIds = new Set(input.request.candidates.map((entry) => entry.classificationId));
  return candidateIds.has(id) && input.catalog.entries.some((entry) => entry.classificationId === id);
}

export async function verifyClassificationChange(input: {
  request: ClassificationRequest;
  proposedClassificationId: string;
  catalog: ClassificationSemanticCatalog;
  provider?: LlmStructuredProvider;
  model: string;
  timeoutMs: number;
  retry?: RetryOptions;
}): Promise<VerifierPassResult> {
  const proposed = input.catalog.entries.find(
    (entry) => entry.classificationId === input.proposedClassificationId
  );
  if (!proposed) return { output: null, inputTokens: 0, outputTokens: 0, failureCode: "INVALID_MODEL_OUTPUT" };
  const current = input.catalog.entries.find(
    (entry) => entry.classificationId === input.request.currentClassificationId
  );
  const provider = input.provider ?? callOpenAIStructured;

  try {
    const response = await withBoundedAiRetry(() => provider({
      model: input.model,
      instructions: verifierInstructions(),
      input: buildVerifierInput({ request: input.request, current, proposed }),
      schemaName: "historical_classification_verifier",
      schema: VERIFIER_JSON_SCHEMA,
      timeoutMs: input.timeoutMs,
      maxOutputTokens: 600,
    }), input.retry);
    const parsed = verifierOutputSchema.safeParse(response.output);
    if (!parsed.success || !validateSupportedClassification({
      output: parsed.data,
      request: input.request,
      catalog: input.catalog,
    })) {
      return {
        output: null,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        failureCode: "INVALID_MODEL_OUTPUT",
      };
    }
    return {
      output: parsed.data,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      failureCode: null,
    };
  } catch (error: unknown) {
    return {
      output: null,
      inputTokens: 0,
      outputTokens: 0,
      failureCode: error instanceof AiProviderError ? error.code : "API_FAILED",
    };
  }
}
