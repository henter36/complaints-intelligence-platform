import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { getRepeatComplainantSummary } from "@/server/analytics/repeat-complainants/repeat-complainant-analytics-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const summary = await getRepeatComplainantSummary(url.searchParams);
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
    console.error("Repeat-complainant analytics API error:", error);
    return NextResponse.json(
      { error: { code: "REPEAT_COMPLAINANTS_FAILED", message: "تعذر جلب تحليل تكرار الشكاوى" } },
      { status: 500 }
    );
  }
}
