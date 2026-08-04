import { NextResponse } from "next/server";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClassificationManagementError,
} from "@/server/classifications/classification-management-service";

const mocks = vi.hoisted(() => ({
  mapAuthError: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  mapAuthError: mocks.mapAuthError,
}));

import { handleClassificationManagementRouteError } from "./classification-management-route-error";
import {
  createCategoryPayloadSchema,
  createClassificationPayloadSchema,
  updateCategoryPayloadSchema,
} from "./classification-management-contract";

describe("handleClassificationManagementRouteError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mapAuthError.mockReturnValue(null);
  });

  it("returns auth response first when present", async () => {
    const authResponse = NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "auth" } },
      { status: 401 }
    );
    mocks.mapAuthError.mockReturnValue(authResponse);

    const response = handleClassificationManagementRouteError(
      new Error("auth"),
      "CATEGORY_CREATE"
    );
    expect(response).toBe(authResponse);
    expect(response.status).toBe(401);
  });

  it("preserves management error status and body", async () => {
    const response = handleClassificationManagementRouteError(
      new ClassificationManagementError(
        "CATEGORY_NOT_FOUND",
        "الفئة غير موجودة أو غير نشطة",
        404,
        { id: "cat_1" }
      ),
      "CATEGORY_UPDATE"
    );
    const payload = await response.json();
    expect(response.status).toBe(404);
    expect(payload).toEqual({
      error: {
        code: "CATEGORY_NOT_FOUND",
        message: "الفئة غير موجودة أو غير نشطة",
        details: { id: "cat_1" },
      },
    });
  });

  it("CATEGORY_CREATE with unrecognized_keys returns UNEXPECTED_CATEGORY_FIELD", async () => {
    let zodError: z.ZodError | null = null;
    try {
      createCategoryPayloadSchema.parse({ name: "فئة", keywords: ["x"] });
    } catch (error) {
      zodError = error as z.ZodError;
    }
    expect(zodError).toBeInstanceOf(z.ZodError);

    const response = handleClassificationManagementRouteError(zodError, "CATEGORY_CREATE");
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("UNEXPECTED_CATEGORY_FIELD");
    expect(payload.error.message).toBe(
      "حقل غير مسموح لطلب الفئة (مثل keywords أو color أو parentId)"
    );
  });

  it("CATEGORY_UPDATE with unrecognized_keys returns update-specific message", async () => {
    let zodError: z.ZodError | null = null;
    try {
      updateCategoryPayloadSchema.parse({ color: "#fff" });
    } catch (error) {
      zodError = error as z.ZodError;
    }
    expect(zodError).toBeInstanceOf(z.ZodError);

    const response = handleClassificationManagementRouteError(zodError, "CATEGORY_UPDATE");
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("UNEXPECTED_CATEGORY_FIELD");
    expect(payload.error.message).toBe(
      "حقل غير مسموح عند تحديث الفئة (مثل keywords أو color أو parentId)"
    );
  });

  it("classification Zod error returns INVALID_CLASSIFICATION_PAYLOAD", async () => {
    let zodError: z.ZodError | null = null;
    try {
      createClassificationPayloadSchema.parse({ name: "تصنيف" });
    } catch (error) {
      zodError = error as z.ZodError;
    }
    expect(zodError).toBeInstanceOf(z.ZodError);

    const response = handleClassificationManagementRouteError(
      zodError,
      "CLASSIFICATION_CREATE"
    );
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("INVALID_CLASSIFICATION_PAYLOAD");
    expect(payload.error.message).toContain("categoryId");
  });

  it.each([
    ["CATEGORY_CREATE", "CATEGORY_CREATE_FAILED", "تعذر إنشاء الفئة"],
    ["CATEGORY_UPDATE", "CATEGORY_UPDATE_FAILED", "تعذر تحديث الفئة"],
    ["CLASSIFICATION_CREATE", "CLASSIFICATION_CREATE_FAILED", "تعذر إنشاء التصنيف"],
    ["CLASSIFICATION_UPDATE", "CLASSIFICATION_UPDATE_FAILED", "تعذر تحديث التصنيف"],
  ] as const)(
    "unknown %s returns %s with status 500",
    async (operation, code, message) => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = handleClassificationManagementRouteError(
        new Error("boom"),
        operation
      );
      const payload = await response.json();
      expect(response.status).toBe(500);
      expect(payload.error).toEqual({ code, message });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    }
  );
});
