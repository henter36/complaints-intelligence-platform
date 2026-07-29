import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminApiSession } from "@/server/auth/auth-guard";
import { confirmReadyImportBatch } from "@/server/imports/import-confirmation-service";
import { toImportRouteErrorResponse } from "../route-error-responses";

const approveSchema = z.object({
  batchId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const body = approveSchema.parse(await req.json().catch(() => ({})));
    const result = await confirmReadyImportBatch(body.batchId, { actor: session.username });

    return NextResponse.json(result);
  } catch (error) {
    return toImportRouteErrorResponse(error, {
      validation: {
        error: { code: "IMPORT_BATCH_ID_REQUIRED", message: "معرف دفعة الاستيراد مطلوب" },
      },
      fallback: {
        error: { code: "IMPORT_CONFIRMATION_FAILED", message: "تعذر تأكيد دفعة الاستيراد" },
      },
    });
  }
}
