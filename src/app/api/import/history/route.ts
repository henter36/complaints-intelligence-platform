import { NextRequest, NextResponse } from "next/server";
import { ImportBatchStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { DELETABLE_IMPORT_BATCH_STATUSES } from "@/server/imports/import-batch-deletion-service";

const RESUMABLE_IMPORT_BATCH_STATUSES = new Set<ImportBatchStatus>([
  ImportBatchStatus.UPLOADED,
  ImportBatchStatus.PARSING,
  ImportBatchStatus.VALIDATED,
  ImportBatchStatus.READY_FOR_CONFIRMATION,
  ImportBatchStatus.FAILED,
]);

function toLegacyPeriodType(periodType: string): string {
  return periodType.toLowerCase();
}

function toLegacyBatchStatus(status: string): string {
  switch (status) {
    case "READY_FOR_CONFIRMATION":
      return "preview";
    case "CONFIRMED":
      return "approved";
    case "FAILED":
      return "error";
    case "ROLLING_BACK":
      return "rolling_back";
    case "ROLLED_BACK":
      return "rejected";
    default:
      return status.toLowerCase();
  }
}

export function isRejectedOrFailedImportStatus(status: ImportBatchStatus): boolean {
  return status === ImportBatchStatus.FAILED || status === ImportBatchStatus.ROLLED_BACK;
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const batches = await db.importBatch.findMany({
      select: {
        id: true,
        fileName: true,
        originalFileName: true,
        fileSize: true,
        periodType: true,
        periodStart: true,
        periodEnd: true,
        status: true,
        totalRows: true,
        validRows: true,
        newRows: true,
        updatedRows: true,
        duplicateRows: true,
        rejectedRows: true,
        warningRows: true,
        noChangeRows: true,
        invalidRows: true,
        selectedSheet: true,
        columnMapping: true,
        failureCode: true,
        confirmationFailureCode: true,
        facilitySyncStatus: true,
        facilitySyncAttempts: true,
        facilitySyncError: true,
        facilitySyncedAt: true,
        rollbackFailureCode: true,
        rollbackReason: true,
        appliedCreatedRows: true,
        appliedUpdatedRows: true,
        createdBy: true,
        confirmedAt: true,
        rolledBackAt: true,
        createdAt: true,
        updatedAt: true,
        notes: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(batches.map(batch => {
      const isConfirmed = batch.status === ImportBatchStatus.CONFIRMED;
      const rejectionReason = isRejectedOrFailedImportStatus(batch.status)
        ? batch.notes?.trim() || null
        : null;

      return {
        id: batch.id,
        fileName: batch.originalFileName || batch.fileName,
        fileSize: batch.fileSize,
        periodType: toLegacyPeriodType(batch.periodType),
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        entity: null,
        status: toLegacyBatchStatus(batch.status),
        serverStatus: batch.status,
        canResume: RESUMABLE_IMPORT_BATCH_STATUSES.has(batch.status),
        canDelete: DELETABLE_IMPORT_BATCH_STATUSES.includes(
          batch.status as typeof DELETABLE_IMPORT_BATCH_STATUSES[number]
        ),
        totalRecords: batch.totalRows,
        validRecords: batch.validRows,
        newRecords: batch.newRows,
        updatedRecords: batch.updatedRows,
        duplicateRecords: batch.duplicateRows,
        rejectedRecords: batch.rejectedRows,
        incompleteRecords: batch.invalidRows,
        warningRecords: batch.warningRows,
        noChangeRecords: batch.noChangeRows,
        selectedSheet: batch.selectedSheet,
        failureCode: batch.failureCode,
        confirmationFailureCode: batch.confirmationFailureCode,
        facilitySyncStatus: batch.facilitySyncStatus,
        facilitySyncAttempts: batch.facilitySyncAttempts,
        facilitySyncError: batch.facilitySyncError,
        facilitySyncedAt: batch.facilitySyncedAt,
        rollbackFailureCode: batch.rollbackFailureCode,
        appliedCreatedRows: batch.appliedCreatedRows,
        appliedUpdatedRows: batch.appliedUpdatedRows,
        errorReport: null,
        columnMapping: batch.columnMapping,
        uploadedById: batch.createdBy,
        uploadedBy: { name: batch.createdBy, email: "" },
        // Legacy compatibility: approved fields represent confirmed import batches.
        approvedById: isConfirmed ? batch.createdBy : null,
        approvedBy: isConfirmed ? { name: batch.createdBy, email: "" } : null,
        approvedAt: isConfirmed ? batch.confirmedAt : null,
        rejectedAt: batch.status === ImportBatchStatus.ROLLED_BACK ? batch.rolledBackAt : null,
        rejectionReason,
        rollbackReason: batch.rollbackReason,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
      };
    }));
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Import history error:", error);
    return NextResponse.json({ error: "Failed to fetch import history" }, { status: 500 });
  }
}
