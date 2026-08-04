import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  mapAuthError: vi.fn(),
  updateCategory: vi.fn(),
  mapCategoryResponse: vi.fn(),
  toError: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: mocks.requireSession,
  mapAuthError: mocks.mapAuthError,
}));

vi.mock("@/server/classifications/classification-management-service", () => ({
  updateCategory: mocks.updateCategory,
  mapCategoryResponse: mocks.mapCategoryResponse,
  toClassificationManagementErrorResponse: mocks.toError,
}));

import { PATCH } from "./route";

describe("PATCH /api/categories/[categoryId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ username: "admin" });
    mocks.mapAuthError.mockReturnValue(null);
    mocks.toError.mockReturnValue(null);
    mocks.mapCategoryResponse.mockImplementation((c) => c);
  });

  it("updates the same category id", async () => {
    mocks.updateCategory.mockResolvedValue({ id: "cat_1", nameAr: "محدث" });
    const request = new NextRequest("http://localhost/api/categories/cat_1", {
      method: "PATCH",
      body: JSON.stringify({ name: "محدث", description: "د" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, { params: Promise.resolve({ categoryId: "cat_1" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateCategory).toHaveBeenCalledWith(
      "cat_1",
      expect.objectContaining({ name: "محدث", actor: "admin" })
    );
  });

  it("rejects color/keywords fields", async () => {
    const request = new NextRequest("http://localhost/api/categories/cat_1", {
      method: "PATCH",
      body: JSON.stringify({ color: "#fff", keywords: ["a"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, { params: Promise.resolve({ categoryId: "cat_1" }) });
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("UNEXPECTED_CATEGORY_FIELD");
  });
});
