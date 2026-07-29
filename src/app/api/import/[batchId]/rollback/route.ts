import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminApiSession } from "@/server/auth/auth-guard";
import { rollbackConfirmedImportBatch } from "@/server/imports/import-confirmation-service";
import { toImportRouteErrorResponse } from "../../route-error-responses";

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
    return toImportRouteErrorResponse(error, {
      validation: {
        error: { code: "ROLLBACK_REASON_REQUIRED", message: "سبب التراجع مطلوب" },
      },
      fallback: {
        error: { code: "IMPORT_ROLLBACK_FAILED", message: "تعذر التراجع عن دفعة الاستيراد" },
      },
    });
  }
}
