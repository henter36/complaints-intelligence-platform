import { NextRequest, NextResponse } from "next/server";

import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  facilityManagementErrorResponse,
  updateFacilityOperationalStatus,
} from "@/server/facilities/facility-management-service";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const facility = await updateFacilityOperationalStatus(id, body, session.username);
    return NextResponse.json({ facility });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    const management = facilityManagementErrorResponse(error);
    if (management) return NextResponse.json(management.body, { status: management.status });
    console.error("Facility status update API error:", error);
    return NextResponse.json(
      { error: { code: "FACILITY_UPDATE_FAILED", message: "تعذر تحديث حالة السجن." } },
      { status: 500 }
    );
  }
}
