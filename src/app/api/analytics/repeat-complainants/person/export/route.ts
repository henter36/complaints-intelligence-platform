import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { renderRepeatComplainantPersonPdf } from "@/server/analytics/repeat-complainants/repeat-complainant-person-pdf-service";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A filesystem-safe reference derived from the opaque token — never the raw identifier (spec §17). */
function safeReference(token: string): string {
  return token.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 10) || "person";
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    // `facility` is OPTIONAL (spec §12) — see the /person route's own comment.
    const facility = url.searchParams.get("facility");
    if (!token) {
      return NextResponse.json(
        { error: { code: "TOKEN_REQUIRED", message: "المعامل token مطلوب" } },
        { status: 400 }
      );
    }
    const includeFullIdentifier = url.searchParams.get("includeFullIdentifier") === "true";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const periodLabel = from && to ? `الفترة من ${from} إلى ${to}` : "الفترة الحالية";

    const buffer = await renderRepeatComplainantPersonPdf(token, facility, url.searchParams, {
      includeFullIdentifier,
      periodLabel,
    });
    if (!buffer) {
      return NextResponse.json(
        { error: { code: "COMPLAINANT_NOT_FOUND", message: "تعذر العثور على بيانات هذا الشخص ضمن الفلاتر الحالية" } },
        { status: 404 }
      );
    }

    const filename = `complainant-repeat-analysis-${safeReference(token)}-${todayIsoDate()}.pdf`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("Repeat-complainant person PDF export error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "REPEAT_COMPLAINANT_PERSON_PDF_FAILED", message: "تعذر إنشاء تقرير PDF" } },
      { status: 500 }
    );
  }
}
