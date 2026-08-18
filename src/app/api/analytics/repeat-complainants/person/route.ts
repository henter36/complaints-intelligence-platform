import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { getRepeatComplainantPersonDetail } from "@/server/analytics/repeat-complainants/repeat-complainant-person-detail-service";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    // `facility` is OPTIONAL (spec §12): present -> scope to that one
    // facility; absent -> org-wide across every facility this person
    // appears at ("عرض كل شكاوى هذا الشخص").
    const facility = url.searchParams.get("facility");
    if (!token) {
      return NextResponse.json(
        { error: { code: "TOKEN_REQUIRED", message: "المعامل token مطلوب" } },
        { status: 400 }
      );
    }
    const sortOrder = url.searchParams.get("sortOrder") === "asc" ? "asc" : "desc";
    const detail = await getRepeatComplainantPersonDetail(token, facility, url.searchParams, new Date(), sortOrder);
    if (!detail) {
      return NextResponse.json(
        { error: { code: "COMPLAINANT_NOT_FOUND", message: "تعذر العثور على بيانات هذا الشخص ضمن الفلاتر الحالية" } },
        { status: 404 }
      );
    }
    return NextResponse.json(detail);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    // Never include req.url (may carry the token) in the log line — same
    // "never leak the identifier to logs" rule the token itself upholds.
    console.error("Repeat-complainant person-detail API error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "REPEAT_COMPLAINANT_PERSON_FAILED", message: "تعذر جلب تفاصيل الشخص" } },
      { status: 500 }
    );
  }
}
