import { ComplaintStatus, type Complaint, type Prisma, type PrismaClient } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import {
  assertClosedAtMatchesStatus,
  assertComplaintStatusTransition,
} from "./status";

export type ComplaintServiceClient = Pick<
  PrismaClient,
  "complaint" | "complaintStatusHistory" | "auditLog" | "$transaction"
>;

export class ComplaintValidationError extends Error {
  readonly code = "COMPLAINT_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ComplaintValidationError";
  }
}

export class ComplaintConcurrencyError extends Error {
  readonly code = "COMPLAINT_VERSION_CONFLICT";

  constructor(message = "Complaint was modified by another operation") {
    super(message);
    this.name = "ComplaintConcurrencyError";
  }
}

export class ComplaintNotFoundError extends Error {
  readonly code = "COMPLAINT_NOT_FOUND";

  constructor(_complaintId: string) {
    super("Complaint was not found");
    this.name = "ComplaintNotFoundError";
  }
}

export function isComplaintConcurrencyError(error: unknown): error is ComplaintConcurrencyError {
  return error instanceof ComplaintConcurrencyError;
}

export function getComplaintServiceErrorStatus(error: unknown): number | undefined {
  if (error instanceof ComplaintNotFoundError) return 404;
  if (error instanceof ComplaintConcurrencyError) return 409;
  if (error instanceof ComplaintValidationError) return 400;
  return undefined;
}

export function normalizeOptionalDateTime(
  value: Date | string | null | undefined,
  fieldName: string
): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new ComplaintValidationError(`${fieldName} must be a valid date`);
  }

  return parsed;
}

export async function createComplaint(
  db: ComplaintServiceClient,
  input: Prisma.ComplaintUncheckedCreateInput,
  options: { actor?: string; importBatchId?: string | null } = {}
): Promise<Complaint> {
  const inputStatus = input.status ?? ComplaintStatus.NEW;
  const inputClosedAt = normalizeOptionalDateTime(input.closedAt ?? null, "closedAt");
  assertClosedAtMatchesStatus(inputStatus, inputClosedAt);

  const complaint = await db.complaint.create({
    data: {
      ...input,
      importBatchId: input.importBatchId ?? options.importBatchId ?? null,
    },
  });

  await db.complaintStatusHistory.create({
    data: {
      complaintId: complaint.id,
      fromStatus: null,
      toStatus: complaint.status,
      changedBy: options.actor ?? AUDIT_ACTOR_SYSTEM,
      reason: "Complaint created",
      importBatchId: options.importBatchId ?? input.importBatchId ?? null,
    },
  });

  await writeAuditLog(db, {
    action: "COMPLAINT_CREATED",
    entityType: "Complaint",
    entityId: complaint.id,
    actor: options.actor,
    metadata: { status: complaint.status, externalId: complaint.externalId },
  });

  return complaint;
}

export async function updateComplaintStatus(
  db: ComplaintServiceClient,
  complaintId: string,
  toStatus: ComplaintStatus,
  options: {
    expectedVersion: number;
    actor?: string;
    reason?: string | null;
    importBatchId?: string | null;
    changedAt?: Date | string;
    closedAt?: Date | string | null;
  }
): Promise<Complaint> {
  const changedAt = normalizeOptionalDateTime(options.changedAt ?? new Date(), "changedAt")!;
  const requestedClosedAt = normalizeOptionalDateTime(options.closedAt ?? null, "closedAt");

  return db.$transaction(async (tx) => {
    const existing = await tx.complaint.findUnique({ where: { id: complaintId } });
    if (!existing || existing.isDeleted) {
      throw new ComplaintNotFoundError(complaintId);
    }

    assertComplaintStatusTransition(existing.status, toStatus, { reopenReason: options.reason });

    const closedAt = toStatus === ComplaintStatus.CLOSED
      ? requestedClosedAt ?? changedAt
      : requestedClosedAt;
    assertClosedAtMatchesStatus(toStatus, closedAt);

    const result = await tx.complaint.updateMany({
      where: {
        id: complaintId,
        version: options.expectedVersion,
        isDeleted: false,
      },
      data: {
        status: toStatus,
        closedAt,
        version: { increment: 1 },
      },
    });

    if (result.count !== 1) {
      const current = await tx.complaint.findUnique({
        where: { id: complaintId },
        select: { version: true, isDeleted: true },
      });
      if (!current || current.isDeleted) {
        throw new ComplaintNotFoundError(complaintId);
      }

      throw new ComplaintConcurrencyError();
    }

    const complaint = await tx.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint || complaint.isDeleted) {
      throw new ComplaintNotFoundError(complaintId);
    }

    await tx.complaintStatusHistory.create({
      data: {
        complaintId,
        fromStatus: existing.status,
        toStatus,
        changedAt,
        changedBy: options.actor ?? AUDIT_ACTOR_SYSTEM,
        reason: options.reason ?? null,
        importBatchId: options.importBatchId ?? null,
      },
    });

    await writeAuditLog(tx, {
      action: "COMPLAINT_STATUS_CHANGED",
      entityType: "Complaint",
      entityId: complaintId,
      actor: options.actor,
      metadata: { fromStatus: existing.status, toStatus },
    });

    return complaint;
  });
}

export async function softDeleteComplaint(
  db: ComplaintServiceClient,
  complaintId: string,
  options: { actor?: string; deletedAt?: Date } = {}
): Promise<Complaint> {
  const deletedAt = options.deletedAt ?? new Date();
  const complaint = await db.complaint.update({
    where: { id: complaintId },
    data: {
      isDeleted: true,
      deletedAt,
      version: { increment: 1 },
    },
  });

  await writeAuditLog(db, {
    action: "COMPLAINT_SOFT_DELETED",
    entityType: "Complaint",
    entityId: complaintId,
    actor: options.actor,
  });

  return complaint;
}
