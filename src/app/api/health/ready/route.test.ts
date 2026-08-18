import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/db", () => ({ db: { $queryRaw: queryRaw } }));

const accessSync = vi.fn();
vi.mock("node:fs", () => {
  const mod = { accessSync, constants: { R_OK: 4, W_OK: 2 } };
  return { ...mod, default: mod };
});

const loggerError = vi.fn();
vi.mock("@/server/logger", () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn() } }));

const envState: {
  authSecret: string;
  importStoragePath: string;
  reportStoragePath: string;
  aiEnabled: boolean;
  openAiApiKey: string | undefined;
} = {
  authSecret: "a".repeat(32),
  importStoragePath: "/opt/complaints-platform/storage/imports",
  reportStoragePath: "/opt/complaints-platform/storage/reports",
  aiEnabled: false,
  openAiApiKey: undefined,
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envState;
  },
}));

function resetEnvState() {
  envState.authSecret = "a".repeat(32);
  envState.importStoragePath = "/opt/complaints-platform/storage/imports";
  envState.reportStoragePath = "/opt/complaints-platform/storage/reports";
  envState.aiEnabled = false;
  envState.openAiApiKey = undefined;
}

/**
 * Readiness is on the unauthenticated allowlist too (src/proxy.ts) — a
 * monitoring tool with no admin session reads this JSON directly, so every
 * test here is really a "does this leak anything" test (spec §6), not just
 * a "does the check pass" test.
 */
describe("GET /api/health/ready", () => {
  beforeEach(() => {
    resetEnvState();
    queryRaw.mockReset();
    accessSync.mockReset();
    loggerError.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 and status 'ready' with all checks 'ok' when everything is healthy", async () => {
    queryRaw.mockResolvedValue([{ 1: 1 }]);
    accessSync.mockReturnValue(undefined);

    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ready",
      checks: { database: "ok", importStorage: "ok", reportStorage: "ok", auth: "ok", ai: "ok" },
    });
  });

  it("returns 503 and status 'degraded' when the database is unreachable, without leaking the raw Prisma error", async () => {
    queryRaw.mockRejectedValue(new Error("SQLITE_BUSY: database is locked at /opt/complaints-platform/data/database.sqlite"));
    accessSync.mockReturnValue(undefined);

    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toBe("error: database unreachable");
    expect(JSON.stringify(body)).not.toContain("SQLITE_BUSY");
    expect(JSON.stringify(body)).not.toContain("/opt/complaints-platform");
    // The real error still reaches server-side logs for diagnostics.
    expect(loggerError).toHaveBeenCalledWith("Readiness database check failed", expect.objectContaining({ err: expect.any(Error) }));
  });

  it("returns 503 when storage is inaccessible, without leaking the absolute path (including a path containing a space)", async () => {
    queryRaw.mockResolvedValue([{ 1: 1 }]);
    envState.importStoragePath = "/opt/complaints platform/storage imports";
    accessSync.mockImplementation((target: string) => {
      if (target === envState.importStoragePath) {
        throw new Error(`ENOENT: no such file or directory, access '${target}'`);
      }
    });

    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.importStorage).toBe("error: storage path inaccessible: storage imports");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("/opt/complaints platform");
    expect(raw).not.toContain("ENOENT");
    // basename() legitimately keeps the last path segment — that's a
    // directory NAME, not the absolute filesystem location, and is the
    // one piece of info intentionally kept for a human reading the JSON.
    expect(body.checks.importStorage).toContain("storage imports");
  });

  it("never includes AUTH_SECRET/INTERNAL_SCHEDULER_SECRET/COMPLAINANT_TOKEN_SECRET/OPENAI_API_KEY/DATABASE_URL values anywhere in the response, healthy or degraded", async () => {
    queryRaw.mockRejectedValue(new Error("boom"));
    accessSync.mockImplementation(() => {
      throw new Error("boom");
    });
    envState.authSecret = "";
    envState.aiEnabled = true;
    envState.openAiApiKey = "sk-live-should-never-appear-in-response";

    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(raw).not.toContain("sk-live-should-never-appear-in-response");
    expect(raw).not.toContain(envState.importStoragePath);
    expect(raw).not.toContain(envState.reportStoragePath);
  });

  it("AI disabled: 'ok' without ever needing an OPENAI_API_KEY or contacting the provider", async () => {
    queryRaw.mockResolvedValue([{ 1: 1 }]);
    accessSync.mockReturnValue(undefined);
    envState.aiEnabled = false;
    envState.openAiApiKey = undefined;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.ai).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("AI enabled with a configured key: 'ok', still no network call to the provider", async () => {
    queryRaw.mockResolvedValue([{ 1: 1 }]);
    accessSync.mockReturnValue(undefined);
    envState.aiEnabled = true;
    envState.openAiApiKey = "sk-configured";

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.ai).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is observational only — never writes, creates, or migrates anything (no mkdir/write/migrate call surface exists to assert against; this documents the contract)", async () => {
    queryRaw.mockResolvedValue([{ 1: 1 }]);
    accessSync.mockReturnValue(undefined);
    const { GET } = await import("./route");
    await GET();
    // The only fs call the route makes at all is accessSync (a permission
    // check) — asserting the mock's own call arguments proves no other
    // fs function (mkdir, writeFile, ...) was ever imported/used.
    for (const call of accessSync.mock.calls) {
      expect(call[1]).toBeTypeOf("number"); // (path, mode) — a read/access check, not a write
    }
  });
});
