import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { createClassificationPayloadSchema } from "@/server/classifications/classification-management-contract";
import { handleClassificationManagementRouteError } from "@/server/classifications/classification-management-route-error";
import {
  createClassification,
  mapClassificationResponse,
} from "@/server/classifications/classification-management-service";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const categories = await db.category.findMany({
      where: { isDeleted: false, isActive: true },
      include: {
        classifications: {
          where: { isDeleted: false, isActive: true },
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
    const body = createClassificationPayloadSchema.parse(await req.json());
    const classification = await createClassification({
      ...body,
      actor: session.username,
    });
    return NextResponse.json(mapClassificationResponse(classification), { status: 201 });
  } catch (error) {
    return handleClassificationManagementRouteError(error, "CLASSIFICATION_CREATE");
  }
}
