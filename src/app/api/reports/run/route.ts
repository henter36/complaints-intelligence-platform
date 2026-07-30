import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ReportFormat } from "@prisma/client";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  isReportRequestValidationError,
  parseReportRequest,
} from "@/server/reports/report-definition-service";
import { isReportRunError, runReport } from "@/server/reports/report-export-service";

const runRequestSchema = z.object({
  formats: z.array(z.nativeEnum(ReportFormat)).min(1).max(2),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

    const formatsParsed = runRequestSchema.safeParse(body);
    if (!formatsParsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_REPORT_FORMATS", message: "يجب تحديد صيغة تصدير واحدة على الأقل" } },
        { status: 400 }
      );
    }

    const { formats: _formats, ...reportPayload } = body ?? {};
    const request = parseReportRequest(reportPayload);

    const result = await runReport({
      request,
      formats: formatsParsed.data.formats,
      requestedBy: session.username,
    });

    return NextResponse.json({ run: result });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (isReportRequestValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }

    if (isReportRunError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }

    console.error("Report run API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_RUN_FAILED", message: "تعذر تنفيذ التقرير" } },
      { status: 500 }
    );
  }
}
