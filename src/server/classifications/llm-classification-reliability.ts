import { AiProviderError } from "@/server/ai/openai-provider";

export const DEFAULT_LLM_MAX_ATTEMPTS = 3;
export const DEFAULT_LLM_CONCURRENCY = 3;

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const TRANSIENT_CODES = new Set([
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "NETWORK_ERROR",
]);

export function isTransientAiError(error: unknown): boolean {
  return error instanceof AiProviderError && TRANSIENT_CODES.has(error.code);
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function withBoundedAiRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_LLM_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 1;

  while (true) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= maxAttempts || !isTransientAiError(error)) throw error;
      await sleep(baseDelayMs * (2 ** (attempt - 1)));
      attempt += 1;
    }
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("LLM_CONCURRENCY_INVALID");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
