import { ComplaintStatus } from "@prisma/client";

export const OPEN_COMPLAINT_STATUSES = new Set<ComplaintStatus>([
  ComplaintStatus.NEW,
  ComplaintStatus.OPEN,
  ComplaintStatus.IN_PROGRESS,
  ComplaintStatus.AWAITING_RESPONSE,
]);

export const CLOSED_COMPLAINT_STATUSES = new Set<ComplaintStatus>([
  ComplaintStatus.RESOLVED,
  ComplaintStatus.CLOSED,
]);

export const TERMINAL_COMPLAINT_STATUSES = new Set<ComplaintStatus>([
  ComplaintStatus.RESOLVED,
  ComplaintStatus.CLOSED,
  ComplaintStatus.CANCELLED,
]);

export function isOpenComplaintStatus(status: ComplaintStatus): boolean {
  return OPEN_COMPLAINT_STATUSES.has(status);
}

export function isClosedComplaintStatus(status: ComplaintStatus): boolean {
  return CLOSED_COMPLAINT_STATUSES.has(status);
}

export function isTerminalComplaintStatus(status: ComplaintStatus): boolean {
  return TERMINAL_COMPLAINT_STATUSES.has(status);
}

export function isClosedStatus(status: ComplaintStatus): boolean {
  return isTerminalComplaintStatus(status);
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

  if (fromStatus === toStatus) {
    return;
  }

  if (isReopenTransition(fromStatus, toStatus) && !options.reopenReason?.trim()) {
    throw new Error("Reopening a closed complaint requires a documented reason.");
  }

  const allowed = ALLOWED_STATUS_TRANSITIONS[fromStatus] ?? new Set<ComplaintStatus>();
  if (!allowed.has(toStatus)) {
    throw new Error("Invalid complaint status transition.");
  }
}

export function assertClosedAtMatchesStatus(
  status: ComplaintStatus,
  closedAt?: Date | null
) {
  if (closedAt && !isClosedStatus(status)) {
    throw new Error("closedAt cannot be set unless the complaint is terminal.");
  }

  if (isClosedComplaintStatus(status) && !closedAt) {
    throw new Error("closedAt is required when closing or resolving a complaint.");
  }
}

export function parseComplaintStatus(value: string | null): ComplaintStatus | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "REOPENED") return ComplaintStatus.OPEN;
  if (normalized === "REJECTED") return ComplaintStatus.CANCELLED;
  return Object.values(ComplaintStatus).find((status) => status === normalized);
}

const ALLOWED_STATUS_TRANSITIONS: Record<ComplaintStatus, Set<ComplaintStatus>> = {
  [ComplaintStatus.NEW]: new Set([
    ComplaintStatus.OPEN,
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.CANCELLED,
  ]),
  [ComplaintStatus.OPEN]: new Set([
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.AWAITING_RESPONSE,
    ComplaintStatus.RESOLVED,
    ComplaintStatus.CLOSED,
    ComplaintStatus.CANCELLED,
  ]),
  [ComplaintStatus.IN_PROGRESS]: new Set([
    ComplaintStatus.AWAITING_RESPONSE,
    ComplaintStatus.RESOLVED,
    ComplaintStatus.CLOSED,
    ComplaintStatus.CANCELLED,
  ]),
  [ComplaintStatus.AWAITING_RESPONSE]: new Set([
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.RESOLVED,
    ComplaintStatus.CLOSED,
    ComplaintStatus.CANCELLED,
  ]),
  [ComplaintStatus.RESOLVED]: new Set([
    ComplaintStatus.CLOSED,
    ComplaintStatus.OPEN,
  ]),
  [ComplaintStatus.CLOSED]: new Set([
    ComplaintStatus.OPEN,
  ]),
  [ComplaintStatus.CANCELLED]: new Set([
    ComplaintStatus.OPEN,
  ]),
};
