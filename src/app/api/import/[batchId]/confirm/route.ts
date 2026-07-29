import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/server/auth/auth-guard";
import { confirmReadyImportBatch } from "@/server/imports/import-confirmation-service";
import { toImportRouteErrorResponse } from "../../route-error-responses";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(request);
    const { batchId } = await context.params;
    const result = await confirmReadyImportBatch(batchId, { actor: session.username });

    return NextResponse.json(result);
  } catch (error) {
    return toImportRouteErrorResponse(error, {
      fallback: {
        error: { code: "IMPORT_CONFIRMATION_FAILED", message: "تعذر تأكيد دفعة الاستيراد" },
      },
    });
  }
}
