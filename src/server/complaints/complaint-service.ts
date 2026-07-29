import { ComplaintStatus, type Complaint, type Prisma } from "@prisma/client";
import { writeAuditLog, AUDIT_ACTOR_SYSTEM } from "@/server/audit/audit-log-service";
import {
  assertClosedAtMatchesStatus,
  assertComplaintStatusTransition,
} from "./status";

export type ComplaintServiceClient = Pick<
  Prisma.TransactionClient,
  "complaint" | "complaintStatusHistory" | "auditLog"
>;

export async function createComplaint(
  db: ComplaintServiceClient,
  input: Prisma.ComplaintUncheckedCreateInput,
  options: { actor?: string; importBatchId?: string | null } = {}
): Promise<Complaint> {
  const inputStatus = input.status ?? ComplaintStatus.NEW;
  const inputClosedAt = input.closedAt instanceof Date ? input.closedAt : null;
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
    actor?: string;
    reason?: string | null;
    importBatchId?: string | null;
    changedAt?: Date;
    closedAt?: Date | null;
  } = {}
): Promise<Complaint> {
  const existing = await db.complaint.findUniqueOrThrow({ where: { id: complaintId } });
  assertComplaintStatusTransition(existing.status, toStatus, { reopenReason: options.reason });

  const closedAt = toStatus === ComplaintStatus.CLOSED
    ? options.closedAt ?? options.changedAt ?? new Date()
    : options.closedAt ?? null;
  assertClosedAtMatchesStatus(toStatus, closedAt);

  const complaint = await db.complaint.update({
    where: { id: complaintId },
    data: {
      status: toStatus,
      closedAt,
      version: { increment: 1 },
    },
  });

  await db.complaintStatusHistory.create({
    data: {
      complaintId,
      fromStatus: existing.status,
      toStatus,
      changedAt: options.changedAt ?? new Date(),
      changedBy: options.actor ?? AUDIT_ACTOR_SYSTEM,
      reason: options.reason ?? null,
      importBatchId: options.importBatchId ?? null,
    },
  });

  await writeAuditLog(db, {
    action: "COMPLAINT_STATUS_CHANGED",
    entityType: "Complaint",
    entityId: complaintId,
    actor: options.actor,
    metadata: { fromStatus: existing.status, toStatus },
  });

  return complaint;
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
