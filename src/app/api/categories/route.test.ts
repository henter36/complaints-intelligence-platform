import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  mapAuthError: vi.fn(),
  createCategory: vi.fn(),
  mapCategoryResponse: vi.fn(),
  toError: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: mocks.requireSession,
  mapAuthError: mocks.mapAuthError,
}));

vi.mock("@/server/classifications/classification-management-service", () => ({
  createCategory: mocks.createCategory,
  mapCategoryResponse: mocks.mapCategoryResponse,
  toClassificationManagementErrorResponse: mocks.toError,
}));

import { POST } from "./route";

describe("POST /api/categories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ username: "admin" });
    mocks.mapAuthError.mockReturnValue(null);
    mocks.toError.mockReturnValue(null);
    mocks.mapCategoryResponse.mockImplementation((c) => ({
      id: c.id,
      nodeType: "CATEGORY",
      name: c.nameAr,
    }));
  });

  it("creates a category", async () => {
    mocks.createCategory.mockResolvedValue({ id: "cat_1", nameAr: "فئة" });
    const request = new NextRequest("http://localhost/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "فئة", description: "وصف" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.createCategory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "فئة", actor: "admin" })
    );
  });

  it("rejects keywords on category create", async () => {
    const request = new NextRequest("http://localhost/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "فئة", keywords: ["x"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("UNEXPECTED_CATEGORY_FIELD");
    expect(mocks.createCategory).not.toHaveBeenCalled();
  });
});
