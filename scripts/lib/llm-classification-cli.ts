import { resolve } from "node:path";
import { env } from "@/lib/env";
import type {
  ClassificationSemanticCatalog,
  LlmStructuredProvider,
} from "@/server/classifications/llm-classification-contract";
import {
  LLM_CLASSIFICATION_LOCAL_ROOT,
  readLlmClassificationJson,
} from "@/server/classifications/llm-classification-artifacts";
import { assertLlmClassificationRuntimeEnabled } from "@/server/classifications/llm-classification-service";
import { callOpenAIStructured } from "@/server/ai/openai-provider";

export function parseCliArguments(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error("LLM_CLASSIFICATION_CLI_ARGUMENT_INVALID");
    const [rawKey, ...rawValue] = argument.slice(2).split("=");
    values.set(rawKey, rawValue.length === 0 ? "true" : rawValue.join("="));
  }
  return values;
}

export function positiveIntegerArgument(
  args: ReadonlyMap<string, string>,
  name: string,
  fallback: number
): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`LLM_CLASSIFICATION_${name.toUpperCase()}_INVALID`);
  return value;
}

export function localArtifactPath(name: string): string {
  return resolve(LLM_CLASSIFICATION_LOCAL_ROOT, name);
}

export function loadSemanticCatalog(path?: string): ClassificationSemanticCatalog {
  return readLlmClassificationJson<ClassificationSemanticCatalog>(
    path ?? localArtifactPath("semantic-catalog-draft.json")
  );
}

export function enabledClassificationProvider(): LlmStructuredProvider | undefined {
  if (!env.aiEnabled) return undefined;
  assertLlmClassificationRuntimeEnabled();
  return callOpenAIStructured;
}

export function requiredClassificationProvider(): LlmStructuredProvider {
  assertLlmClassificationRuntimeEnabled();
  return callOpenAIStructured;
}

export function safeCliError(error: unknown): string {
  if (!(error instanceof Error)) return "LLM_CLASSIFICATION_OPERATION_FAILED";
  const allowed = /^[A-Z0-9_:-]+$/;
  return allowed.test(error.message) ? error.message : "LLM_CLASSIFICATION_OPERATION_FAILED";
}
