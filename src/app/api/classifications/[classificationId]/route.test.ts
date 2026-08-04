import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClassificationManagementError,
  toClassificationManagementErrorResponse,
} from "@/server/classifications/classification-management-service";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  mapAuthError: vi.fn(),
  updateClassification: vi.fn(),
  mapClassificationResponse: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: mocks.requireSession,
  mapAuthError: mocks.mapAuthError,
}));

vi.mock("@/server/classifications/classification-management-service", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/server/classifications/classification-management-service")
  >();
  return {
    ...actual,
    updateClassification: mocks.updateClassification,
    mapClassificationResponse: mocks.mapClassificationResponse,
  };
});

import { PATCH } from "./route";

describe("PATCH /api/classifications/[classificationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ username: "admin" });
    mocks.mapAuthError.mockReturnValue(null);
    mocks.mapClassificationResponse.mockImplementation((c) => ({
      id: c.id,
      nodeType: "CLASSIFICATION",
      keywords: c.keywords,
    }));
  });

  it("updates classification keywords", async () => {
    mocks.updateClassification.mockResolvedValue({
      id: "cls_1",
      keywords: ["أ", "ب"],
    });
    const request = new NextRequest("http://localhost/api/classifications/cls_1", {
      method: "PATCH",
      body: JSON.stringify({ keywords: ["أ", "ب"], name: "تصنيف" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ classificationId: "cls_1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.updateClassification).toHaveBeenCalledWith(
      "cls_1",
      expect.objectContaining({ keywords: ["أ", "ب"], actor: "admin" })
    );
  });

  it("returns 409 keyword conflict body shape", async () => {
    mocks.updateClassification.mockRejectedValue(
      new ClassificationManagementError(
        "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION",
        "كلمة مفتاحية واحدة أو أكثر مرتبطة بتصنيف آخر",
        409,
        { conflicts: [{ keyword: "ك", classificationId: "other", classificationName: "آخر" }] }
      )
    );

    const request = new NextRequest("http://localhost/api/classifications/cls_1", {
      method: "PATCH",
      body: JSON.stringify({ keywords: ["ك"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, {
      params: Promise.resolve({ classificationId: "cls_1" }),
    });
    const payload = await response.json();
    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION");
    expect(payload.error.details.conflicts).toHaveLength(1);

    // sanity: helper maps status consistently
    const mapped = toClassificationManagementErrorResponse(
      new ClassificationManagementError("X", "m", 409)
    );
    expect(mapped?.status).toBe(409);
  });
});
