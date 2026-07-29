import { ComplaintStatus } from "@prisma/client";
import {
  isClosedComplaintStatus,
  isOpenComplaintStatus,
} from "./status";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ComplaintTimingSnapshot = {
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  dueDate: Date | null;
  closedAt: Date | null;
};

export type ComplaintTimingInfo = {
  isCurrentlyLate: boolean;
  wasClosedLate: boolean;
  isClosedWithinDueDate: boolean;
  latenessDays: number | null;
  resolutionDays: number | null;
  openAgeDays: number | null;
};

function ceilDays(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / DAY_MS));
}

export function buildComplaintTiming(
  complaint: ComplaintTimingSnapshot,
  now = new Date()
): ComplaintTimingInfo {
  const isCurrentlyLate = isOpenComplaintStatus(complaint.status)
    && complaint.dueDate !== null
    && complaint.dueDate < now;
  const wasClosedLate = isClosedComplaintStatus(complaint.status)
    && complaint.dueDate !== null
    && complaint.closedAt !== null
    && complaint.closedAt > complaint.dueDate;
  const isClosedWithinDueDate = isClosedComplaintStatus(complaint.status)
    && complaint.dueDate !== null
    && complaint.closedAt !== null
    && complaint.closedAt <= complaint.dueDate;
  const lateReference = complaint.closedAt ?? now;
  const latenessDays = complaint.dueDate && (isCurrentlyLate || wasClosedLate)
    ? ceilDays(lateReference.getTime() - complaint.dueDate.getTime())
    : null;
  const start = complaint.complaintDate ?? complaint.receivedAt;
  const resolutionDays = complaint.closedAt
    ? ceilDays(complaint.closedAt.getTime() - start.getTime())
    : null;
  const openAgeDays = isOpenComplaintStatus(complaint.status)
    ? ceilDays(now.getTime() - start.getTime())
    : null;

  return {
    isCurrentlyLate,
    wasClosedLate,
    isClosedWithinDueDate,
    latenessDays,
    resolutionDays,
    openAgeDays,
  };
}
