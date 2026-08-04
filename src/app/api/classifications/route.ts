import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  createClassification,
  mapClassificationResponse,
  toClassificationManagementErrorResponse,
} from "@/server/classifications/classification-management-service";
import { db } from "@/lib/db";

const createClassificationSchema = z
  .object({
    categoryId: z.string().min(1, "معرّف الفئة مطلوب"),
    name: z.string().min(1, "اسم التصنيف مطلوب"),
    description: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const categories = await db.category.findMany({
      where: { isDeleted: false },
      include: {
        classifications: {
          where: { isDeleted: false },
          orderBy: [{ displayOrder: "asc" }, { nameAr: "asc" }],
        },
      },
      orderBy: [{ displayOrder: "asc" }, { nameAr: "asc" }],
    });

    return NextResponse.json(
      categories.map((category) => ({
        id: category.id,
        nodeType: "CATEGORY" as const,
        name: category.nameAr,
        nameEn: category.nameEn,
        description: category.description,
        parentId: null,
        children: category.classifications.map((classification) => ({
          id: classification.id,
          nodeType: "CLASSIFICATION" as const,
          name: classification.nameAr,
          nameEn: classification.nameEn,
          description: classification.description,
          color: classification.color,
          keywords: classification.keywords,
          parentId: category.id,
        })),
      }))
    );
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Classifications API error:", error);
    return NextResponse.json(
      { error: { code: "CLASSIFICATIONS_FETCH_FAILED", message: "تعذر تحميل التصنيفات" } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = createClassificationSchema.parse(await req.json());
    const classification = await createClassification({
      categoryId: body.categoryId,
      name: body.name,
      description: body.description,
      color: body.color,
      keywords: body.keywords,
      actor: session.username,
    });
    return NextResponse.json(mapClassificationResponse(classification), { status: 201 });
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
            message: "بيانات التصنيف غير صالحة. استخدم categoryId لإنشاء تصنيف فقط.",
            details: error.flatten(),
          },
        },
        { status: 400 }
      );
    }
    console.error("Create classification error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "CLASSIFICATION_CREATE_FAILED", message: "تعذر إنشاء التصنيف" } },
      { status: 500 }
    );
  }
}
