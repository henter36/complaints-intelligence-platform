import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  disableReportSchedule,
  isReportScheduleError,
  scheduleUpdateSchema,
  updateReportSchedule,
} from "@/server/reports/report-schedule-service";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function handleError(error: unknown) {
  const authResponse = mapAuthError(error);
  if (authResponse) return authResponse;
  if (isReportScheduleError(error)) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  console.error("Report schedule API error:", error);
  return NextResponse.json(
    { error: { code: "REPORT_SCHEDULE_REQUEST_FAILED", message: "تعذر تنفيذ الطلب" } },
    { status: 500 }
  );
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const body = await req.json().catch(() => null);
    const parsed = scheduleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_SCHEDULE_INPUT", message: parsed.error.issues[0]?.message ?? "بيانات غير صالحة" } },
        { status: 400 }
      );
    }
    const schedule = await updateReportSchedule(id, parsed.data, session.username);
    return NextResponse.json({ schedule });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const schedule = await disableReportSchedule(id, session.username);
    return NextResponse.json({ schedule });
  } catch (error) {
    return handleError(error);
  }
}
