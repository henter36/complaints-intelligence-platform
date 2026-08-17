import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { getRepeatComplainantPeoplePage } from "@/server/analytics/repeat-complainants/repeat-complainant-people-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    if (!url.searchParams.get("facility")) {
      return NextResponse.json(
        { error: { code: "FACILITY_REQUIRED", message: "معامل السجن (facility) مطلوب" } },
        { status: 400 }
      );
    }
    const page = await getRepeatComplainantPeoplePage(url.searchParams);
    return NextResponse.json(page);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("Repeat-complainant people API error:", error);
    return NextResponse.json(
      { error: { code: "REPEAT_COMPLAINANT_PEOPLE_FAILED", message: "تعذر جلب قائمة الأشخاص" } },
      { status: 500 }
    );
  }
}
