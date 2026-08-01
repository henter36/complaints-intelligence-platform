import { ImportBatchStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import { deleteStoredImportFileForBatch } from "./file-storage";
import { ImportValidationError } from "./import-errors";

export const DELETABLE_IMPORT_BATCH_STATUSES = [
  ImportBatchStatus.UPLOADED,
  ImportBatchStatus.VALIDATED,
  ImportBatchStatus.READY_FOR_CONFIRMATION,
  ImportBatchStatus.FAILED,
] as const;

export async function deleteUnconfirmedImportBatch(
  batchId: string,
  actor = AUDIT_ACTOR_SINGLE_ADMIN
): Promise<{ deleted: true; storageCleanup: "DELETED" | "NOT_FOUND" | "NO_FILE" | "FAILED" }> {
  const storageKey = await db.$transaction(async (tx) => {
    const batch = await tx.importBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true, storageKey: true, originalFileName: true },
    });
    if (!batch) {
      throw new ImportValidationError("IMPORT_BATCH_NOT_FOUND", "دفعة الاستيراد غير موجودة", 404);
    }
    if (!DELETABLE_IMPORT_BATCH_STATUSES.includes(batch.status as typeof DELETABLE_IMPORT_BATCH_STATUSES[number])) {
      throw new ImportValidationError(
        "IMPORT_BATCH_STATE_CONFLICT",
        "لا يمكن حذف الدفعة في حالتها الحالية. حدّث الصفحة وحاول مجددًا.",
        409
      );
    }

    const complaintsCount = await tx.complaint.count({ where: { importBatchId: batch.id } });
    if (complaintsCount > 0) {
      throw new ImportValidationError(
        "IMPORT_BATCH_HAS_CONFIRMED_COMPLAINTS",
        "لا يمكن حذف دفعة أنشأت شكاوى؛ استخدم التراجع عن الاستيراد.",
        409
      );
    }

    const deleted = await tx.importBatch.deleteMany({
      where: { id: batch.id, status: { in: [...DELETABLE_IMPORT_BATCH_STATUSES] } },
    });
    if (deleted.count !== 1) {
      throw new ImportValidationError(
        "IMPORT_BATCH_STATE_CONFLICT",
        "تغيرت حالة الدفعة في جلسة أخرى. حدّث الصفحة وحاول مجددًا.",
        409
      );
    }
    await writeAuditLog(tx, {
      action: "IMPORT_BATCH_DELETED",
      entityType: "ImportBatch",
      entityId: batch.id,
      actor,
      metadata: { originalFileName: batch.originalFileName, deletionMode: "HARD_DELETE_UNCONFIRMED" },
    });
    return batch.storageKey;
  });

  try {
    const storageCleanup = await deleteStoredImportFileForBatch(storageKey);
    return { deleted: true, storageCleanup };
  } catch {
    await writeAuditLog(db, {
      action: "IMPORT_BATCH_FILE_CLEANUP_FAILED",
      entityType: "ImportBatch",
      entityId: batchId,
      actor,
      metadata: { cleanupRequired: true },
    });
    return { deleted: true, storageCleanup: "FAILED" };
  }
}
