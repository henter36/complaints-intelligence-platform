import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { reprocessImportBatch } from "@/server/imports/excel-import-service";
import { toImportErrorResponse } from "@/server/imports/import-errors";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    await requireAdminApiSession(request);
    const { batchId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const result = await reprocessImportBatch(batchId, body.mapping);
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    const importResponse = toImportErrorResponse(error);
    if (importResponse) return NextResponse.json(importResponse.body, { status: importResponse.status });
    return NextResponse.json(
      { error: { code: "IMPORT_REPROCESS_FAILED", message: "تعذر إعادة معالجة الدفعة" } },
      { status: 500 }
    );
  }
}
