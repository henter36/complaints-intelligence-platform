import { ComplaintStatus } from "@prisma/client";
import {
  isClosedComplaintStatus,
  isOpenComplaintStatus,
} from "./status";

export const COMPLAINT_SLA_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ComplaintTimingSnapshot = {
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  /** Retained for import/data-quality compatibility; SLA calculations ignore it. */
  dueDate: Date | null;
  closedAt: Date | null;
};

export type ComplaintSlaState =
  | "OPEN_WITHIN_SLA"
  | "OPEN_LATE"
  | "CLOSED_WITHIN_SLA"
  | "CLOSED_LATE"
  | "CLOSED_WITHOUT_TRUSTED_DATE"
  | "INELIGIBLE";

export type ComplaintTimingInfo = {
  slaState: ComplaintSlaState;
  slaDeadline: Date | null;
  isSlaEligible: boolean;
  isCompliantWithinSla: boolean;
  closedWithoutTrustedDate: boolean;
  isCurrentlyLate: boolean;
  wasClosedLate: boolean;
  /** Legacy alias: this now means closed within the fixed seven-day SLA. */
  isClosedWithinDueDate: boolean;
  latenessDays: number | null;
  /** Whole-day compatibility value; use resolutionDurationDays for averages. */
  resolutionDays: number | null;
  resolutionDurationDays: number | null;
  openAgeDays: number | null;
};

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function ceilDays(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / DAY_MS));
}

function resolveCreatedAt(complaint: ComplaintTimingSnapshot): Date | null {
  if (isValidDate(complaint.complaintDate)) return complaint.complaintDate;
  return isValidDate(complaint.receivedAt) ? complaint.receivedAt : null;
}

function resolveSlaState(
  complaint: ComplaintTimingSnapshot,
  createdAt: Date | null,
  slaDeadline: Date | null,
  now: Date
): ComplaintSlaState {
  if (!createdAt || !slaDeadline) return "INELIGIBLE";

  if (isOpenComplaintStatus(complaint.status)) {
    return now > slaDeadline ? "OPEN_LATE" : "OPEN_WITHIN_SLA";
  }

  if (!isClosedComplaintStatus(complaint.status)) {
    return "INELIGIBLE";
  }

  if (!isValidDate(complaint.closedAt) || complaint.closedAt < createdAt) {
    return "CLOSED_WITHOUT_TRUSTED_DATE";
  }

  return complaint.closedAt > slaDeadline
    ? "CLOSED_LATE"
    : "CLOSED_WITHIN_SLA";
}

export function buildComplaintTiming(
  complaint: ComplaintTimingSnapshot,
  now = new Date()
): ComplaintTimingInfo {
  const createdAt = resolveCreatedAt(complaint);
  const slaDeadline = createdAt
    ? new Date(createdAt.getTime() + COMPLAINT_SLA_DAYS * DAY_MS)
    : null;
  const slaState = resolveSlaState(complaint, createdAt, slaDeadline, now);
  const isCurrentlyLate = slaState === "OPEN_LATE";
  const wasClosedLate = slaState === "CLOSED_LATE";
  const isClosedWithinDueDate = slaState === "CLOSED_WITHIN_SLA";
  const isSlaEligible = [
    "OPEN_WITHIN_SLA",
    "OPEN_LATE",
    "CLOSED_WITHIN_SLA",
    "CLOSED_LATE",
  ].includes(slaState);
  const isCompliantWithinSla =
    slaState === "OPEN_WITHIN_SLA" || slaState === "CLOSED_WITHIN_SLA";
  const closedWithoutTrustedDate = slaState === "CLOSED_WITHOUT_TRUSTED_DATE";
  const lateReference = isValidDate(complaint.closedAt) ? complaint.closedAt : now;
  const latenessDays = slaDeadline && (isCurrentlyLate || wasClosedLate)
    ? ceilDays(lateReference.getTime() - slaDeadline.getTime())
    : null;
  const hasTrustedClosure =
    createdAt !== null &&
    isValidDate(complaint.closedAt) &&
    complaint.closedAt >= createdAt;
  const resolutionDurationDays = hasTrustedClosure
    ? (complaint.closedAt.getTime() - createdAt.getTime()) / DAY_MS
    : null;
  const resolutionDays = resolutionDurationDays === null
    ? null
    : ceilDays(resolutionDurationDays * DAY_MS);
  const openAgeDays = createdAt && isOpenComplaintStatus(complaint.status)
    ? ceilDays(now.getTime() - createdAt.getTime())
    : null;

  return {
    slaState,
    slaDeadline,
    isSlaEligible,
    isCompliantWithinSla,
    closedWithoutTrustedDate,
    isCurrentlyLate,
    wasClosedLate,
    isClosedWithinDueDate,
    latenessDays,
    resolutionDays,
    resolutionDurationDays,
    openAgeDays,
  };
}
