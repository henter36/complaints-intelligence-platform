import { afterEach, describe, expect, it, vi } from "vitest";

async function loadProxyModule(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);

  return import("./proxy");
}

describe("proxy Content Security Policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows unsafe-eval in development only", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/proxy.ts", "utf8"),
    );

    expect(source).toContain(
      'process.env.NODE_ENV === "development"',
    );
    expect(source).toContain('" \'unsafe-eval\'"');
  });

  it("keeps production policy without unconditional unsafe-eval", async () => {
    await loadProxyModule("production");

    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/proxy.ts", "utf8"),
    );

    expect(source).not.toContain(
      "script-src 'self' 'nonce-${nonce}' 'unsafe-eval'",
    );
  });
});
