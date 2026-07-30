import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  isReportRequestValidationError,
  parseReportRequest,
} from "@/server/reports/report-definition-service";
import { buildReportData } from "@/server/reports/report-data-service";

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = await req.json().catch(() => null);
    const request = parseReportRequest(body);

    const data = await buildReportData(request, "preview");

    await writeAuditLog(db, {
      action: "REPORT_PREVIEWED",
      entityType: "Report",
      actor: session.username,
      metadata: { reportType: request.type },
    });

    return NextResponse.json({ report: data });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (isReportRequestValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }

    console.error("Report preview API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_PREVIEW_FAILED", message: "تعذر معاينة التقرير" } },
      { status: 500 }
    );
  }
}
