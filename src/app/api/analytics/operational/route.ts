import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { getOperationalAnalytics } from "@/server/analytics/operational/operational-analytics-service";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    // Staff actor identities are never enabled from the public analytics UI path.
    // Explicit includeStaffActors=true is reserved for future authorized operational tooling.
    const includeStaffActors = false;
    const summary = await getOperationalAnalytics(url.searchParams, { includeStaffActors });
    return NextResponse.json(summary);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("Operational analytics API error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json(
      { error: { code: "OPERATIONAL_ANALYTICS_FAILED", message: "تعذر جلب التحليلات التشغيلية" } },
      { status: 500 }
    );
  }
}
