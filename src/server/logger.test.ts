import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "./logger";

describe("logger — sensitive key redaction", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const sensitiveKeys = [
    "key", "secret", "password", "token", "hash",
    "cookie", "authorization", "credential", "apikey",
    "openAiApiKey", "AUTH_SECRET", "sessionToken",
  ];

  for (const keyName of sensitiveKeys) {
    it(`redacts meta key: ${keyName}`, () => {
      logger.info("test message", { [keyName]: "super-secret-value" });
      const output = written.join("");
      expect(output).not.toContain("super-secret-value");
      expect(output).toContain("[REDACTED]");
    });
  }

  it("does not redact safe meta keys", () => {
    logger.info("test", { userId: "u1", action: "login", count: 5 });
    const output = written.join("");
    const record = JSON.parse(output) as { metadata: Record<string, unknown> };
    expect(record.metadata.userId).toBe("u1");
    expect(record.metadata.action).toBe("login");
    expect(record.metadata.count).toBe(5);
  });

  it("includes level, message, and timestamp in production output", () => {
    logger.warn("something happened", { status: "degraded" });
    const record = JSON.parse(written.join("")) as {
      level: string; message: string; timestamp: string; metadata: Record<string, unknown>;
    };
    expect(record.level).toBe("warn");
    expect(record.message).toBe("something happened");
    expect(typeof record.timestamp).toBe("string");
    expect(record.metadata.status).toBe("degraded");
  });

  it("does not allow metadata to override level, message, or timestamp", () => {
    logger.info("real message", { level: "error", message: "injected", timestamp: "1970" });
    const record = JSON.parse(written.join("")) as Record<string, unknown>;
    expect(record.level).toBe("info");
    expect(record.message).toBe("real message");
    expect(record.timestamp).not.toBe("1970");
  });

  it("handles nested object redaction", () => {
    logger.info("test", { nested: { apikey: "should-be-redacted", safe: "visible" } });
    const output = written.join("");
    expect(output).not.toContain("should-be-redacted");
    expect(output).toContain("visible");
  });

  it("handles circular reference without throwing", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => logger.info("test", obj)).not.toThrow();
    const output = written.join("");
    expect(output).toContain("[circular]");
  });
});
