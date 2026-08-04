import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  mapClassificationResponse,
  toClassificationManagementErrorResponse,
  updateClassification,
} from "@/server/classifications/classification-management-service";

type RouteContext = { params: Promise<{ classificationId: string }> };

const updateClassificationSchema = z
  .object({
    categoryId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { classificationId } = await context.params;
    const body = updateClassificationSchema.parse(await req.json());
    const classification = await updateClassification(classificationId, {
      categoryId: body.categoryId,
      name: body.name,
      description: body.description,
      color: body.color,
      keywords: body.keywords,
      actor: session.username,
    });
    return NextResponse.json(mapClassificationResponse(classification));
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    const management = toClassificationManagementErrorResponse(error);
    if (management) {
      return NextResponse.json(management.body, { status: management.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_CLASSIFICATION_PAYLOAD",
            message: "بيانات تحديث التصنيف غير صالحة",
            details: error.flatten(),
          },
        },
        { status: 400 }
      );
    }
    console.error("Update classification error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "CLASSIFICATION_UPDATE_FAILED", message: "تعذر تحديث التصنيف" } },
      { status: 500 }
    );
  }
}
