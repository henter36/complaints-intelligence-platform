import { ComplaintStatus } from "@prisma/client";

export const OPEN_COMPLAINT_STATUSES = new Set<ComplaintStatus>([
  ComplaintStatus.NEW,
  ComplaintStatus.OPEN,
  ComplaintStatus.IN_PROGRESS,
  ComplaintStatus.AWAITING_RESPONSE,
  ComplaintStatus.RESOLVED,
]);

export function isClosedStatus(status: ComplaintStatus): boolean {
  return status === ComplaintStatus.CLOSED || status === ComplaintStatus.CANCELLED;
}

export function isReopenTransition(
  fromStatus: ComplaintStatus,
  toStatus: ComplaintStatus
): boolean {
  return isClosedStatus(fromStatus) && OPEN_COMPLAINT_STATUSES.has(toStatus);
}

export function assertComplaintStatusTransition(
  fromStatus: ComplaintStatus | null,
  toStatus: ComplaintStatus,
  options: { reopenReason?: string | null } = {}
) {
  if (!fromStatus) {
    return;
  }

  if (isReopenTransition(fromStatus, toStatus) && !options.reopenReason?.trim()) {
    throw new Error("Reopening a closed complaint requires a documented reason.");
  }
}

export function assertClosedAtMatchesStatus(
  status: ComplaintStatus,
  closedAt?: Date | null
) {
  if (closedAt && !isClosedStatus(status)) {
    throw new Error("closedAt cannot be set unless the complaint is closed or cancelled.");
  }

  if (status === ComplaintStatus.CLOSED && !closedAt) {
    throw new Error("closedAt is required when closing a complaint.");
  }
}

export function parseComplaintStatus(value: string | null): ComplaintStatus | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "REOPENED") return ComplaintStatus.OPEN;
  if (normalized === "REJECTED") return ComplaintStatus.CANCELLED;
  return Object.values(ComplaintStatus).find((status) => status === normalized);
}

export function toLegacyStatus(status: ComplaintStatus): string {
  switch (status) {
    case ComplaintStatus.NEW:
    case ComplaintStatus.OPEN:
      return "open";
    case ComplaintStatus.IN_PROGRESS:
      return "in_progress";
    case ComplaintStatus.AWAITING_RESPONSE:
      return "awaiting_response";
    case ComplaintStatus.RESOLVED:
      return "resolved";
    case ComplaintStatus.CLOSED:
      return "closed";
    case ComplaintStatus.CANCELLED:
      return "rejected";
  }
}
