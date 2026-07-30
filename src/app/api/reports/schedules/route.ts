import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isReportTemplateError } from "@/server/reports/report-template-service";
import {
  createReportSchedule,
  isReportScheduleError,
  listReportSchedules,
  scheduleInputSchema,
} from "@/server/reports/report-schedule-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const schedules = await listReportSchedules();
    return NextResponse.json({ schedules });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    console.error("List report schedules API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_SCHEDULES_LIST_FAILED", message: "تعذر جلب الجداول" } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = await req.json().catch(() => null);
    const parsed = scheduleInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_SCHEDULE_INPUT", message: parsed.error.issues[0]?.message ?? "بيانات الجدولة غير صالحة" } },
        { status: 400 }
      );
    }

    const schedule = await createReportSchedule(parsed.data, session.username);
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (isReportScheduleError(error) || isReportTemplateError(error)) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }

    console.error("Create report schedule API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_SCHEDULE_CREATE_FAILED", message: "تعذر إنشاء الجدولة" } },
      { status: 500 }
    );
  }
}
