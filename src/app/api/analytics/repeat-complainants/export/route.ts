import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { renderRepeatComplainantBulkPdf } from "@/server/analytics/repeat-complainants/repeat-complainant-bulk-pdf-service";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const includeFullIdentifier = url.searchParams.get("includeFullIdentifier") === "true";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const periodLabel = from && to ? `الفترة من ${from} إلى ${to}` : "الفترة الحالية";
    const facility = url.searchParams.get("facility");
    const regionId = url.searchParams.get("regionId") ?? url.searchParams.get("region");
    const scopeLabel = facility ? `السجن: ${facility}` : regionId ? `المنطقة: ${regionId}` : null;

    const buffer = await renderRepeatComplainantBulkPdf(url.searchParams, {
      includeFullIdentifier,
      periodLabel,
      scopeLabel,
    });

    // Never the raw identifier in a filename (spec §17) — this export has none to begin with.
    const filename = `repeat-complainants-analysis-${todayIsoDate()}.pdf`;
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
    console.error("Repeat-complainant bulk PDF export error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "REPEAT_COMPLAINANT_PDF_FAILED", message: "تعذر إنشاء تقرير PDF" } },
      { status: 500 }
    );
  }
}
