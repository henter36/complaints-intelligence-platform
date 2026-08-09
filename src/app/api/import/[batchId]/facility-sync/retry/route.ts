import { NextRequest, NextResponse } from "next/server";

import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  FacilityRegistrySyncError,
  retryFacilitySyncForConfirmedBatch,
} from "@/server/facilities/facility-registry-service";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    await requireAdminApiSession(request);
    const { batchId } = await context.params;
    return NextResponse.json(await retryFacilitySyncForConfirmedBatch(batchId));
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (error instanceof FacilityRegistrySyncError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: "FACILITY_SYNC_RETRY_FAILED",
          message: "تعذرت إعادة محاولة مزامنة السجون",
        },
      },
      { status: 500 }
    );
  }
}
