import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { getRepeatComplainantPeoplePage } from "@/server/analytics/repeat-complainants/repeat-complainant-people-service";

/**
 * `facility` is OPTIONAL (spec: "قائمة موحدة" view) — present, this scopes
 * the person list (and every number on each row) to that ONE facility;
 * absent, it returns the org-wide repeated-people list instead (same
 * underlying `buildRepeatComplainantDirectory` call either way — see
 * repeat-complainant-people-service.ts).
 */
export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
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
