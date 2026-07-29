import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  confirmReadyImportBatch,
  toImportConfirmationErrorResponse,
} from "@/server/imports/import-confirmation-service";

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
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    const importResponse = toImportConfirmationErrorResponse(error);
    if (importResponse) {
      return NextResponse.json(importResponse.body, { status: importResponse.status });
    }

    return NextResponse.json(
      { error: { code: "IMPORT_CONFIRMATION_FAILED", message: "تعذر تأكيد دفعة الاستيراد" } },
      { status: 500 }
    );
  }
}
