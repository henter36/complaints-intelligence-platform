import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  mapAuthError: vi.fn(),
  createClassification: vi.fn(),
  mapClassificationResponse: vi.fn(),
  toError: vi.fn(),
  categoryFindMany: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: mocks.requireSession,
  mapAuthError: mocks.mapAuthError,
}));

vi.mock("@/server/classifications/classification-management-service", () => ({
  createClassification: mocks.createClassification,
  mapClassificationResponse: mocks.mapClassificationResponse,
  toClassificationManagementErrorResponse: mocks.toError,
}));

vi.mock("@/lib/db", () => ({
  db: {
    category: { findMany: mocks.categoryFindMany },
  },
}));

import { GET, POST } from "./route";

describe("/api/classifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ username: "admin" });
    mocks.mapAuthError.mockReturnValue(null);
    mocks.toError.mockReturnValue(null);
    mocks.mapClassificationResponse.mockImplementation((c) => ({
      id: c.id,
      nodeType: "CLASSIFICATION",
      name: c.nameAr,
      keywords: c.keywords,
      parentId: c.categoryId,
    }));
  });

  it("GET returns tree with nodeType and category without keywords", async () => {
    mocks.categoryFindMany.mockResolvedValue([
      {
        id: "cat_1",
        nameAr: "فئة",
        nameEn: null,
        description: "د",
        classifications: [
          {
            id: "cls_1",
            nameAr: "تصنيف",
            nameEn: null,
            description: null,
            color: "#10b981",
            keywords: ["ك"],
          },
        ],
      },
    ]);
    const response = await GET(new NextRequest("http://localhost/api/classifications"));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.categoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isDeleted: false, isActive: true },
        include: expect.objectContaining({
          classifications: expect.objectContaining({
            where: { isDeleted: false, isActive: true },
          }),
        }),
      })
    );
    expect(payload[0]).toMatchObject({
      id: "cat_1",
      nodeType: "CATEGORY",
      parentId: null,
    });
    expect(payload[0].keywords).toBeUndefined();
    expect(payload[0].children[0]).toMatchObject({
      nodeType: "CLASSIFICATION",
      keywords: ["ك"],
      parentId: "cat_1",
    });
  });

  it("POST creates classification only (not category)", async () => {
    mocks.createClassification.mockResolvedValue({
      id: "cls_1",
      nameAr: "تصنيف",
      keywords: [],
      categoryId: "cat_1",
    });
    const request = new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({
        categoryId: "cat_1",
        name: "تصنيف",
        keywords: ["يدوي"],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.createClassification).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: "cat_1", name: "تصنيف", actor: "admin" })
    );
  });

  it("POST rejects parentId-only create payloads", async () => {
    const request = new NextRequest("http://localhost/api/classifications", {
      method: "POST",
      body: JSON.stringify({ name: "فئة", parentId: null }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mocks.createClassification).not.toHaveBeenCalled();
  });
});
