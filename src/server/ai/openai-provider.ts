// OpenAI provider adapter. Decoupled from analysis logic.

import OpenAI from "openai";
import { env } from "@/lib/env";
import { logger } from "@/server/logger";

export class AiProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const key = env.openAiApiKey;
    if (!key) {
      throw new AiProviderError("AI_KEY_MISSING", "OpenAI API key is not configured.");
    }
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

export interface ProviderCallOptions {
  model: string;
  prompt: string;
  systemMessage: string;
  timeoutMs: number;
  maxOutputTokens?: number;
}

export interface ProviderCallResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface StructuredProviderCallOptions {
  model: string;
  input: string;
  instructions: string;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputTokens?: number;
}

export interface StructuredProviderCallResult {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

type StructuredResponsesClient = Pick<OpenAI, "responses">;

function logProviderFailure(code: string, status: number | undefined): void {
  // Log the failure category but never the API key or raw prompt
  logger.error("OpenAI provider failure", { code, status: status ?? "unknown" });
}

function classifyApiError(err: unknown): AiProviderError {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    logProviderFailure("TIMEOUT", undefined);
    return new AiProviderError("TIMEOUT", "AI request timed out.");
  }
  if (err instanceof OpenAI.APIConnectionError) {
    logProviderFailure("NETWORK_ERROR", undefined);
    return new AiProviderError("NETWORK_ERROR", "AI provider network error.");
  }
  // Handle SDK user-abort first (SDK wraps it before it looks like a network error)
  if (err instanceof OpenAI.APIUserAbortError) {
    logProviderFailure("TIMEOUT", undefined);
    return new AiProviderError("TIMEOUT", "AI request timed out.");
  }

  const apiErr = err as { status?: number; code?: string; message?: string };
  const status = apiErr?.status;

  if (status === 429) {
    logProviderFailure("RATE_LIMITED", status);
    return new AiProviderError("RATE_LIMITED", "AI provider rate limit exceeded.");
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    logProviderFailure("PROVIDER_UNAVAILABLE", status);
    return new AiProviderError("PROVIDER_UNAVAILABLE", `AI provider error (${status}).`);
  }
  if (status === 401 || status === 403) {
    logProviderFailure("AUTH_ERROR", status);
    return new AiProviderError("AUTH_ERROR", "AI provider authentication failed.");
  }
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN"].includes(apiErr.code ?? "")) {
    logProviderFailure("NETWORK_ERROR", status);
    return new AiProviderError("NETWORK_ERROR", "AI provider network error.");
  }

  // Generic fallback — never log the message as it may contain prompt fragments
  logProviderFailure("PROVIDER_ERROR", status);
  return new AiProviderError("PROVIDER_ERROR", "AI provider error.");
}

export async function callOpenAI(options: ProviderCallOptions): Promise<ProviderCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: options.model,
        messages: [
          { role: "system", content: options.systemMessage },
          { role: "user", content: options.prompt },
        ],
        max_tokens: options.maxOutputTokens ?? 4096,
        temperature: 0.2,
        response_format: { type: "json_object" },
      },
      {
        signal: controller.signal,
        timeout: options.timeoutMs,
      }
    );

    const text = response.choices[0]?.message?.content ?? "";
    return {
      text,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      model: response.model,
    };
  } catch (err: unknown) {
    // AbortError from our own controller — treat same as SDK abort
    if (err instanceof Error && err.name === "AbortError") {
      logProviderFailure("TIMEOUT", undefined);
      throw new AiProviderError("TIMEOUT", "AI request timed out.");
    }
    throw classifyApiError(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stateless Responses API adapter for strict structured output. It deliberately
 * omits tools, conversation state, background execution, metadata, and raw-log
 * hooks. Runtime schema validation remains the caller's responsibility.
 */
export async function callOpenAIStructured(
  options: StructuredProviderCallOptions
): Promise<StructuredProviderCallResult> {
  return callOpenAIStructuredWithClient(getClient(), options);
}

export async function callOpenAIStructuredWithClient(
  client: StructuredResponsesClient,
  options: StructuredProviderCallOptions
): Promise<StructuredProviderCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await client.responses.create(
      {
        model: options.model,
        instructions: options.instructions,
        input: options.input,
        store: false,
        max_output_tokens: options.maxOutputTokens ?? 1_024,
        text: {
          format: {
            type: "json_schema",
            name: options.schemaName,
            strict: true,
            schema: options.schema,
          },
        },
      },
      {
        signal: controller.signal,
        timeout: options.timeoutMs,
      }
    );

    return {
      output: JSON.parse(response.output_text),
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      model: response.model,
    };
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      logProviderFailure("INVALID_STRUCTURED_OUTPUT", undefined);
      throw new AiProviderError(
        "INVALID_STRUCTURED_OUTPUT",
        "AI provider returned invalid structured output."
      );
    }
    if (err instanceof Error && err.name === "AbortError") {
      logProviderFailure("TIMEOUT", undefined);
      throw new AiProviderError("TIMEOUT", "AI request timed out.");
    }
    if (err instanceof AiProviderError) throw err;
    throw classifyApiError(err);
  } finally {
    clearTimeout(timer);
  }
}
