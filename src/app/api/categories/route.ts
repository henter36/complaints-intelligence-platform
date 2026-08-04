import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/server/auth/auth-guard";
import { createCategoryPayloadSchema } from "@/server/classifications/classification-management-contract";
import { handleClassificationManagementRouteError } from "@/server/classifications/classification-management-route-error";
import {
  createCategory,
  mapCategoryResponse,
} from "@/server/classifications/classification-management-service";

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = createCategoryPayloadSchema.parse(await req.json());
    const category = await createCategory({
      ...body,
      actor: session.username,
    });
    return NextResponse.json(mapCategoryResponse(category), { status: 201 });
  } catch (error) {
    return handleClassificationManagementRouteError(error, "CATEGORY_CREATE");
  }
}
