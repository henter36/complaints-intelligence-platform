import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  createCategory,
  mapCategoryResponse,
  toClassificationManagementErrorResponse,
} from "@/server/classifications/classification-management-service";

const createCategorySchema = z
  .object({
    name: z.string().min(1, "اسم الفئة مطلوب"),
    description: z.string().nullable().optional(),
    displayOrder: z.number().int().optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = createCategorySchema.parse(await req.json());
    const category = await createCategory({
      name: body.name,
      description: body.description,
      displayOrder: body.displayOrder,
      actor: session.username,
    });
    return NextResponse.json(mapCategoryResponse(category), { status: 201 });
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
              ? "حقل غير مسموح لطلب الفئة (مثل keywords أو color أو parentId)"
              : "بيانات الفئة غير صالحة",
            details: error.flatten(),
          },
        },
        { status: 400 }
      );
    }
    console.error("Create category error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "CATEGORY_CREATE_FAILED", message: "تعذر إنشاء الفئة" } },
      { status: 500 }
    );
  }
}
