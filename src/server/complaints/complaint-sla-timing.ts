import { ComplaintStatus } from "@prisma/client";
import {
  isClosedComplaintStatus,
  isOpenComplaintStatus,
} from "./status";

export const COMPLAINT_SLA_DAYS = 7;
export const COMPLAINT_SLA_DURATION_MS = COMPLAINT_SLA_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ComplaintSlaSnapshot = {
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date | null;
  /** Last update timestamp used as closedAt fallback for closed complaints. */
  lastUpdatedAt: Date | null;
};

export type ComplaintSlaState =
  | "OPEN_WITHIN_SLA"
  | "OPEN_LATE"
  | "CLOSED_WITHIN_SLA"
  | "CLOSED_LATE"
  | "CLOSED_WITHOUT_TRUSTED_DATE"
  | "INELIGIBLE";

export type ComplaintSlaTiming = {
  state: ComplaintSlaState;
  createdAt: Date | null;
  deadline: Date | null;
  isEligible: boolean;
  isCompliant: boolean;
  isCurrentlyLate: boolean;
  wasClosedLate: boolean;
  wasClosedWithinSla: boolean;
  closedWithoutTrustedDate: boolean;
  latenessDays: number | null;
  resolutionDurationDays: number | null;
  openAgeDays: number | null;
};

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function ceilDays(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / DAY_MS));
}

export function resolveComplaintCreatedAt(
  complaint: Pick<ComplaintSlaSnapshot, "complaintDate" | "receivedAt">
): Date | null {
  if (isValidDate(complaint.complaintDate)) return complaint.complaintDate;
  return isValidDate(complaint.receivedAt) ? complaint.receivedAt : null;
}

/**
 * Effective closure timestamp for SLA and trend calculations.
 * Priority: trusted closedAt, then lastUpdatedAt for closed statuses only.
 */
export function resolveComplaintEffectiveClosedAt(
  complaint: ComplaintSlaSnapshot
): Date | null {
  if (!isClosedComplaintStatus(complaint.status)) {
    return null;
  }

  const createdAt = resolveComplaintCreatedAt(complaint);
  if (!createdAt) return null;

  if (isValidDate(complaint.closedAt) && complaint.closedAt.getTime() >= createdAt.getTime()) {
    return complaint.closedAt;
  }

  if (
    isValidDate(complaint.lastUpdatedAt)
    && complaint.lastUpdatedAt.getTime() >= createdAt.getTime()
  ) {
    return complaint.lastUpdatedAt;
  }

  return null;
}

function resolveState(
  complaint: ComplaintSlaSnapshot,
  createdAt: Date | null,
  deadline: Date | null,
  measuredAt: Date,
  effectiveClosedAt: Date | null
): ComplaintSlaState {
  if (!createdAt || !deadline || !isValidDate(measuredAt)) return "INELIGIBLE";

  if (isOpenComplaintStatus(complaint.status)) {
    return measuredAt > deadline ? "OPEN_LATE" : "OPEN_WITHIN_SLA";
  }

  if (!isClosedComplaintStatus(complaint.status)) {
    return "INELIGIBLE";
  }

  if (!effectiveClosedAt) {
    return "CLOSED_WITHOUT_TRUSTED_DATE";
  }

  // Exact deadline equality is compliant (not late).
  return effectiveClosedAt.getTime() > deadline.getTime()
    ? "CLOSED_LATE"
    : "CLOSED_WITHIN_SLA";
}

export function buildComplaintSlaTiming(
  complaint: ComplaintSlaSnapshot,
  measuredAt = new Date()
): ComplaintSlaTiming {
  const createdAt = resolveComplaintCreatedAt(complaint);
  const deadline = createdAt
    ? new Date(createdAt.getTime() + COMPLAINT_SLA_DURATION_MS)
    : null;
  const effectiveClosedAt = resolveComplaintEffectiveClosedAt(complaint);
  const state = resolveState(complaint, createdAt, deadline, measuredAt, effectiveClosedAt);
  const isCurrentlyLate = state === "OPEN_LATE";
  const wasClosedLate = state === "CLOSED_LATE";
  const wasClosedWithinSla = state === "CLOSED_WITHIN_SLA";
  const isEligible = [
    "OPEN_WITHIN_SLA",
    "OPEN_LATE",
    "CLOSED_WITHIN_SLA",
    "CLOSED_LATE",
  ].includes(state);
  const isCompliant = state === "OPEN_WITHIN_SLA" || wasClosedWithinSla;
  const closedWithoutTrustedDate = state === "CLOSED_WITHOUT_TRUSTED_DATE";
  const lateReference = wasClosedLate && effectiveClosedAt
    ? effectiveClosedAt
    : measuredAt;
  const latenessDays = deadline && (isCurrentlyLate || wasClosedLate)
    ? ceilDays(lateReference.getTime() - deadline.getTime())
    : null;
  const resolutionDurationDays = createdAt && effectiveClosedAt
    ? (effectiveClosedAt.getTime() - createdAt.getTime()) / DAY_MS
    : null;
  const openAgeDays =
    createdAt && isValidDate(measuredAt) && isOpenComplaintStatus(complaint.status)
      ? ceilDays(measuredAt.getTime() - createdAt.getTime())
      : null;

  return {
    state,
    createdAt,
    deadline,
    isEligible,
    isCompliant,
    isCurrentlyLate,
    wasClosedLate,
    wasClosedWithinSla,
    closedWithoutTrustedDate,
    latenessDays,
    resolutionDurationDays,
    openAgeDays,
  };
}
