// Security and stub-removal tests for Phase 8 AI routes.
// These tests verify no fake/mock responses are returned and security controls work.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth guard
vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue(undefined),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

// Mock env for AI disabled state
vi.mock("@/lib/env", () => ({
  env: {
    aiEnabled: false,
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    aiMaxInputComplaints: 500,
    aiMaxInputChars: 120000,
    aiDailyRunLimit: 20,
    aiRetentionDays: 90,
    aiRequestTimeoutSeconds: 60,
  },
}));

describe("AI Disabled state", () => {
  it("GET /api/ai/status returns enabled=false when AI disabled", async () => {
    const { GET } = await import("./status/route");
    const req = new Request("http://localhost/api/ai/status");
    const res = await GET(req as Parameters<typeof GET>[0]);
    const json = await res.json() as { enabled: boolean };
    expect(res.status).toBe(200);
    expect(json.enabled).toBe(false);
    expect(json).not.toHaveProperty("openAiApiKey");
    expect(JSON.stringify(json)).not.toMatch(/sk-/);
  });

  it("POST /api/ai/analyses returns 503 AI_DISABLED when AI off", async () => {
    const { POST } = await import("./analyses/route");
    const req = new Request("http://localhost/api/ai/analyses", {
      method: "POST",
      body: JSON.stringify({ analysisType: "EXECUTIVE_SUMMARY" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("AI_DISABLED");
  });

  it("POST /api/ai/analyze returns 503 not 501 when AI disabled", async () => {
    const { POST } = await import("./analyze/route");
    const req = new Request("http://localhost/api/ai/analyze", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    // Must not return fake success
    expect(json.error).not.toBe("success");
    expect(json.error).not.toBe("AI_NOT_CONFIGURED");
  });

  it("POST /api/ai/summary returns 503 not 501 when AI disabled", async () => {
    const { POST } = await import("./summary/route");
    const req = new Request("http://localhost/api/ai/summary", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/ai/analyses — strict pagination parsing", () => {
  // Mock db to avoid real DB in unit tests
  vi.mock("@/lib/db", () => ({
    db: {
      aiAnalysisRun: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    },
  }));

  vi.mock("@/server/audit/audit-log-service", () => ({
    writeAuditLog: vi.fn().mockResolvedValue(undefined),
    AUDIT_ACTOR_SINGLE_ADMIN: "system",
  }));

  const validCases: Array<[string, string, number, number]> = [
    ["default values", "", 1, 20],
    ["explicit page 2", "page=2", 2, 20],
    ["explicit pageSize 10", "pageSize=10", 1, 10],
    ["max pageSize 50", "pageSize=50", 1, 50],
    ["max page 10000", "page=10000", 10000, 20],
  ];

  for (const [label, qs, expectedPage, expectedPageSize] of validCases) {
    it(`accepts ${label}`, async () => {
      const { GET } = await import("./analyses/route");
      const url = `http://localhost/api/ai/analyses${qs ? `?${qs}` : ""}`;
      const req = new Request(url);
      const res = await GET(req as Parameters<typeof GET>[0]);
      expect(res.status).toBe(200);
      const json = await res.json() as { page: number; pageSize: number };
      expect(json.page).toBe(expectedPage);
      expect(json.pageSize).toBe(expectedPageSize);
    });
  }

  const invalidCases: Array<[string, string]> = [
    ["decimal page", "page=1.5"],
    ["negative page", "page=-1"],
    ["zero page", "page=0"],
    ["non-numeric page", "page=abc"],
    ["page too large", "page=99999"],
    ["pageSize too large", "pageSize=51"],
    ["pageSize zero", "pageSize=0"],
  ];

  for (const [label, qs] of invalidCases) {
    it(`rejects ${label}`, async () => {
      const { GET } = await import("./analyses/route");
      const url = `http://localhost/api/ai/analyses?${qs}`;
      const req = new Request(url);
      const res = await GET(req as Parameters<typeof GET>[0]);
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toBe("INVALID_PAGINATION");
    });
  }
});

describe("No stub responses", () => {
  it("No route returns 501 Not Implemented", async () => {
    // Import key routes and check they do not return 501
    const routes = [
      import("./analyze/route").then(m => m.POST),
      import("./summary/route").then(m => m.POST),
      import("./status/route").then(m => m.GET),
    ];

    for (const routePromise of routes) {
      const handler = await routePromise;
      const req = new Request("http://localhost/test", { method: "GET", body: null });
      const res = await handler(req as Parameters<typeof handler>[0]);
      expect(res.status).not.toBe(501);
    }
  });

  it("AI status response does not expose API key", async () => {
    const { GET } = await import("./status/route");
    const req = new Request("http://localhost/api/ai/status");
    const res = await GET(req as Parameters<typeof GET>[0]);
    const text = await res.text();
    expect(text).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(text).not.toContain("openAiApiKey");
    expect(text).not.toContain("OPENAI_API_KEY");
  });

  it("Analyses endpoint response does not expose stack trace", async () => {
    const { POST } = await import("./analyses/route");
    const req = new Request("http://localhost/api/ai/analyses", {
      method: "POST",
      body: JSON.stringify({ analysisType: "INVALID_TYPE" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    const text = await res.text();
    expect(text).not.toContain("at Object.");
    expect(text).not.toContain("node_modules");
    expect(res.status).not.toBe(200); // Must not pretend success
  });
});
