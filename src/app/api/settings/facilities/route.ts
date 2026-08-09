import { NextRequest, NextResponse } from "next/server";

import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  facilityManagementErrorResponse,
  listManagedFacilities,
  parseFacilityStatus,
} from "@/server/facilities/facility-management-service";

function handleError(error: unknown): NextResponse {
  const authResponse = mapAuthError(error);
  if (authResponse) return authResponse;
  const management = facilityManagementErrorResponse(error);
  if (management) return NextResponse.json(management.body, { status: management.status });
  console.error("Facility settings API error:", error);
  return NextResponse.json(
    { error: { code: "FACILITY_REQUEST_FAILED", message: "تعذر تحميل السجون." } },
    { status: 500 }
  );
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminApiSession(request);
    const status = parseFacilityStatus(request.nextUrl.searchParams.get("status"));
    const facilities = await listManagedFacilities({
      search: request.nextUrl.searchParams.get("search") ?? undefined,
      status,
      region: request.nextUrl.searchParams.get("region") ?? undefined,
    });
    return NextResponse.json({ facilities });
  } catch (error) {
    return handleError(error);
  }
}
