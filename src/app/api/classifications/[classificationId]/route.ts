import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/server/auth/auth-guard";
import { updateClassificationPayloadSchema } from "@/server/classifications/classification-management-contract";
import { handleClassificationManagementRouteError } from "@/server/classifications/classification-management-route-error";
import {
  mapClassificationResponse,
  updateClassification,
} from "@/server/classifications/classification-management-service";

type RouteContext = { params: Promise<{ classificationId: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { classificationId } = await context.params;
    const body = updateClassificationPayloadSchema.parse(await req.json());
    const classification = await updateClassification(classificationId, {
      ...body,
      actor: session.username,
    });
    return NextResponse.json(mapClassificationResponse(classification));
  } catch (error) {
    return handleClassificationManagementRouteError(error, "CLASSIFICATION_UPDATE");
  }
}
