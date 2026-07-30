import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isReportRequestValidationError } from "@/server/reports/report-definition-service";
import {
  createReportTemplate,
  createTemplateSchema,
  isReportTemplateError,
  listReportTemplates,
} from "@/server/reports/report-template-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    const templates = await listReportTemplates(includeInactive);
    return NextResponse.json({ templates });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    console.error("List report templates API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_TEMPLATES_LIST_FAILED", message: "تعذر جلب القوالب" } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = await req.json().catch(() => null);
    const parsed = createTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_TEMPLATE_INPUT", message: parsed.error.issues[0]?.message ?? "بيانات القالب غير صالحة" } },
        { status: 400 }
      );
    }

    const template = await createReportTemplate(parsed.data, session.username);
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (isReportRequestValidationError(error) || isReportTemplateError(error)) {
      const status = "status" in error ? error.status : 400;
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status });
    }

    console.error("Create report template API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_TEMPLATE_CREATE_FAILED", message: "تعذر إنشاء القالب" } },
      { status: 500 }
    );
  }
}
