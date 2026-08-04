import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/server/auth/auth-guard";
import { updateCategoryPayloadSchema } from "@/server/classifications/classification-management-contract";
import { handleClassificationManagementRouteError } from "@/server/classifications/classification-management-route-error";
import {
  mapCategoryResponse,
  updateCategory,
} from "@/server/classifications/classification-management-service";

type RouteContext = { params: Promise<{ categoryId: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { categoryId } = await context.params;
    const body = updateCategoryPayloadSchema.parse(await req.json());
    const category = await updateCategory(categoryId, {
      ...body,
      actor: session.username,
    });
    return NextResponse.json(mapCategoryResponse(category));
  } catch (error) {
    return handleClassificationManagementRouteError(error, "CATEGORY_UPDATE");
  }
}
