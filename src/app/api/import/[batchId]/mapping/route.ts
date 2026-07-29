import { NextRequest, NextResponse } from "next/server";
import { ImportBatchStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { parseColumnMapping, validateColumnMapping } from "@/server/imports/complaint-column-schema";
import { toImportErrorResponse } from "@/server/imports/import-errors";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

const MAPPING_EDITABLE_STATUSES = new Set<ImportBatchStatus>([
  ImportBatchStatus.UPLOADED,
  ImportBatchStatus.VALIDATED,
  ImportBatchStatus.READY_FOR_CONFIRMATION,
  ImportBatchStatus.FAILED,
]);

function parseMapping(value: unknown) {
  const mapping = parseColumnMapping(value);
  if (!mapping) {
    throw new TypeError("mapping must be a non-empty object");
  }

  validateColumnMapping(mapping);
  return mapping;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(request);
    const { batchId } = await context.params;
    const body = await request.json();
    const mapping = parseMapping(body.mapping);

    const batch = await db.importBatch.findUnique({ where: { id: batchId }, select: { id: true, status: true } });
    if (!batch) {
      return NextResponse.json(
        { error: { code: "IMPORT_BATCH_NOT_FOUND", message: "دفعة الاستيراد غير موجودة" } },
        { status: 404 }
      );
    }

    if (!MAPPING_EDITABLE_STATUSES.has(batch.status)) {
      return NextResponse.json(
        { error: { code: "IMPORT_BATCH_STATE_CONFLICT", message: "لا يمكن تعديل المطابقة في الحالة الحالية" } },
        { status: 409 }
      );
    }

    await db.importBatch.update({
      where: { id: batchId },
      data: { columnMapping: mapping },
    });
    await writeAuditLog(db, {
      action: "IMPORT_MAPPING_SAVED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor: session.username,
    });

    return NextResponse.json({ ok: true, batchId, columnMapping: mapping });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    const importResponse = toImportErrorResponse(error);
    if (importResponse) return NextResponse.json(importResponse.body, { status: importResponse.status });
    if (error instanceof TypeError) {
      return NextResponse.json(
        { error: { code: "INVALID_COLUMN_MAPPING", message: "مطابقة الأعمدة غير صالحة" } },
        { status: 422 }
      );
    }
    return NextResponse.json(
      { error: { code: "IMPORT_MAPPING_FAILED", message: "تعذر حفظ مطابقة الأعمدة" } },
      { status: 500 }
    );
  }
}
