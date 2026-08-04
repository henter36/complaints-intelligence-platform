import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  mapCategoryResponse,
  toClassificationManagementErrorResponse,
  updateCategory,
} from "@/server/classifications/classification-management-service";

type RouteContext = { params: Promise<{ categoryId: string }> };

const updateCategorySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    displayOrder: z.number().int().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { categoryId } = await context.params;
    const body = updateCategorySchema.parse(await req.json());
    const category = await updateCategory(categoryId, {
      name: body.name,
      description: body.description,
      displayOrder: body.displayOrder,
      actor: session.username,
    });
    return NextResponse.json(mapCategoryResponse(category));
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    const management = toClassificationManagementErrorResponse(error);
    if (management) {
      return NextResponse.json(management.body, { status: management.status });
    }
    if (error instanceof z.ZodError) {
      const unexpected = error.issues.some((issue) => issue.code === "unrecognized_keys");
      return NextResponse.json(
        {
          error: {
            code: unexpected ? "UNEXPECTED_CATEGORY_FIELD" : "INVALID_CATEGORY_PAYLOAD",
            message: unexpected
              ? "حقل غير مسموح عند تحديث الفئة (مثل keywords أو color أو parentId)"
              : "بيانات تحديث الفئة غير صالحة",
            details: error.flatten(),
          },
        },
        { status: 400 }
      );
    }
    console.error("Update category error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "CATEGORY_UPDATE_FAILED", message: "تعذر تحديث الفئة" } },
      { status: 500 }
    );
  }
}
