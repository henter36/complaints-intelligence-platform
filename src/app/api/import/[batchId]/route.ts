import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { deleteUnconfirmedImportBatch } from "@/server/imports/import-batch-deletion-service";
import { loadImportBatchForResume } from "@/server/imports/excel-import-service";
import { toImportErrorResponse } from "@/server/imports/import-errors";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireAdminApiSession(request);
    const { batchId } = await context.params;
    if (request.nextUrl.searchParams.get("resume") === "true") {
      return NextResponse.json(await loadImportBatchForResume(batchId));
    }
    const batch = await db.importBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        originalFileName: true,
        fileSize: true,
        fileHash: true,
        periodType: true,
        periodStart: true,
        periodEnd: true,
        status: true,
        totalRows: true,
        validRows: true,
        invalidRows: true,
        warningRows: true,
        newRows: true,
        updatedRows: true,
        duplicateRows: true,
        rejectedRows: true,
        noChangeRows: true,
        selectedSheet: true,
        columnMapping: true,
        failureCode: true,
        confirmationFailureCode: true,
        rollbackFailureCode: true,
        rollbackReason: true,
        appliedCreatedRows: true,
        appliedUpdatedRows: true,
        confirmedAt: true,
        rolledBackAt: true,
        notes: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!batch) {
      return NextResponse.json(
        { error: { code: "IMPORT_BATCH_NOT_FOUND", message: "دفعة الاستيراد غير موجودة" } },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ...batch,
      fileHashShort: batch.fileHash.slice(0, 12),
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    const importResponse = toImportErrorResponse(error);
    if (importResponse) return NextResponse.json(importResponse.body, { status: importResponse.status });

    console.error("Import batch lookup failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: { code: "IMPORT_BATCH_LOOKUP_FAILED", message: "تعذر قراءة دفعة الاستيراد" } },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(request);
    const { batchId } = await context.params;
    return NextResponse.json(await deleteUnconfirmedImportBatch(batchId, session.username));
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    const importResponse = toImportErrorResponse(error);
    if (importResponse) return NextResponse.json(importResponse.body, { status: importResponse.status });
    console.error("Import batch deletion failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: { code: "IMPORT_BATCH_DELETE_FAILED", message: "تعذر حذف دفعة الاستيراد" } },
      { status: 500 }
    );
  }
}
