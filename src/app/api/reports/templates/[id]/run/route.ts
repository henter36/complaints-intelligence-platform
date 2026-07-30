import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ReportFormat } from "@prisma/client";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isReportRequestValidationError } from "@/server/reports/report-definition-service";
import { isReportRunError } from "@/server/reports/report-export-service";
import { isReportTemplateError, runReportTemplate } from "@/server/reports/report-template-service";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const runTemplateSchema = z.object({
  formats: z.array(z.nativeEnum(ReportFormat)).min(1).max(2).optional(),
});

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const parsed = runTemplateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_REPORT_FORMATS", message: "صيغ التصدير غير صالحة" } },
        { status: 400 }
      );
    }

    const result = await runReportTemplate(id, session.username, { formats: parsed.data.formats });
    return NextResponse.json({ run: result });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (isReportRequestValidationError(error) || isReportTemplateError(error) || isReportRunError(error)) {
      const status = "status" in error ? error.status : 400;
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status });
    }

    console.error("Run report template API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_TEMPLATE_RUN_FAILED", message: "تعذر تشغيل القالب" } },
      { status: 500 }
    );
  }
}
