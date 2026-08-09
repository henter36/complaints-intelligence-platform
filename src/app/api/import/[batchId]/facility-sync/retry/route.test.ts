import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retry: vi.fn(),
  requireAdmin: vi.fn().mockResolvedValue({ username: "admin" }),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: mocks.requireAdmin,
  mapAuthError: vi.fn().mockReturnValue(null),
}));

vi.mock("@/server/facilities/facility-registry-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/facilities/facility-registry-service")>();
  return { ...actual, retryFacilitySyncForConfirmedBatch: mocks.retry };
});

import { FacilityRegistrySyncError } from "@/server/facilities/facility-registry-service";
import { POST } from "./route";

const request = new NextRequest("http://localhost/api/import/batch-1/facility-sync/retry", {
  method: "POST",
});
const context = { params: Promise.resolve({ batchId: "batch-1" }) };

describe("facility sync retry route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires admin and returns the completed retry result", async () => {
    mocks.retry.mockResolvedValue({
      batchId: "batch-1",
      status: "COMPLETED",
      syncedFacilities: 2,
      attempts: 2,
      syncedAt: "2026-08-09T00:00:00.000Z",
    });

    const response = await POST(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "COMPLETED", syncedFacilities: 2 });
    expect(mocks.requireAdmin).toHaveBeenCalledWith(request);
    expect(mocks.retry).toHaveBeenCalledWith("batch-1");
  });

  it("returns structured retry errors without a stack trace", async () => {
    mocks.retry.mockRejectedValue(new FacilityRegistrySyncError(
      "IMPORT_BATCH_NOT_CONFIRMED",
      "لا يمكن مزامنة السجون قبل تأكيد دفعة الاستيراد",
      409
    ));

    const response = await POST(request, context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "IMPORT_BATCH_NOT_CONFIRMED",
        message: "لا يمكن مزامنة السجون قبل تأكيد دفعة الاستيراد",
      },
    });
  });
});
