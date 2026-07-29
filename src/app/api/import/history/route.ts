import { NextResponse } from "next/server";
import { db } from "@/lib/db";

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
    case "ROLLED_BACK":
      return "rejected";
    default:
      return status.toLowerCase();
  }
}

export async function GET() {
  try {
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
        invalidRows: true,
        createdBy: true,
        confirmedAt: true,
        createdAt: true,
        updatedAt: true,
        notes: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(batches.map(batch => ({
      id: batch.id,
      fileName: batch.originalFileName || batch.fileName,
      fileSize: batch.fileSize,
      periodType: toLegacyPeriodType(batch.periodType),
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      entity: null,
      status: toLegacyBatchStatus(batch.status),
      totalRecords: batch.totalRows,
      validRecords: batch.validRows,
      newRecords: batch.newRows,
      updatedRecords: batch.updatedRows,
      duplicateRecords: batch.duplicateRows,
      rejectedRecords: batch.rejectedRows,
      incompleteRecords: batch.invalidRows,
      errorReport: null,
      columnMapping: null,
      uploadedById: batch.createdBy,
      uploadedBy: { name: batch.createdBy, email: "" },
      approvedById: batch.confirmedAt ? batch.createdBy : null,
      approvedBy: batch.confirmedAt ? { name: batch.createdBy, email: "" } : null,
      approvedAt: batch.confirmedAt,
      rejectedAt: null,
      rejectionReason: batch.notes,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    })));
  } catch (error) {
    console.error("Import history error:", error);
    return NextResponse.json({ error: "Failed to fetch import history" }, { status: 500 });
  }
}
