// @vitest-environment node
import { NextRequest } from "next/server";
import { ReportFormat, ReportType } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/db");
  vi.doUnmock("@/server/auth/auth-guard");
  vi.doUnmock("@/server/reports/report-export-service");
  vi.doUnmock("@/server/reports/report-template-service");
  vi.doUnmock("@/lib/env");
});

function mockAuthenticated() {
  vi.doMock("@/server/auth/auth-guard", () => ({
    requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_1", username: "admin" }),
    mapAuthError: vi.fn().mockReturnValue(null),
  }));
}

function mockUnauthenticated() {
  vi.doMock("@/server/auth/auth-guard", async () => {
    const actual = await vi.importActual<typeof import("@/server/auth/auth-guard")>("@/server/auth/auth-guard");
    return {
      ...actual,
      requireAdminApiSession: vi.fn().mockRejectedValue(new actual.UnauthorizedError()),
    };
  });
}

describe("POST /api/reports/preview — auth", () => {
  it("returns 401 without a session", async () => {
    mockUnauthenticated();
    const { POST } = await import("./preview/route");
    const req = new NextRequest("http://localhost/api/reports/preview", {
      method: "POST",
      body: JSON.stringify({ type: "EXECUTIVE_SUMMARY", filters: { from: "2026-07-01", to: "2026-07-31" } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/reports/run — format support", () => {
  it("returns a 422 error when requesting PDF for a report type that doesn't support it", async () => {
    mockAuthenticated();
    vi.doMock("@/lib/db", () => ({ db: { auditLog: { create: vi.fn() } } }));
    const { POST } = await import("./run/route");
    const req = new NextRequest("http://localhost/api/reports/run", {
      method: "POST",
      body: JSON.stringify({
        type: "COMPLAINT_DETAIL",
        filters: { from: "2026-07-01", to: "2026-07-31" },
        formats: [ReportFormat.PDF],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("REPORT_FORMAT_UNSUPPORTED");
  });

  it("returns 400 for a malformed report request (invalid type)", async () => {
    mockAuthenticated();
    const { POST } = await import("./run/route");
    const req = new NextRequest("http://localhost/api/reports/run", {
      method: "POST",
      body: JSON.stringify({ type: "NOT_REAL", filters: { from: "2026-07-01", to: "2026-07-31" }, formats: ["PDF"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/reports/artifacts/[id]/download", () => {
  it("returns 404 (not the underlying storageKey) for a deleted artifact", async () => {
    mockAuthenticated();
    vi.doMock("@/lib/db", () => ({
      db: {
        reportArtifact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "art_1", storageKey: "secret-internal-path.pdf", fileName: "x.pdf", mimeType: "application/pdf",
            fileSize: 10, expiresAt: new Date(Date.now() + 86_400_000), deletedAt: new Date(), format: "PDF",
            reportRunId: "run_1", reportRun: { id: "run_1", status: "COMPLETED" },
          }),
        },
        auditLog: { create: vi.fn() },
      },
    }));
    const { GET } = await import("./artifacts/[id]/download/route");
    const req = new NextRequest("http://localhost/api/reports/artifacts/art_1/download");
    const res = await GET(req, { params: Promise.resolve({ id: "art_1" }) });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("secret-internal-path.pdf");
  });

  it("returns 404 for an expired artifact", async () => {
    mockAuthenticated();
    vi.doMock("@/lib/db", () => ({
      db: {
        reportArtifact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "art_2", storageKey: "x.pdf", fileName: "x.pdf", mimeType: "application/pdf", fileSize: 10,
            expiresAt: new Date(Date.now() - 86_400_000), deletedAt: null, format: "PDF",
            reportRunId: "run_1", reportRun: { id: "run_1", status: "COMPLETED" },
          }),
        },
        auditLog: { create: vi.fn() },
      },
    }));
    const { GET } = await import("./artifacts/[id]/download/route");
    const req = new NextRequest("http://localhost/api/reports/artifacts/art_2/download");
    const res = await GET(req, { params: Promise.resolve({ id: "art_2" }) });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent artifact id", async () => {
    mockAuthenticated();
    vi.doMock("@/lib/db", () => ({
      db: { reportArtifact: { findUnique: vi.fn().mockResolvedValue(null) }, auditLog: { create: vi.fn() } },
    }));
    const { GET } = await import("./artifacts/[id]/download/route");
    const req = new NextRequest("http://localhost/api/reports/artifacts/missing/download");
    const res = await GET(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/internal/reports/run-due — scheduler secret", () => {
  it("returns 401 when no secret header is provided", async () => {
    vi.doMock("@/lib/env", () => ({ env: { internalSchedulerSecret: "correct-secret-value-0123456789" } }));
    const { POST } = await import("../internal/reports/run-due/route");
    const req = new NextRequest("http://localhost/api/internal/reports/run-due", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the wrong secret is provided", async () => {
    vi.doMock("@/lib/env", () => ({ env: { internalSchedulerSecret: "correct-secret-value-0123456789" } }));
    const { POST } = await import("../internal/reports/run-due/route");
    const req = new NextRequest("http://localhost/api/internal/reports/run-due", {
      method: "POST",
      headers: { "x-scheduler-secret": "wrong-secret" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 503 when no scheduler secret is configured server-side", async () => {
    vi.doMock("@/lib/env", () => ({ env: { internalSchedulerSecret: undefined } }));
    const { POST } = await import("../internal/reports/run-due/route");
    const req = new NextRequest("http://localhost/api/internal/reports/run-due", {
      method: "POST",
      headers: { "x-scheduler-secret": "anything" },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it("does not require a session cookie — only the secret header — to succeed", async () => {
    vi.doMock("@/lib/env", () => ({ env: { internalSchedulerSecret: "correct-secret-value-0123456789" } }));
    vi.doMock("@/server/reports/report-schedule-service", () => ({
      runDueSchedule: vi.fn().mockResolvedValue({ ran: false, reason: "no_due_schedule" }),
    }));
    const { POST } = await import("../internal/reports/run-due/route");
    const req = new NextRequest("http://localhost/api/internal/reports/run-due", {
      method: "POST",
      headers: { "x-scheduler-secret": "correct-secret-value-0123456789" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

describe("Report template type lock via API", () => {
  it("PATCH returns 409 when changing reportType after runs exist", async () => {
    mockAuthenticated();
    vi.doMock("@/lib/db", () => ({
      db: {
        reportTemplate: {
          findUnique: vi.fn().mockResolvedValue({
            id: "tpl_1", name: "قالب", reportType: ReportType.EXECUTIVE_SUMMARY,
            filters: { from: "2026-07-01", to: "2026-07-31" }, options: {}, isActive: true, schedules: [],
          }),
        },
        reportRun: { count: vi.fn().mockResolvedValue(3) },
        auditLog: { create: vi.fn() },
      },
    }));
    const { PATCH } = await import("./templates/[id]/route");
    const req = new NextRequest("http://localhost/api/reports/templates/tpl_1", {
      method: "PATCH",
      body: JSON.stringify({ reportType: "OVERDUE_COMPLAINTS" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "tpl_1" }) });
    expect(res.status).toBe(409);
  });
});
