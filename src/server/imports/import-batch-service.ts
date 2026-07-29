import {
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  type ImportBatch,
  type Prisma,
} from "@prisma/client";
import { writeAuditLog } from "@/server/audit/audit-log-service";

export type ImportBatchServiceClient = Pick<
  Prisma.TransactionClient,
  "importBatch" | "importBatchRow" | "auditLog"
>;

export function calculateRowCounters(rows: Array<{
  action: ImportRowAction;
  validationStatus: ImportRowValidationStatus;
}>) {
  return {
    totalRows: rows.length,
    validRows: rows.filter((row) =>
      row.validationStatus === ImportRowValidationStatus.VALID ||
      row.validationStatus === ImportRowValidationStatus.WARNING
    ).length,
    invalidRows: rows.filter((row) => row.validationStatus === ImportRowValidationStatus.INVALID).length,
    newRows: rows.filter((row) => row.action === ImportRowAction.NEW).length,
    updatedRows: rows.filter((row) => row.action === ImportRowAction.UPDATE).length,
    duplicateRows: rows.filter((row) => row.action === ImportRowAction.DUPLICATE).length,
    rejectedRows: rows.filter((row) => row.action === ImportRowAction.REJECT).length,
    warningRows: rows.filter((row) => row.validationStatus === ImportRowValidationStatus.WARNING).length,
    noChangeRows: rows.filter((row) => row.action === ImportRowAction.NO_CHANGE).length,
  };
}

export async function createImportBatch(
  db: ImportBatchServiceClient,
  input: Prisma.ImportBatchUncheckedCreateInput,
  options: { actor?: string } = {}
): Promise<ImportBatch> {
  const batch = await db.importBatch.create({ data: input });
  await writeAuditLog(db, {
    action: "IMPORT_BATCH_CREATED",
    entityType: "ImportBatch",
    entityId: batch.id,
    actor: options.actor ?? batch.createdBy,
    metadata: { fileHash: batch.fileHash, originalFileName: batch.originalFileName },
  });
  return batch;
}

export async function setImportBatchStatus(
  db: ImportBatchServiceClient,
  batchId: string,
  status: ImportBatchStatus,
  options: { actor?: string; notes?: string | null } = {}
): Promise<ImportBatch> {
  const batch = await db.importBatch.update({
    where: { id: batchId },
    data: {
      status,
      notes: options.notes ?? undefined,
      validatedAt: status === ImportBatchStatus.VALIDATED ? new Date() : undefined,
    },
  });
  await writeAuditLog(db, {
    action: "IMPORT_BATCH_STATUS_CHANGED",
    entityType: "ImportBatch",
    entityId: batch.id,
    actor: options.actor,
    metadata: { status },
  });
  return batch;
}

export async function confirmImportBatch(
  db: ImportBatchServiceClient,
  batchId: string,
  options: { actor?: string; confirmedAt?: Date } = {}
): Promise<ImportBatch> {
  const existing = await db.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (existing.status === ImportBatchStatus.FAILED) {
    throw new Error("Cannot confirm a failed import batch.");
  }
  if (existing.status === ImportBatchStatus.CONFIRMED) {
    throw new Error("Cannot confirm an import batch more than once.");
  }
  if (existing.status !== ImportBatchStatus.READY_FOR_CONFIRMATION) {
    throw new Error("Only batches ready for confirmation can be confirmed.");
  }

  const batch = await db.importBatch.update({
    where: { id: batchId },
    data: {
      status: ImportBatchStatus.CONFIRMED,
      confirmedAt: options.confirmedAt ?? new Date(),
    },
  });
  await writeAuditLog(db, {
    action: "IMPORT_BATCH_CONFIRMED",
    entityType: "ImportBatch",
    entityId: batch.id,
    actor: options.actor,
  });
  return batch;
}

export async function rollbackImportBatch(
  db: ImportBatchServiceClient,
  batchId: string,
  options: { actor?: string; rolledBackAt?: Date } = {}
): Promise<ImportBatch> {
  const existing = await db.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (existing.status !== ImportBatchStatus.CONFIRMED) {
    throw new Error("Only confirmed import batches can be rolled back.");
  }

  const batch = await db.importBatch.update({
    where: { id: batchId },
    data: {
      status: ImportBatchStatus.ROLLED_BACK,
      rolledBackAt: options.rolledBackAt ?? new Date(),
    },
  });
  await writeAuditLog(db, {
    action: "IMPORT_BATCH_ROLLED_BACK",
    entityType: "ImportBatch",
    entityId: batch.id,
    actor: options.actor,
  });
  return batch;
}
