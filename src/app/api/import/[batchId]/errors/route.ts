import { NextRequest, NextResponse } from "next/server";
import { ImportRowValidationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { buildImportErrorCsv } from "@/server/imports/error-report";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

function safeReportFileName(fileName: string): string {
  return fileName.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 80);
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(request);
    const { batchId } = await context.params;
    const batch = await db.importBatch.findUnique({
      where: { id: batchId },
      select: { id: true, originalFileName: true },
    });
    if (!batch) {
      return NextResponse.json(
        { error: { code: "IMPORT_BATCH_NOT_FOUND", message: "دفعة الاستيراد غير موجودة" } },
        { status: 404 }
      );
    }

    const rows = await db.importBatchRow.findMany({
      where: {
        importBatchId: batchId,
        validationStatus: {
          in: [ImportRowValidationStatus.INVALID, ImportRowValidationStatus.WARNING],
        },
      },
      select: {
        rowNumber: true,
        action: true,
        validationStatus: true,
        validationErrors: true,
        validationWarnings: true,
        externalId: true,
        rawData: true,
        normalizedData: true,
      },
      orderBy: { rowNumber: "asc" },
    });

    await writeAuditLog(db, {
      action: "IMPORT_ERROR_REPORT_DOWNLOADED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor: session.username,
    });

    return new NextResponse(buildImportErrorCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeReportFileName(batch.originalFileName)}-errors.csv"`,
      },
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: { code: "IMPORT_ERROR_REPORT_FAILED", message: "تعذر تنزيل تقرير الأخطاء" } },
      { status: 500 }
    );
  }
}
