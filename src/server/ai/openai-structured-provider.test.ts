import { describe, expect, it, vi } from "vitest";
import { callOpenAIStructuredWithClient } from "./openai-provider";
import { logger } from "@/server/logger";

describe("OpenAI structured Responses adapter", () => {
  it("parses completed valid JSON using strict schema without stateful features", async () => {
    const create = vi.fn().mockResolvedValue({
      status: "completed",
      incomplete_details: null,
      output: [],
      output_text: JSON.stringify({ decision: "REVIEW" }),
      usage: { input_tokens: 7, output_tokens: 3 },
      model: "configured-model",
    });
    const client = { responses: { create } } as unknown as Parameters<
      typeof callOpenAIStructuredWithClient
    >[0];
    const result = await callOpenAIStructuredWithClient(client, {
      model: "configured-model",
      input: "sanitized input",
      instructions: "instructions",
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false },
      timeoutMs: 1_000,
    });
    const request = create.mock.calls[0][0];
    expect(request.store).toBe(false);
    expect(request.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("previous_response_id");
    expect(request).not.toHaveProperty("background");
    expect(request).not.toHaveProperty("metadata");
    expect(result).toMatchObject({ inputTokens: 7, outputTokens: 3, model: "configured-model" });
  });

  it.each([
    ["incomplete", null, "AI_RESPONSE_INCOMPLETE"],
    ["max output token incomplete", { reason: "max_output_tokens" }, "AI_RESPONSE_TRUNCATED"],
  ])("classifies %s before parsing", async (_label, incompleteDetails, expectedCode) => {
    const create = vi.fn().mockResolvedValue({
      status: "incomplete",
      incomplete_details: incompleteDetails,
      output: [],
      output_text: "",
      usage: { input_tokens: 7, output_tokens: 3 },
      model: "configured-model",
    });
    const client = { responses: { create } } as unknown as Parameters<
      typeof callOpenAIStructuredWithClient
    >[0];

    await expect(callOpenAIStructuredWithClient(client, {
      model: "configured-model",
      input: "sanitized input",
      instructions: "instructions",
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false },
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: expectedCode });
  });

  it("classifies refusal output before parsing", async () => {
    const create = vi.fn().mockResolvedValue({
      status: "completed",
      incomplete_details: null,
      output: [{
        type: "message",
        content: [{ type: "refusal", refusal: "refused" }],
      }],
      output_text: "",
      usage: { input_tokens: 7, output_tokens: 3 },
      model: "configured-model",
    });
    const client = { responses: { create } } as unknown as Parameters<
      typeof callOpenAIStructuredWithClient
    >[0];

    await expect(callOpenAIStructuredWithClient(client, {
      model: "configured-model",
      input: "sanitized input",
      instructions: "instructions",
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false },
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "AI_RESPONSE_REFUSED" });
  });

  it.each([
    ["empty output", ""],
    ["malformed JSON", "{not-json"],
  ])("reports completed %s as invalid structured output", async (_label, outputText) => {
    const create = vi.fn().mockResolvedValue({
      status: "completed",
      incomplete_details: null,
      output: [],
      output_text: outputText,
      usage: { input_tokens: 7, output_tokens: 3 },
      model: "configured-model",
    });
    const client = { responses: { create } } as unknown as Parameters<
      typeof callOpenAIStructuredWithClient
    >[0];

    await expect(callOpenAIStructuredWithClient(client, {
      model: "configured-model",
      input: "sanitized input",
      instructions: "instructions",
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false },
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "INVALID_STRUCTURED_OUTPUT" });
  });

  it("logs only safe error metadata and never provider messages or secrets", async () => {
    const rawSecret = "sk-secret-that-must-not-appear";
    const create = vi.fn().mockRejectedValue(Object.assign(
      new Error(`authentication failed for ${rawSecret} with raw complaint text`),
      { status: 401 }
    ));
    const client = { responses: { create } } as unknown as Parameters<
      typeof callOpenAIStructuredWithClient
    >[0];
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await expect(callOpenAIStructuredWithClient(client, {
      model: "configured-model",
      input: "raw complaint text",
      instructions: "instructions",
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false },
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "AUTH_ERROR" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(log.mock.calls)).not.toContain("raw complaint text");
    log.mockRestore();
  });
});
