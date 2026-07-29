import { NextRequest } from "next/server";
import { ComplaintPriority, ComplaintStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

beforeEach(() => {
  vi.doMock("@/server/auth/auth-guard", () => ({
    requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
    mapAuthError: vi.fn().mockReturnValue(null),
  }));
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/db");
  vi.doUnmock("@/server/auth/auth-guard");
});

function complaintRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_phase6",
    externalId: "EXT-6",
    sourceReference: "SRC-6",
    complaintDate: new Date("2026-07-01T00:00:00Z"),
    receivedAt: new Date("2026-07-01T00:00:00Z"),
    dueDate: new Date("2026-07-10T00:00:00Z"),
    closedAt: null,
    status: ComplaintStatus.OPEN,
    subject: "=موضوع خطر",
    description: "وصف",
    complainantName: "اسم صناعي",
    complainantIdentifier: "1234567890",
    complainantPhone: "0501234567",
    region: "الرياض",
    facility: "المركز",
    department: "الدعم",
    categoryId: null,
    classificationId: null,
    priority: ComplaintPriority.HIGH,
    severity: ComplaintPriority.HIGH,
    channel: "الهاتف",
    resolution: null,
    version: 1,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-02T00:00:00Z"),
    importBatch: null,
    category: null,
    classification: null,
    statusHistory: [],
    ...overrides,
  };
}

function mockDb(overrides: Record<string, unknown>) {
  vi.doMock("@/lib/db", () => ({
    db: {
      complaint: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        ...overrides,
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    },
  }));
}

describe("Phase 6 complaint routes", () => {
  it("returns masked complainant identifier and phone in complaint details", async () => {
    mockDb({ findFirst: vi.fn().mockResolvedValue(complaintRecord()) });

    const { GET } = await import("./[id]/route");
    const response = await GET(
      new NextRequest("http://localhost/api/complaints/cmp_phase6"),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.item.complainantIdentifier).toBe("12****90");
    expect(body.item.complainantPhone).toBe("05****67");
  });

  it("exports CSV without complainant PII and escapes formula-like cells", async () => {
    mockDb({
      findMany: vi.fn().mockResolvedValue([complaintRecord()]),
      count: vi.fn().mockResolvedValue(1),
    });

    const { GET } = await import("./export/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints/export"));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(csv).toContain("\"'=موضوع خطر\"");
    expect(csv).not.toContain("1234567890");
    expect(csv).not.toContain("0501234567");
    expect(response.headers.get("Content-Type")).toContain("text/csv");
  });

  it("rejects closing a complaint without a reason before mutation", async () => {
    const updateMany = vi.fn();
    mockDb({
      findFirst: vi.fn().mockResolvedValue({ status: ComplaintStatus.OPEN }),
      updateMany,
    });

    const { POST } = await import("./[id]/status/route");
    const response = await POST(
      new NextRequest("http://localhost/api/complaints/cmp_phase6/status", {
        method: "POST",
        body: JSON.stringify({ toStatus: "CLOSED", expectedVersion: 1 }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("INVALID_STATUS_TRANSITION");
    expect(updateMany).not.toHaveBeenCalled();
  });
});
