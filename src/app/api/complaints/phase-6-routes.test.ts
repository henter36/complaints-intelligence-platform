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
  vi.doUnmock("@/server/complaints/complaint-service");
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
  const classificationFindFirst = vi.fn().mockResolvedValue({ categoryId: "cat_current" });
  vi.doMock("@/lib/db", () => ({
    db: {
      complaint: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        ...overrides,
      },
      classification: { findFirst: classificationFindFirst },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    },
  }));
  return { classificationFindFirst };
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

  it("exports object values as empty cells instead of [object Object]", async () => {
    mockDb({
      findMany: vi.fn().mockResolvedValue([complaintRecord({ subject: { unsafe: true } })]),
      count: vi.fn().mockResolvedValue(1),
    });

    const { GET } = await import("./export/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints/export"));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(csv).not.toContain("[object Object]");
    expect(csv).toContain("\"\"");
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

  it.each([
    ["missing status", { expectedVersion: 1 }],
    ["unsupported status", { toStatus: "UNKNOWN", expectedVersion: 1 }],
    ["missing expectedVersion", { toStatus: "OPEN" }],
    ["invalid expectedVersion", { toStatus: "OPEN", expectedVersion: 0 }],
  ])("rejects invalid status payload: %s", async (_label, payload) => {
    mockDb({ findFirst: vi.fn().mockResolvedValue({ status: ComplaintStatus.OPEN }) });

    const { POST } = await import("./[id]/status/route");
    const response = await POST(
      new NextRequest("http://localhost/api/complaints/cmp_phase6/status", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("returns not found from the status route before transition", async () => {
    mockDb({ findFirst: vi.fn().mockResolvedValue(null) });

    const { POST } = await import("./[id]/status/route");
    const response = await POST(
      new NextRequest("http://localhost/api/complaints/missing/status", {
        method: "POST",
        body: JSON.stringify({ toStatus: "OPEN", expectedVersion: 1 }),
      }),
      { params: Promise.resolve({ id: "missing" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("COMPLAINT_NOT_FOUND");
  });

  it("maps status service conflicts", async () => {
    mockDb({ findFirst: vi.fn().mockResolvedValue({ status: ComplaintStatus.OPEN }) });
    vi.doMock("@/server/complaints/complaint-service", async () => {
      const actual = await vi.importActual<typeof import("@/server/complaints/complaint-service")>(
        "@/server/complaints/complaint-service"
      );
      return {
        ...actual,
        updateComplaintStatus: vi.fn().mockRejectedValue(new actual.ComplaintConcurrencyError()),
      };
    });

    const { POST } = await import("./[id]/status/route");
    const response = await POST(
      new NextRequest("http://localhost/api/complaints/cmp_phase6/status", {
        method: "POST",
        body: JSON.stringify({ toStatus: "OPEN", expectedVersion: 1 }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("COMPLAINT_VERSION_CONFLICT");
  });

  it("maps invalid status transitions from the service", async () => {
    mockDb({ findFirst: vi.fn().mockResolvedValue({ status: ComplaintStatus.OPEN }) });
    vi.doMock("@/server/complaints/complaint-service", async () => {
      const actual = await vi.importActual<typeof import("@/server/complaints/complaint-service")>(
        "@/server/complaints/complaint-service"
      );
      return {
        ...actual,
        updateComplaintStatus: vi.fn().mockRejectedValue(
          new actual.ComplaintValidationError("Invalid complaint status transition.")
        ),
      };
    });

    const { POST } = await import("./[id]/status/route");
    const response = await POST(
      new NextRequest("http://localhost/api/complaints/cmp_phase6/status", {
        method: "POST",
        body: JSON.stringify({ toStatus: "OPEN", expectedVersion: 1 }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("returns status change success", async () => {
    mockDb({ findFirst: vi.fn().mockResolvedValue({ status: ComplaintStatus.OPEN }) });
    vi.doMock("@/server/complaints/complaint-service", async () => {
      const actual = await vi.importActual<typeof import("@/server/complaints/complaint-service")>(
        "@/server/complaints/complaint-service"
      );
      return {
        ...actual,
        updateComplaintStatus: vi.fn().mockResolvedValue(complaintRecord({ status: ComplaintStatus.IN_PROGRESS })),
      };
    });

    const { POST } = await import("./[id]/status/route");
    const response = await POST(
      new NextRequest("http://localhost/api/complaints/cmp_phase6/status", {
        method: "POST",
        body: JSON.stringify({ toStatus: "IN_PROGRESS", expectedVersion: 1 }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.item.status).toBe(ComplaintStatus.IN_PROGRESS);
  });

  it("allows classification-only updates when it matches the current category", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { classificationFindFirst } = mockDb({
      findFirst: vi.fn()
        .mockResolvedValueOnce({ id: "cmp_phase6", categoryId: "cat_current", classificationId: "cls_old" })
        .mockResolvedValueOnce(complaintRecord({ classificationId: "cls_next" })),
      updateMany,
    });
    classificationFindFirst.mockResolvedValue({ categoryId: "cat_current" });

    const { PATCH } = await import("./[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/complaints/cmp_phase6", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, classificationId: "cls_next" }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );

    expect(response.status).toBe(200);
    expect(updateMany).toHaveBeenCalled();
  });

  it("rejects classification-only updates when it conflicts with the current category", async () => {
    const { classificationFindFirst } = mockDb({
      findFirst: vi.fn().mockResolvedValue({ id: "cmp_phase6", categoryId: "cat_current", classificationId: "cls_old" }),
    });
    classificationFindFirst.mockResolvedValue({ categoryId: "cat_other" });

    const { PATCH } = await import("./[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/complaints/cmp_phase6", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, classificationId: "cls_next" }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("INVALID_CLASSIFICATION_RELATION");
  });

  it("accepts explicit matching category and classification", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { classificationFindFirst } = mockDb({
      findFirst: vi.fn()
        .mockResolvedValueOnce({ id: "cmp_phase6", categoryId: "cat_current", classificationId: null })
        .mockResolvedValueOnce(complaintRecord({ categoryId: "cat_next", classificationId: "cls_next" })),
      updateMany,
    });
    classificationFindFirst.mockResolvedValue({ categoryId: "cat_next" });

    const { PATCH } = await import("./[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/complaints/cmp_phase6", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, categoryId: "cat_next", classificationId: "cls_next" }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );

    expect(response.status).toBe(200);
    expect(updateMany).toHaveBeenCalled();
  });

  it("rejects explicit category/classification mismatches", async () => {
    const { classificationFindFirst } = mockDb({
      findFirst: vi.fn().mockResolvedValue({ id: "cmp_phase6", categoryId: "cat_current", classificationId: null }),
    });
    classificationFindFirst.mockResolvedValue({ categoryId: "cat_other" });

    const { PATCH } = await import("./[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/complaints/cmp_phase6", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, categoryId: "cat_next", classificationId: "cls_next" }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );

    expect(response.status).toBe(422);
  });

  it("allows clearing classification", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockDb({
      findFirst: vi.fn()
        .mockResolvedValueOnce({ id: "cmp_phase6", categoryId: "cat_current", classificationId: "cls_old" })
        .mockResolvedValueOnce(complaintRecord({ classificationId: null })),
      updateMany,
    });

    const { PATCH } = await import("./[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/complaints/cmp_phase6", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, classificationId: null }),
      }),
      { params: Promise.resolve({ id: "cmp_phase6" }) }
    );

    expect(response.status).toBe(200);
    expect(updateMany).toHaveBeenCalled();
  });
});
