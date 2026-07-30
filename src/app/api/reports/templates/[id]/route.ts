import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isReportRequestValidationError } from "@/server/reports/report-definition-service";
import {
  disableReportTemplate,
  getReportTemplateOrThrow,
  isReportTemplateError,
  updateReportTemplate,
  updateTemplateSchema,
} from "@/server/reports/report-template-service";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function handleError(error: unknown) {
  const authResponse = mapAuthError(error);
  if (authResponse) return authResponse;

  if (isReportRequestValidationError(error) || isReportTemplateError(error)) {
    const status = "status" in error ? error.status : 400;
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status });
  }

  console.error("Report template API error:", error);
  return NextResponse.json(
    { error: { code: "REPORT_TEMPLATE_REQUEST_FAILED", message: "تعذر تنفيذ الطلب" } },
    { status: 500 }
  );
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    await requireAdminApiSession(req);
    const { id } = await context.params;
    const template = await getReportTemplateOrThrow(id);
    return NextResponse.json({ template });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const body = await req.json().catch(() => null);
    const parsed = updateTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_TEMPLATE_INPUT", message: parsed.error.issues[0]?.message ?? "بيانات غير صالحة" } },
        { status: 400 }
      );
    }
    const template = await updateReportTemplate(id, parsed.data, session.username);
    return NextResponse.json({ template });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const template = await disableReportTemplate(id, session.username);
    return NextResponse.json({ template });
  } catch (error) {
    return handleError(error);
  }
}
