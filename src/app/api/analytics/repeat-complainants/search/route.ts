import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { searchRepeatComplainants } from "@/server/analytics/repeat-complainants/repeat-complainant-analytics-service";

/**
 * POST, not GET — a name or identifier typed into search must never appear
 * in a URL/query string/browser history (spec §10), unlike the other
 * repeat-complainant endpoints which only ever carry facility/region/date
 * filters that are not personally identifying.
 */
export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const body = await req.json().catch(() => ({}));
    const q = typeof body?.q === "string" ? body.q : "";
    const filters = new URLSearchParams();
    for (const key of [
      "from", "to", "regionId", "region", "facility", "classificationId",
      "minComplaints", "sameTypeOnly", "minDistinctTypes",
    ]) {
      const value = body?.[key];
      if (typeof value === "string" && value) filters.set(key, value);
    }
    const people = await searchRepeatComplainants(q, filters);
    return NextResponse.json({ people });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("Repeat-complainant search API error:", error);
    return NextResponse.json(
      { error: { code: "REPEAT_COMPLAINANT_SEARCH_FAILED", message: "تعذر تنفيذ البحث" } },
      { status: 500 }
    );
  }
}
