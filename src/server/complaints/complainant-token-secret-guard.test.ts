import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `complainant-token.ts`'s production secret guard (spec §14) — split into
 * its own file from `complainant-token.test.ts` because every case here
 * needs a DIFFERENT mocked `@/lib/env`, which requires `vi.resetModules()`
 * + a fresh dynamic import per case (the same pattern `report-storage.test.ts`
 * uses); mixing that into the encode/decode round-trip tests, which rely on
 * the real test-env default, would make those brittle to reorder.
 */

function mockEnv(overrides: { nodeEnv: "development" | "test" | "production"; complainantTokenSecret?: string }) {
  vi.doMock("@/lib/env", () => ({
    env: {
      nodeEnv: overrides.nodeEnv,
      complainantTokenSecret: overrides.complainantTokenSecret,
    },
  }));
}

afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.resetModules();
});

describe("getComplainantTokenSecret — production guard", () => {
  it("throws in production when COMPLAINANT_TOKEN_SECRET is not set", async () => {
    mockEnv({ nodeEnv: "production", complainantTokenSecret: undefined });
    const { getComplainantTokenSecret } = await import("./complainant-token");
    expect(() => getComplainantTokenSecret()).toThrow(/COMPLAINANT_TOKEN_SECRET is required/);
  });

  it("throws in production when COMPLAINANT_TOKEN_SECRET is shorter than 32 characters", async () => {
    mockEnv({ nodeEnv: "production", complainantTokenSecret: "too-short" });
    const { getComplainantTokenSecret } = await import("./complainant-token");
    expect(() => getComplainantTokenSecret()).toThrow(/at least 32 characters/);
  });

  it("never falls back to the fixed dev/test secret in production, even implicitly", async () => {
    mockEnv({ nodeEnv: "production", complainantTokenSecret: undefined });
    const { getComplainantTokenSecret } = await import("./complainant-token");
    expect(() => getComplainantTokenSecret()).toThrow();
    // The throw itself IS the guarantee — if this ever silently returned the
    // dev/test fallback instead, encode/decode would still "work" in
    // production on a well-known, publicly-visible secret.
  });

  it("succeeds in production with a properly configured 32+ character secret", async () => {
    mockEnv({ nodeEnv: "production", complainantTokenSecret: "a".repeat(32) });
    const { getComplainantTokenSecret } = await import("./complainant-token");
    expect(getComplainantTokenSecret()).toBe("a".repeat(32));
  });

  it("falls back to the fixed dev/test secret outside production when unset", async () => {
    mockEnv({ nodeEnv: "test", complainantTokenSecret: undefined });
    const { getComplainantTokenSecret } = await import("./complainant-token");
    expect(() => getComplainantTokenSecret()).not.toThrow();
    expect(getComplainantTokenSecret().length).toBeGreaterThanOrEqual(32);
  });

  it("a token encoded under one secret fails closed (does not decode) under a different secret", async () => {
    mockEnv({ nodeEnv: "production", complainantTokenSecret: "a".repeat(32) });
    const modA = await import("./complainant-token");
    const token = modA.encodeComplainantToken("1082536010");

    vi.doUnmock("@/lib/env");
    vi.resetModules();
    mockEnv({ nodeEnv: "production", complainantTokenSecret: "b".repeat(32) });
    const modB = await import("./complainant-token");
    expect(modB.decodeComplainantToken(token)).toBeNull();
  });

  it("never logs the secret value itself when the guard throws", async () => {
    mockEnv({ nodeEnv: "production", complainantTokenSecret: undefined });
    const { getComplainantTokenSecret } = await import("./complainant-token");
    try {
      getComplainantTokenSecret();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).not.toContain("secret");
      expect((e as Error).message).toBe("COMPLAINANT_TOKEN_SECRET is required in production.");
    }
  });
});
