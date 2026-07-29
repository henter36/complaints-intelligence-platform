import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  rollbackConfirmedImportBatch,
  toImportConfirmationErrorResponse,
} from "@/server/imports/import-confirmation-service";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

const rollbackSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(request);
    const { batchId } = await context.params;
    const body = rollbackSchema.parse(await request.json().catch(() => ({})));
    const result = await rollbackConfirmedImportBatch(batchId, {
      reason: body.reason,
      actor: session.username,
    });

    return NextResponse.json(result);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: { code: "ROLLBACK_REASON_REQUIRED", message: "سبب التراجع مطلوب" } },
        { status: 422 }
      );
    }

    const importResponse = toImportConfirmationErrorResponse(error);
    if (importResponse) {
      return NextResponse.json(importResponse.body, { status: importResponse.status });
    }

    return NextResponse.json(
      { error: { code: "IMPORT_ROLLBACK_FAILED", message: "تعذر التراجع عن دفعة الاستيراد" } },
      { status: 500 }
    );
  }
}
