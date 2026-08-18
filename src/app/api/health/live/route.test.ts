import { describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/db", () => ({ db: { $queryRaw: queryRaw } }));

const accessSync = vi.fn();
vi.mock("node:fs", () => {
  const mod = { accessSync, constants: { R_OK: 4, W_OK: 2 } };
  return { ...mod, default: mod };
});

/**
 * Liveness is on the unauthenticated allowlist (src/proxy.ts) — spec §5:
 * it must stay a trivial, side-effect-free probe (no DB, no filesystem, no
 * network) so it can never itself become the thing that's unavailable.
 */
describe("GET /api/health/live", () => {
  it("returns 200 with a minimal { status: 'live' } body", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "live" });
  });

  it("never touches the database", async () => {
    const { GET } = await import("./route");
    await GET();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("never touches the filesystem", async () => {
    const { GET } = await import("./route");
    await GET();
    expect(accessSync).not.toHaveBeenCalled();
  });

  it("body never contains secrets, paths, hostnames, versions, or a commit SHA — a fixed, minimal shape", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["status"]);
  });
});
