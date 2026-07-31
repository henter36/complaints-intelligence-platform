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

function logProviderFailure(code: string, status: number | undefined): void {
  // Log the failure category but never the API key or raw prompt
  logger.error("OpenAI provider failure", { code, status: status ?? "unknown" });
}

function classifyApiError(err: unknown): AiProviderError {
  // Handle SDK user-abort first (SDK wraps it before it looks like a network error)
  if (err instanceof OpenAI.APIUserAbortError) {
    logProviderFailure("TIMEOUT", undefined);
    return new AiProviderError("TIMEOUT", "AI request timed out.");
  }

  const apiErr = err as { status?: number; message?: string };
  const status = apiErr?.status;

  if (status === 429) {
    logProviderFailure("RATE_LIMITED", status);
    return new AiProviderError("RATE_LIMITED", "AI provider rate limit exceeded.");
  }
  if (status === 500 || status === 502 || status === 503) {
    logProviderFailure("PROVIDER_UNAVAILABLE", status);
    return new AiProviderError("PROVIDER_UNAVAILABLE", `AI provider error (${status}).`);
  }
  if (status === 401 || status === 403) {
    logProviderFailure("AUTH_ERROR", status);
    return new AiProviderError("AUTH_ERROR", "AI provider authentication failed.");
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
