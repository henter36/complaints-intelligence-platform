import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { listReportDefinitions } from "@/server/reports/report-definition-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    return NextResponse.json({ definitions: listReportDefinitions() });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    console.error("Report definitions API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_DEFINITIONS_FAILED", message: "تعذر جلب أنواع التقارير" } },
      { status: 500 }
    );
  }
}
