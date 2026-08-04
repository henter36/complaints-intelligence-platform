import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { ImportValidationError } from "@/server/imports/import-errors";
import { importDetailValuesAsKeywords } from "@/server/classifications/imported-detail-values-service";

type RouteContext = { params: Promise<{ classificationId: string }> };

/**
 * @deprecated Prefer adding draft keywords in the UI and saving via
 * PATCH /api/classifications/[classificationId]. Kept for temporary API compatibility.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(request);
    const { classificationId } = await context.params;
    const body = await request.json();
    const result = await importDetailValuesAsKeywords({
      classificationId,
      values: body.values,
      actor: session.username,
    });
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (error instanceof ImportValidationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status }
      );
    }
    console.error("Imported keyword update failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: { code: "IMPORTED_KEYWORD_UPDATE_FAILED", message: "تعذر إضافة الكلمات المحددة" } },
      { status: 500 }
    );
  }
}
