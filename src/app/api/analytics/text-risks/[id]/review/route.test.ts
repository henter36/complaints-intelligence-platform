import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTransaction, mockFindUnique, mockUpdate, writeAuditLogMock } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  writeAuditLogMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $transaction: mockTransaction },
}));
vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({}),
  mapAuthError: vi.fn().mockReturnValue(null),
}));
vi.mock("@/server/audit/audit-log-service", () => ({
  AUDIT_ACTOR_SINGLE_ADMIN: "single-admin",
  writeAuditLog: writeAuditLogMock,
}));

const mockTx = {
  textRiskSignal: { findUnique: mockFindUnique, update: mockUpdate },
  auditLog: { create: vi.fn() },
};

async function patch(id: string, body: unknown) {
  const { PATCH } = await import("./route");
  return PATCH(
    new NextRequest(`http://localhost/api/analytics/text-risks/${id}/review`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("PATCH /api/analytics/text-risks/[id]/review", () => {
  const UPDATED = { id: "sig-1", reviewStatus: "CONFIRMED", reviewedAt: new Date(), reviewReason: null };

  beforeEach(() => {
    mockFindUnique.mockResolvedValue({ id: "sig-1", reviewStatus: "PENDING_REVIEW" });
    mockUpdate.mockResolvedValue(UPDATED);
    writeAuditLogMock.mockResolvedValue({});
    mockTransaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  });

  it("returns 200 when signal is found and updated", async () => {
    const res = await patch("sig-1", { reviewStatus: "CONFIRMED" });
    expect(res.status).toBe(200);
  });

  it("response body contains reviewStatus", async () => {
    const res = await patch("sig-1", { reviewStatus: "CONFIRMED" });
    const body = await res.json();
    expect(body.reviewStatus).toBe("CONFIRMED");
  });

  it("passes previousStatus in audit log metadata", async () => {
    await patch("sig-1", { reviewStatus: "CONFIRMED" });
    const [, auditInput] = writeAuditLogMock.mock.calls[0] as [unknown, { metadata: { previousStatus: string } }];
    expect(auditInput.metadata.previousStatus).toBe("PENDING_REVIEW");
  });

  it("update and audit are both called inside the transaction callback", async () => {
    const callOrder: string[] = [];
    mockUpdate.mockImplementation(async () => {
      callOrder.push("update");
      return UPDATED;
    });
    writeAuditLogMock.mockImplementation(async () => {
      callOrder.push("audit");
    });

    await patch("sig-1", { reviewStatus: "CONFIRMED" });
    expect(callOrder).toEqual(["update", "audit"]);
  });

  it("returns 404 when signal is not found", async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await patch("nonexistent", { reviewStatus: "CONFIRMED" });
    expect(res.status).toBe(404);
  });

  it("returns 500 when writeAuditLog throws (transaction rolls back)", async () => {
    writeAuditLogMock.mockRejectedValueOnce(new Error("audit failed"));
    // Let the transaction propagate the callback error (Prisma would roll back)
    mockTransaction.mockImplementationOnce(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
    const res = await patch("sig-1", { reviewStatus: "CONFIRMED" });
    expect(res.status).toBe(500);
  });

  it("returns 422 when DISMISSED without a reason", async () => {
    const res = await patch("sig-1", { reviewStatus: "DISMISSED" });
    expect(res.status).toBe(422);
  });

  it("returns 200 when DISMISSED with a reason", async () => {
    mockUpdate.mockResolvedValue({ ...UPDATED, reviewStatus: "DISMISSED", reviewReason: "غير صحيح" });
    const res = await patch("sig-1", { reviewStatus: "DISMISSED", reviewReason: "غير صحيح" });
    expect(res.status).toBe(200);
  });

  it("returns 400 for an invalid reviewStatus value", async () => {
    const res = await patch("sig-1", { reviewStatus: "NOT_A_REAL_STATUS" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing body", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/analytics/text-risks/sig-1/review", {
        method: "PATCH",
        body: "not json {{",
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "sig-1" }) }
    );
    expect(res.status).toBe(400);
  });
});
