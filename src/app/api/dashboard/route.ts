import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  getComplaintKpis,
} from "@/server/complaints/complaint-kpi-service";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const result = await getComplaintKpis(url.searchParams);
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("Dashboard API error:", error);
    return NextResponse.json(
      { error: { code: "DASHBOARD_QUERY_FAILED", message: "تعذر جلب مؤشرات لوحة التحكم" } },
      { status: 500 }
    );
  }
}
